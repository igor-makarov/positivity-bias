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
  console.log('refresh status', refresh.status, await refresh.clone().text());
  const result = await mf.dispatchFetch('https://fixture.local/api/news');
  console.log('news status', result.status);
  console.log('news body', await result.text());
} catch (e) { console.error('CAUGHT', e); } finally { await mf.dispose(); }
