// Integration regression: when many full-text articles are pending, the shared
// rewrite+verify batches must be split so that no verification request exceeds the
// validator's context window. A rewrite-only plan (Llama's 128k window) would pack
// ~20 articles (~80k tokens) into one request against clef-flash's 32k window.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ESTIMATED_CHARS_PER_TOKEN } from '../src/budget.js';
import { MODEL_CONTEXT_TOKENS } from '../src/policy.js';

const directory = await mkdtemp(join(process.cwd(), '.probe-'));
const outfile = join(directory, 'probe.js');
await build({ entryPoints: ['scripts/batch-probe.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile });

const COUNT = 9;
const now = Date.now();
// Each page body is long enough to be truncated at the 6000-char context cap, so the
// plan must split a 9-article pending set across multiple 32k-token requests.
const longBody = 'המועצה דנה בתכניות הפיתוח של האזור ובהשלכותיהן על התושבים. '.repeat(200);

const fixture = async (request) => {
  const match = /^\/page\/(\d+)$/.exec(new URL(request.url).pathname);
  if (!match) return new Response('not found', { status: 404 });
  const n = Number(match[1]);
  const html = `<!doctype html><html lang="he"><head>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: `עדכון כללי ${n}`, articleSection: 'בארץ' })}</script>
  </head><body><nav>ניווט באתר</nav><article><h1>עדכון כללי</h1><p>${longBody}</p></article><div class="related"><p>כתבות קשורות</p></div></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html' } });
};

const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, name: 'positivity-bias', scriptPath: outfile, modules: true, compatibilityDate: '2026-10-13',
  durableObjects: { NEWS: { className: 'BatchStore', useSQLite: true } },
  assets: { directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } },
  outboundService: fixture
}));

try {
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace('NEWS');
  const store = namespace.get(namespace.idFromName('edition'));
  const articles = Array.from({ length: COUNT }, (_, index) => ({
    id: `https://www.ynet.co.il/page/${index + 1}`, url: `https://www.ynet.co.il/page/${index + 1}`,
    sourceId: 'ynet', sourceName: 'ynet', originalHeadline: `עדכון כללי ${index + 1}`, headline: `עדכון כללי ${index + 1}`,
    description: 'תיאור', categories: ['בארץ'], publishedAt: new Date(now - 60_000).toISOString(), rewriteStatus: 'original'
  }));
  const seeded = { articles, updatedAt: new Date(now - 60_000).toISOString(),
    lastAttemptAt: new Date(now - 2 * 3_600_000).toISOString(), policyFingerprint: null, rewriteStatus: 'not_configured', sources: [] };
  const run = await (await store.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: seeded,
    env: { REWRITE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', VALIDATOR_MODEL: '@cf/cloudflare/clef-flash',
      DAILY_NEURON_BUDGET: '6000', CONTEXT_CHARS: '6000', MAX_CONTEXT_FETCHES: '20' } }) })).json();
  assert.equal(run.result.state, 'complete');
  assert.equal(run.result.rewriteStatus, 'ok');
  assert.equal(run.result.articles, COUNT);
  // The shared batch is split by the smaller (validator) window, not the rewrite model's.
  assert.ok(run.calls.rewrite > 1, `expected split batches, got ${run.calls.rewrite}`);
  assert.equal(run.calls.verify, run.calls.rewrite);
  const window = MODEL_CONTEXT_TOKENS['@cf/cloudflare/clef-flash'];
  const verifyTokens = Math.ceil(run.calls.maxVerifyChars / ESTIMATED_CHARS_PER_TOKEN);
  assert.ok(verifyTokens <= window, `verification request ~${verifyTokens} tokens exceeds validator window ${window}`);
  assert.ok(run.calls.maxRewriteChars <= run.calls.maxVerifyChars + 200, 'rewrite request is not larger than verification');

  const api = await (await mf.dispatchFetch('https://fixture.local/api/news?limit=120')).json();
  assert.equal(api.total, COUNT);
  assert.ok(api.articles.every((article) => article.rewriteStatus === 'rewritten'));
  assert.ok(api.articles.every((article) => !('context' in article) && !('verification' in article)));
  const day = new Date().toISOString().slice(0, 10);
  const usage = await (await store.fetch(`https://news.internal/usage?day=${day}`)).json();
  assert.ok(usage.used > 0 && usage.used <= 6000, `unexpected usage ${usage.used}`);

  // Budget-aware sizing: when only part of a planned batch fits the remaining daily
  // budget, the request must be REDUCED rather than deferring every article. A fresh
  // Durable Object starts with a zero ledger, so the exact fit is deterministic.
  const partialStore = namespace.get(namespace.idFromName('partial'));
  const partialSeed = { articles, updatedAt: new Date(now - 60_000).toISOString(),
    lastAttemptAt: new Date(now - 2 * 3_600_000).toISOString(), policyFingerprint: null, rewriteStatus: 'not_configured', sources: [] };
  const partial = await (await partialStore.fetch('https://news.internal/run', { method: 'POST', body: JSON.stringify({ snapshot: partialSeed,
    env: { REWRITE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', VALIDATOR_MODEL: '@cf/cloudflare/clef-flash',
      DAILY_NEURON_BUDGET: '60', CONTEXT_CHARS: '6000', MAX_CONTEXT_FETCHES: '20' } }) })).json();
  assert.equal(partial.result.state, 'complete');
  // The 60-neuron budget cannot cover all nine articles at once, but the first planned
  // batch is REDUCED to what fits instead of deferring every article in it. Reporting
  // provider usage lets the ledger free headroom, so a small prefix still gets through.
  assert.ok(partial.calls.rewrite >= 1, `expected a reduced batch, got ${partial.calls.rewrite}`);
  assert.ok(partial.calls.rewrite < COUNT, `all ${COUNT} articles were processed; budget reduction not exercised`);
  assert.equal(partial.calls.verify, partial.calls.rewrite);
  const partialSnapshot = await (await partialStore.fetch('https://news.internal/snapshot')).json();
  const rewritten = partialSnapshot.articles.filter((article) => article.rewriteStatus === 'rewritten').length;
  assert.equal(rewritten, partial.calls.rewrite);
  assert.equal(partialSnapshot.articles.filter((article) => article.rewriteStatus === 'original').length, COUNT - rewritten);
  const partialUsage = await (await partialStore.fetch('https://news.internal/usage')).json();
  assert.ok(partialUsage.used > 0 && partialUsage.used <= 60, `partial usage overspent: ${partialUsage.used}`);

  console.log(`Batch passed: ${COUNT} full-text articles split into ${run.calls.rewrite} requests, each verification within the ${window}-token validator window; usage ${Math.round(usage.used)} neurons; a 60-neuron budget processes a reduced prefix (${partial.calls.rewrite}) instead of deferring all nine.`);
} finally { await mf.dispose().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {}); }
