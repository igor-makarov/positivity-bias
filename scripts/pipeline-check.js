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
  console.log('Pipeline passed: full-text context, bounded rewrite+verify, independent acceptance/rejection, usage ledger, budget deferral, and stale-rewrite retirement with reprocessing.');
} finally { await mf.dispose().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {}); }
