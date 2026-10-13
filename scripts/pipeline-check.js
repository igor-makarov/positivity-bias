// End-to-end orchestration check with a deterministic mock model. It exercises the
// real refresh -> full-text context -> rewrite -> Clef verification -> budget flow,
// plus independent acceptance, rejection fallback and budget deferral.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const directory = await mkdtemp(join(process.cwd(), '.probe-'));
const outfile = join(directory, 'probe.js');
await build({ entryPoints: ['scripts/pipeline-probe.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile });

const publishedAt = new Date(Date.now() - 300_000);
const rfc = publishedAt.toUTCString();
const page = (headline, body) => `<!doctype html><html lang="he"><head>
  <script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline, articleSection: 'בארץ', datePublished: publishedAt.toISOString() })}</script>
</head><body><nav>ניווט באתר</nav><article><h1>${headline}</h1><p>${body}</p></article><div class="related"><p>כתבות קשורות</p></div></body></html>`;

const fixture = async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/news/article/1') return new Response(page('לפי המועצה: 3 תוכניות אושרו', 'המועצה המקומית אישרה שלוש תוכניות חדשות לפיתוח האזור. התוכניות כוללות הרחבת מבני הציבור, שיפור הכבישים ופיתוח שטחים פתוחים. האישור ניתן לאחר דיון ציבורי שבו עלו גם התנגדויות.'), { headers: { 'content-type': 'text/html' } });
  if (url.pathname === '/news/article/2') return new Response(page('האוכלוסייה בישראל רואה את הצפון כצימר לסופ״ש אבל לא כמקום לגור בו', 'ראש עיריית כרמיאל וראש עיריית דימונה אמרו בכנס כי הצפון נתפס כצימר לסופ״ש ולא כמקום לגור בו. לדבריהם, המבקרים מגיעים לחופשה קצרה אך אינם רואים באזור בית. ראשי הערים בפריפריה קראו לחזק את האזורים האלה.'), { headers: { 'content-type': 'text/html' } });
  const item = (title, id) => `<item><title>${title}</title><link>https://www.ynet.co.il/news/article/${id}</link><pubDate>${rfc}</pubDate><category>בארץ</category><description>תיאור</description></item>`;
  return new Response(`<rss version="2.0"><channel><title>חדשות</title>${item('לפי המועצה: 3 תוכניות אושרו', 1)}${item('האוכלוסייה בישראל רואה את הצפון כצימר לסופ״ש אבל לא כמקום לגור בו', 2)}</channel></rss>`);
};

const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, name: 'positivity-bias', scriptPath: outfile, modules: true, compatibilityDate: '2026-10-13',
  durableObjects: { NEWS: { className: 'PipelineStore', useSQLite: true } },
  assets: { directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } },
  outboundService: fixture
}));

