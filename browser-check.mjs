// Temp headless-browser render check against fixture data (NOT committed).
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { spawnSync } from 'node:child_process';

const publishedAt = new Date(Date.now() - 300_000).toISOString();
const fixtureFetch = async (request) => {
  const url = new URL(request.url);
  if (url.pathname.includes('/sitemap/')) {
    return new Response(`<urlset><url><loc>https://www.kan.org.il/content/kan-news/fixture</loc><news:news><news:title>לפי המועצה: 3 תוכניות אושרו</news:title><news:publication_date>${publishedAt}</news:publication_date></news:news></url></urlset>`);
  }
  if (url.pathname.includes('/kan-news/')) {
    return new Response(`<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: 'לפי המועצה: 3 תוכניות אושרו', description: 'ידיעה בדיונית.', articleSection: 'בארץ', datePublished: publishedAt })}</script></head></html>`);
  }
  const domain = url.hostname.includes('ynet') ? 'www.ynet.co.il' : url.pathname.includes('news-') ? 'www.n12.co.il' : 'www.mako.co.il';
  const id = [...url.pathname].reduce((s, c) => s * 31 + c.charCodeAt(0) >>> 0, 0).toString(16);
  return new Response(`<rss><channel><item><title>לפי המועצה: 3 תוכניות אושרו</title><link>https://${domain}/news/Article-${id}.htm</link><pubDate>${publishedAt}</pubDate><category>קהילה</category><description>ידיעה בדיונית.</description></item></channel></rss>`);
};

const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, port: 8799, log: new Log(LogLevel.ERROR),
  name: 'positivity-bias', scriptPath: 'dist/worker.js', modules: true, compatibilityDate: '2026-10-13',
  durableObjects: { NEWS: { className: 'NewsStore', useSQLite: true } },
  assets: { directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } },
  bindings: { REWRITES_PER_REFRESH: '0' },
  outboundService: fixtureFetch
}));
try {
  await mf.ready;
  const ns = await mf.getDurableObjectNamespace('NEWS');
  await ns.get(ns.idFromName('edition')).fetch('https://news.internal/refresh', { method: 'POST' });
  const run = (args) => spawnSync('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=8000', ...args], { encoding: 'utf8', timeout: 60_000 });
  const dom = run(['--dump-dom', 'http://127.0.0.1:8799/']);
  const html = dom.stdout || '';
  const check = (name, ok) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  check('html has dir="rtl" and lang="he"', /dir="rtl"/.test(html) && /lang="he"/.test(html));
  check('rendered a headline link', html.includes('לפי המועצה: 3 תוכניות אושרו'));
  check('rendered article rows', (html.match(/class="article"/g) || []).length >= 4);
  check('rendered source status cards', (html.match(/class="source-card"/g) || []).length === 4);
  check('rendered category option', html.includes('בארץ') && html.includes('קהילה'));
  check('shows original-title label for unrewritten', html.includes('כותרת מקור'));
  check('no console/page error markers', !/SyntaxError|ReferenceError|TypeError/.test(html));
  const shot = run(['--window-size=390,844', '--screenshot=/tmp/mobile.png', 'http://127.0.0.1:8799/']);
  console.log('mobile screenshot exit', shot.status, 'bytes', (spawnSync('stat', ['-c', '%s', '/tmp/mobile.png'], { encoding: 'utf8' }).stdout || '').trim());
  const desktop = run(['--window-size=1440,1000', '--screenshot=/tmp/desktop.png', 'http://127.0.0.1:8799/']);
  console.log('desktop screenshot exit', desktop.status, 'bytes', (spawnSync('stat', ['-c', '%s', '/tmp/desktop.png'], { encoding: 'utf8' }).stdout || '').trim());
} finally { await mf.dispose(); }
