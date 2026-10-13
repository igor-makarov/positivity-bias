// Local Worker-runtime checks with explicitly fictional fixtures; no external traffic.
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';

const publishedAt = new Date(Date.now() - 300_000).toISOString();
let publisherRequests = 0;
const fixtureFetch = async (request) => {
  const url = new URL(request.url);
  publisherRequests++;
  if (url.pathname.includes('/sitemap/')) {
    return new Response(`<urlset><url><loc>https://www.kan.org.il/content/kan-news/fixture</loc><news:news><news:title>לפי המועצה: 3 תוכניות אושרו</news:title><news:publication_date>${publishedAt}</news:publication_date></news:news></url></urlset>`);
  }
  if (url.pathname.includes('/kan-news/')) {
    return new Response(`<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: 'לפי המועצה: 3 תוכניות אושרו', description: 'ידיעה בדיונית לבדיקת תוכנה בלבד.', articleSection: 'בארץ', datePublished: publishedAt })}</script></head></html>`);
  }
  const domain = url.hostname.includes('ynet') ? 'www.ynet.co.il' : url.pathname.includes('news-') ? 'www.n12.co.il' : 'www.mako.co.il';
  const id = [...url.pathname].reduce((sum, char) => sum * 31 + char.charCodeAt(0) >>> 0, 0).toString(16);
  return new Response(`<rss><channel><item><title>לפי המועצה: 3 תוכניות אושרו</title><link>https://${domain}/news/Article-${id}.htm</link><pubDate>${publishedAt}</pubDate><category>קהילה</category><description>ידיעה בדיונית לבדיקת תוכנה בלבד.</description></item></channel></rss>`);
};

const mfOptions = convertV4MiniflareOptions({
  cf: false,
  log: new Log(LogLevel.DEBUG),
  name: 'positivity-bias', scriptPath: 'dist/worker.js', modules: true, compatibilityDate: '2026-10-13',
  durableObjects: { NEWS: { className: 'NewsStore', useSQLite: true } },
  assets: { directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'] },
  bindings: { REWRITES_PER_REFRESH: '8' },
  outboundService: fixtureFetch
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
  const requestsBeforeCooldown = publisherRequests;
  assert.equal((await (await store.fetch('https://news.internal/refresh', { method: 'POST' })).json()).state, 'cooldown');
  assert.equal(publisherRequests, requestsBeforeCooldown);
  const filtered = await (await mf.dispatchFetch('https://fixture.local/api/news?source=kan&limit=1')).json();
  assert.equal(filtered.articles.length, 1); assert.equal(filtered.articles[0].sourceId, 'kan');
  const unmatched = await (await mf.dispatchFetch('https://fixture.local/api/news?q=nomatch')).json();
  assert.equal(unmatched.total, 0);
  const page = await mf.dispatchFetch('https://fixture.local/');
  assert.equal(page.status, 200); assert.match(await page.text(), /dir="rtl"/);
  assert.equal((await mf.dispatchFetch('https://fixture.local/style.css')).status, 200);
  assert.equal((await mf.dispatchFetch('https://fixture.local/api/refresh', { method: 'POST' })).status, 405);
  assert.equal((await mf.dispatchFetch('https://fixture.local/api/unknown')).status, 404);
  console.log(`Worker runtime passed: SQLite persistence, all four adapters, HTMLRewriter metadata, original fallback without an AI binding, categories, API filters, cooldown, and static assets (${publisherRequests} publisher requests).`);
} finally { await mf.dispose(); }