try {
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace('NEWS');
  const store = namespace.get(namespace.idFromName('edition'));
  const seeded = { articles: [], updatedAt: null, lastAttemptAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    policyFingerprint: null, rewriteStatus: 'not_configured', sources: [] };
  const run = await (await store.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: seeded,
    env: { REWRITE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', VALIDATOR_MODEL: '@cf/cloudflare/clef-flash',
      DAILY_NEURON_BUDGET: '6000', CONTEXT_CHARS: '6000', MAX_CONTEXT_FETCHES: '4' } }) })).json();
  assert.equal(run.result.state, 'complete');
  assert.equal(run.result.rewriteStatus, 'ok');
  assert.equal(run.calls.rewrite, 1); // one bounded batch
  assert.equal(run.calls.verify, 1); // one bounded verification call

  const api = await (await mf.dispatchFetch('https://fixture.local/api/news')).json();
  const byOriginal = new Map(api.articles.map((article) => [article.originalHeadline, article]));
  const accepted = byOriginal.get('לפי המועצה: 3 תוכניות אושרו');
  assert.equal(accepted.headline, 'לפי המועצה אושרו 3 תוכניות');
  assert.equal(accepted.rewriteStatus, 'rewritten');
  assert.equal(accepted.rewriteFingerprint, undefined); // fingerprint is internal
  const rejected = byOriginal.get('האוכלוסייה בישראל רואה את הצפון כצימר לסופ״ש אבל לא כמקום לגור בו');
  assert.equal(rejected.headline, rejected.originalHeadline); // failed verification keeps the original
  assert.equal(rejected.rewriteStatus, 'original');

  const day = new Date().toISOString().slice(0, 10);
  const usage = await (await store.fetch(`https://news.internal/usage?day=${day}`)).json();
  assert.ok(usage.used > 0 && usage.used <= 6000, `unexpected usage ${usage.used}`);

  // The configured default (no REWRITE_MODEL env) is the available low-cost Qwen3, and
  // its chat-shaped `choices[].message.content` response (with a thinking channel) is
  // accepted end-to-end and verified by clef. This locks in the default-model switch.
  const defaultStore = namespace.get(namespace.idFromName('default-model'));
  const defaultSeed = { articles: [], updatedAt: null, lastAttemptAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    policyFingerprint: null, rewriteStatus: 'not_configured', sources: [] };
  const defaultRun = await (await defaultStore.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: defaultSeed,
    env: { VALIDATOR_MODEL: '@cf/cloudflare/clef-flash', DAILY_NEURON_BUDGET: '6000', CONTEXT_CHARS: '6000', MAX_CONTEXT_FETCHES: '4' } }) })).json();
  assert.equal(defaultRun.result.rewriteStatus, 'ok');
  assert.equal(defaultRun.calls.rewrite, 1);
  assert.deepEqual(defaultRun.calls.models, ['@cf/qwen/qwen3-30b-a3b-fp8']); // the code default, not the removed Llama slug
  const defaultSnapshot = await (await defaultStore.fetch('https://news.internal/snapshot')).json();
  const defaultAccepted = defaultSnapshot.articles.find((article) => article.originalHeadline === 'לפי המועצה: 3 תוכניות אושרו');
  assert.equal(defaultAccepted.rewriteStatus, 'rewritten');
  assert.equal(defaultAccepted.headline, 'לפי המועצה אושרו 3 תוכניות');

  // Cached decisions: a second refresh re-infers neither the accepted nor the rejected article.
  const cachedSeed = await (await store.fetch('https://news.internal/snapshot')).json();
  cachedSeed.lastAttemptAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const cached = await (await store.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: cachedSeed,
    env: { REWRITE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', VALIDATOR_MODEL: '@cf/cloudflare/clef-flash',
      DAILY_NEURON_BUDGET: '6000', CONTEXT_CHARS: '6000', MAX_CONTEXT_FETCHES: '4' } }) })).json();
  assert.equal(cached.calls.rewrite, 0);
  assert.equal(cached.calls.verify, 0);

  // Budget deferral: no budget means no model calls and originals kept.
  const deferredSeed = { articles: [], updatedAt: null, lastAttemptAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    policyFingerprint: null, rewriteStatus: 'not_configured', sources: [] };
  const deferred = await (await store.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: deferredSeed,
    env: { REWRITE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', VALIDATOR_MODEL: '@cf/cloudflare/clef-flash',
      DAILY_NEURON_BUDGET: '0', CONTEXT_CHARS: '6000', MAX_CONTEXT_FETCHES: '4' } }) })).json();
  assert.equal(deferred.result.rewriteStatus, 'budget_deferred');
  assert.equal(deferred.calls.rewrite, 0);
  assert.equal(deferred.calls.verify, 0);

  // An unparseable model response keeps the originals AND is reported honestly,
  // instead of a healthy `ok` that would hide a silently failing rewrite pipeline.
  const invalidStore = namespace.get(namespace.idFromName('invalid'));
  const invalidSeed = { articles: [], updatedAt: null, lastAttemptAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    policyFingerprint: null, rewriteStatus: 'not_configured', sources: [] };
  const invalid = await (await invalidStore.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: invalidSeed,
    env: { REWRITE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', VALIDATOR_MODEL: '@cf/cloudflare/clef-flash',
      DAILY_NEURON_BUDGET: '6000', CONTEXT_CHARS: '6000', MAX_CONTEXT_FETCHES: '4', MOCK_REWRITE: 'invalid' } }) })).json();
  assert.equal(invalid.result.state, 'complete');
  assert.equal(invalid.result.rewriteStatus, 'invalid_response');
  assert.ok(invalid.calls.rewrite > 0);
  assert.equal(invalid.calls.verify, 0); // nothing to verify without a parsed candidate
  const invalidServed = await (await invalidStore.fetch('https://news.internal/snapshot')).json();
  assert.ok(invalidServed.articles.length > 0);
  assert.ok(invalidServed.articles.every((article) => article.headline === article.originalHeadline)); // originals preserved
  assert.ok(invalidServed.articles.every((article) => article.rewriteStatus !== 'rewritten')); // and not cached as trusted

  // Retirement + reprocessing: a stale wrong cached headline must never be served, and
  // the same article must be reprocessed under the active policy within the same daily
  // budget. The original is restored first, then a fresh, correct rewrite replaces it.
  const staleWrong = 'כותרת שגויה: הניסוי במל״ט נכשל';
  const staleSeed = {
    articles: [{ id: 'https://ynet.co.il/news/article/1', url: 'https://www.ynet.co.il/news/article/1',
      sourceId: 'ynet', sourceName: 'ynet', originalHeadline: 'לפי המועצה: 3 תוכניות אושרו',
      headline: staleWrong, rewriteStatus: 'rewritten', rewriteFingerprint: 'old-policy',
      categories: ['בארץ'], description: 'תיאור', publishedAt: publishedAt.toISOString() }],
    updatedAt: null, lastAttemptAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    policyFingerprint: 'old-policy', rewriteStatus: 'ok', sources: [] };
  const reprocessed = await (await store.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: staleSeed,
    env: { REWRITE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', VALIDATOR_MODEL: '@cf/cloudflare/clef-flash',
      DAILY_NEURON_BUDGET: '6000', CONTEXT_CHARS: '6000', MAX_CONTEXT_FETCHES: '4' } }) })).json();
  assert.equal(reprocessed.result.state, 'complete');
  assert.ok(reprocessed.calls.rewrite > 0); // the retired article was reprocessed, not skipped
  const served = await (await mf.dispatchFetch('https://fixture.local/api/news')).json();
  assert.ok(!served.articles.some((article) => article.headline === staleWrong));
  const fixed = served.articles.find((article) => article.id === 'https://ynet.co.il/news/article/1');
  assert.ok(fixed, 'reprocessed article missing');
  assert.equal(fixed.rewriteStatus, 'rewritten');
  assert.equal(fixed.headline, 'לפי המועצה אושרו 3 תוכניות');

  // A model omission is not a source-grounded rejection. When the model answers only
  // one of two articles, the omitted article must keep its preserved original and be
  // retried on the next refresh, not be cached as if clef had rejected it and skipped
  // forever.
  const partialStore = namespace.get(namespace.idFromName('partial'));
  const partialEnv = { REWRITE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', VALIDATOR_MODEL: '@cf/cloudflare/clef-flash',
    DAILY_NEURON_BUDGET: '6000', CONTEXT_CHARS: '6000', MAX_CONTEXT_FETCHES: '4', MOCK_REWRITE: 'partial' };
  const partialSeed = { articles: [], updatedAt: null, lastAttemptAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    policyFingerprint: null, rewriteStatus: 'not_configured', sources: [] };
  const partial = await (await partialStore.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: partialSeed, env: partialEnv }) })).json();
  assert.equal(partial.result.state, 'complete');
  const afterPartial = await (await partialStore.fetch('https://news.internal/snapshot')).json();
  const omitted = afterPartial.articles.find((article) => article.id.endsWith('/2'));
  assert.ok(omitted, 'omitted article missing');
  assert.equal(omitted.headline, omitted.originalHeadline);
  assert.equal(omitted.rewriteStatus, 'original'); // an omission is never cached as a rejection
  const answered = afterPartial.articles.find((article) => article.id.endsWith('/1'));
  assert.equal(answered.rewriteStatus, 'rewritten'); // the answered article is still processed
  const retriedSeed = { ...afterPartial, lastAttemptAt: new Date(Date.now() - 2 * 3_600_000).toISOString() };
  const retried = await (await partialStore.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: retriedSeed, env: partialEnv }) })).json();
  assert.ok(retried.calls.rewrite > 0, 'an omitted article must be retried, not cached as rejected');

  // A parseable response that answers none of the requested articles is a failed
  // rewrite, not a healthy `ok`: it must be reported honestly and keep (and retry)
  // the preserved originals rather than caching them as rejections.
  const emptyStore = namespace.get(namespace.idFromName('empty'));
  const emptyEnv = { ...partialEnv, MOCK_REWRITE: 'empty' };
  const emptySeed = { articles: [], updatedAt: null, lastAttemptAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    policyFingerprint: null, rewriteStatus: 'not_configured', sources: [] };
  const empty = await (await emptyStore.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: emptySeed, env: emptyEnv }) })).json();
  assert.equal(empty.result.state, 'complete');
  assert.equal(empty.result.rewriteStatus, 'invalid_response');
  const emptyServed = await (await emptyStore.fetch('https://news.internal/snapshot')).json();
  assert.ok(emptyServed.articles.length > 0);
  assert.ok(emptyServed.articles.every((article) => article.headline === article.originalHeadline && article.rewriteStatus === 'original'));

  // A validator that answers NONE of the submitted candidates is a failed verification,
  // not a healthy `ok`: the refresh must say so, keep the preserved originals and retry
  // later instead of caching them as if clef had rejected them.
  const badValidatorStore = namespace.get(namespace.idFromName('bad-validator'));
  const badValidatorEnv = { REWRITE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', VALIDATOR_MODEL: '@cf/cloudflare/clef-flash',
    DAILY_NEURON_BUDGET: '6000', CONTEXT_CHARS: '6000', MAX_CONTEXT_FETCHES: '4', MOCK_VALIDATOR: 'empty' };
  const badValidatorSeed = { articles: [], updatedAt: null, lastAttemptAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    policyFingerprint: null, rewriteStatus: 'not_configured', sources: [] };
  const badValidator = await (await badValidatorStore.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: badValidatorSeed, env: badValidatorEnv }) })).json();
  assert.equal(badValidator.result.state, 'complete');
  assert.equal(badValidator.result.rewriteStatus, 'invalid_response');
  assert.ok(badValidator.calls.rewrite > 0);
  assert.ok(badValidator.calls.verify > 0); // the verification was attempted, it just decided nothing
  const badServed = await (await badValidatorStore.fetch('https://news.internal/snapshot')).json();
  assert.ok(badServed.articles.length > 0);
  assert.ok(badServed.articles.every((article) => article.headline === article.originalHeadline && article.rewriteStatus === 'original'));
  const badRetriedSeed = { ...badServed, lastAttemptAt: new Date(Date.now() - 2 * 3_600_000).toISOString() };
  const badRetried = await (await badValidatorStore.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: badRetriedSeed, env: badValidatorEnv }) })).json();
  assert.ok(badRetried.calls.rewrite > 0, 'an undecided verification must be retried, not cached');
  console.log('Pipeline passed: full-text context, bounded rewrite+verify, independent acceptance/rejection, usage ledger, budget deferral, model-omission retry, honest empty-response status, failed-verification status, and stale-rewrite retirement with reprocessing.');
} finally { await mf.dispose().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {}); }
