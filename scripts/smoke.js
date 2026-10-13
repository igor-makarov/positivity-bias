// Local Worker-runtime checks with explicitly fictional fixtures; no external traffic.
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { createFixtureFetch } from './fixtures.js';

const fixture = createFixtureFetch();

const mfOptions = convertV4MiniflareOptions({
  cf: false,
  log: new Log(LogLevel.DEBUG),
  name: 'positivity-bias', scriptPath: 'dist/worker.js', modules: true, compatibilityDate: '2026-10-13',
  durableObjects: { NEWS: { className: 'NewsStore', useSQLite: true } },
  // Wrangler marks the Worker as the user worker; the raw Miniflare v4 options
  // must set has_user_worker explicitly or the assets router cannot dispatch /api/*.
  assets: { directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } },
  bindings: { REWRITES_PER_REFRESH: '8' },
  outboundService: fixture.fetch
});
mfOptions.handleUncaughtError = (error) => console.error('Fixture runtime error:', error);
const mf = new Miniflare(mfOptions);

try {
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace('NEWS');
  const store = namespace.get(namespace.idFromName('edition'));
  const refresh = await store.fetch('https://news.internal/refresh', { method: 'POST' });
  assert.equal(refresh.status, 200, await refresh.clone().text());
  assert.equal((await refresh.json()).state, 'complete');
  const result = await mf.dispatchFetch('https://fixture.local/api/news');
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.sources.length, 4);
  assert.ok(data.sources.every((source) => source.state === 'ok'));
  assert.deepEqual(new Set(data.articles.map((article) => article.sourceId)), new Set(['ynet', 'kan', 'n12', 'mako']));
  assert.ok(data.articles.every((article) => article.rewriteStatus === 'original'));
  assert.ok(data.articles.every((article) => article.originalHeadline.includes(':') && !('description' in article)));
  assert.ok(data.categories.includes('בארץ') && data.categories.includes('קהילה'));
  assert.equal(data.stale, false);
  assert.equal(data.rewriteStatus, 'not_configured');
  const requestsBeforeCooldown = fixture.count();
  assert.equal((await (await store.fetch('https://news.internal/refresh', { method: 'POST' })).json()).state, 'cooldown');
  assert.equal(fixture.count(), requestsBeforeCooldown);
  const filtered = await (await mf.dispatchFetch('https://fixture.local/api/news?source=kan&limit=1')).json();
  assert.equal(filtered.articles.length, 1); assert.equal(filtered.articles[0].sourceId, 'kan');
  const unmatched = await (await mf.dispatchFetch('https://fixture.local/api/news?q=nomatch')).json();
  assert.equal(unmatched.total, 0);
  const page = await mf.dispatchFetch('https://fixture.local/');
  assert.equal(page.status, 200); assert.match(await page.text(), /dir="rtl"/);
  assert.equal((await mf.dispatchFetch('https://fixture.local/style.css')).status, 200);
  assert.equal((await mf.dispatchFetch('https://fixture.local/api/refresh', { method: 'POST' })).status, 405);
  assert.equal((await mf.dispatchFetch('https://fixture.local/api/unknown')).status, 404);
  console.log(`Worker runtime passed: SQLite persistence, all four adapters, HTMLRewriter metadata, original fallback without an AI binding, categories, API filters, cooldown, and static assets (${fixture.count()} publisher requests).`);
} finally { await mf.dispose(); }
