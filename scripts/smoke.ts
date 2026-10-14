import type { FixtureResponse } from './fixture-types.ts';
// Local Worker-runtime checks with explicitly fictional fixtures; no external traffic.
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { createFixtureFetch } from './fixtures.ts';
import { requireFreshBundle } from './bundle-guard.ts';

// Never validate a stale or missing bundle as if it were the current source.
requireFreshBundle('node scripts/smoke.ts');

const fixture = createFixtureFetch();

const mfOptions = convertV4MiniflareOptions({
  cf: false,
  log: new Log(LogLevel.DEBUG),
  name: 'positivity-bias', scriptPath: 'dist/worker.js', modules: true, compatibilityDate: '2026-10-13',
  durableObjects: { NEWS: { className: 'NewsStore', useSQLite: true } },
  // Wrangler marks the Worker as the user worker; the raw Miniflare v4 options
  // must set has_user_worker explicitly or the assets router cannot dispatch /api/*.
  assets: { directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } },
  bindings: {},
  outboundService: fixture.fetch
});
mfOptions.handleUncaughtError = (error: unknown) => console.error('Fixture runtime error:', error);
const mf = new Miniflare(mfOptions);

try {
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace('NEWS');
  const store = namespace.get(namespace.idFromName('edition'));
  const refresh = await store.fetch('https://news.internal/refresh', { method: 'POST' });
  assert.equal(refresh.status, 200, await refresh.clone().text());
  assert.equal(((await refresh.json() as FixtureResponse)).state, 'complete');
  const result = await mf.dispatchFetch('https://fixture.local/api/news');
  assert.equal(result.status, 200);
  const data = (await result.json() as FixtureResponse);
  assert.equal(data.refreshing, false, 'no AI binding must not create idle continuation alarms');
  const fresh = await (await mf.dispatchFetch('https://fixture.local/api/news?new=1&limit=120')).json() as FixtureResponse;
  assert.equal(fresh.total, data.total);
  assert.ok(fresh.newTitleCoverage);
  assert.equal(fresh.newTitleCoverage.total, data.total);
  assert.ok(fresh.articles.every(article => !('firstSeenAt' in article)));
  assert.equal(data.sources.length, 4);
  assert.ok(data.sources.every((source) => source.state === 'ok'));
  assert.deepEqual(new Set(data.articles.map((article) => article.sourceId)), new Set(['ynet', 'kan', 'n12', 'mako']));
  assert.ok(data.articles.every((article) => article.rewriteStatus === 'original'));
  assert.ok(data.articles.every((article) => article.originalHeadline.includes(':') && !('description' in article)));
  assert.ok(data.categories.includes('בארץ') && data.categories.includes('קהילה'));
  assert.equal(data.stale, false);
  assert.equal(data.rewriteStatus, 'not_configured');
  const requestsBeforeCooldown = fixture.count();
  assert.equal(((await (await store.fetch('https://news.internal/refresh', { method: 'POST' })).json() as FixtureResponse)).state, 'cooldown');
  assert.equal(fixture.count(), requestsBeforeCooldown);
  const filtered = (await (await mf.dispatchFetch('https://fixture.local/api/news?source=kan&limit=1')).json() as FixtureResponse);
  assert.equal(filtered.articles.length, 1); assert.equal(filtered.articles[0].sourceId, 'kan');
  const unmatched = (await (await mf.dispatchFetch('https://fixture.local/api/news?q=nomatch')).json() as FixtureResponse);
  assert.equal(unmatched.total, 0);
  const byCategory = (await (await mf.dispatchFetch(`https://fixture.local/api/news?category=${encodeURIComponent('קהילה')}&limit=120`)).json() as FixtureResponse);
  assert.ok(byCategory.articles.length > 0);
  assert.ok(byCategory.articles.every((article) => article.categories.includes('קהילה')));
  const latest = (await (await mf.dispatchFetch('https://fixture.local/api/news?order=latest&limit=120')).json() as FixtureResponse);
  const times = latest.articles.map((article) => article.publishedAt);
  assert.deepEqual(times, [...times].sort((a, b) => b.localeCompare(a))); // chronological order is exact
  const firstPage = (await (await mf.dispatchFetch('https://fixture.local/api/news?limit=5')).json() as FixtureResponse);
  const secondPage = (await (await mf.dispatchFetch('https://fixture.local/api/news?limit=5&offset=5')).json() as FixtureResponse);
  assert.equal(firstPage.articles.length, 5);
  assert.equal(firstPage.total, secondPage.total);
  assert.ok(firstPage.total > 5);
  const firstIds = new Set(firstPage.articles.map((article) => article.id));
  assert.ok(secondPage.articles.every((article) => !firstIds.has(article.id)), 'pagination pages overlap');
  const status = (await (await mf.dispatchFetch('https://fixture.local/api/status')).json() as FixtureResponse);
  assert.equal(status.stale, false);
  assert.equal(status.sources.length, 4);
  assert.ok(!('articles' in status) && !('categories' in status)); // status stays summary-only
  const page = await mf.dispatchFetch('https://fixture.local/');
  assert.equal(page.status, 200); assert.match(await page.text(), /dir="rtl"/);
  assert.equal((await mf.dispatchFetch('https://fixture.local/style.css')).status, 200);
  assert.equal((await mf.dispatchFetch('https://fixture.local/api/refresh', { method: 'POST' })).status, 405);
  assert.equal((await mf.dispatchFetch('https://fixture.local/api/unknown')).status, 404);
  console.log(`Worker runtime passed: SQLite persistence, all four adapters, HTMLRewriter metadata, original fallback without an AI binding, categories, API filters/order/pagination/status, cooldown, and static assets (${fixture.count()} publisher requests).`);
} finally { await mf.dispose(); }
