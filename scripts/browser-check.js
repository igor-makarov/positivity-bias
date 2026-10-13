// Headless-browser render check against fictional fixtures and the local build.
// Requires a prior `npm run build` and a Chromium/Chrome binary on PATH.
// No external traffic and no live data; fixtures only exist under Miniflare.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { createFixtureFetch } from './fixtures.js';

const browser = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
  .find((name) => spawnSync('which', [name]).status === 0);
if (!browser) { console.error('No Chromium/Chrome binary found on PATH; browser check skipped. Install one to run this check.'); process.exit(2); }
if (!existsSync('dist/worker.js')) { console.error('dist/worker.js is missing; run `npm run build` before `npm run test:browser`.'); process.exit(2); }

const port = await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
});
const fixture = createFixtureFetch();
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, port, log: new Log(LogLevel.ERROR), host: '127.0.0.1',
  name: 'positivity-bias', scriptPath: 'dist/worker.js', modules: true, compatibilityDate: '2026-10-13',
  durableObjects: { NEWS: { className: 'NewsStore', useSQLite: true } },
  assets: { directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } },
  outboundService: fixture.fetch
}));
try {
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace('NEWS');
  await namespace.get(namespace.idFromName('edition')).fetch('https://news.internal/refresh', { method: 'POST' });
  const render = (args) => spawnSync(browser, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=8000', ...args], { encoding: 'utf8', timeout: 90_000 });
  const dom = render(['--dump-dom', `http://127.0.0.1:${port}/`]);
  assert.equal(dom.status, 0, dom.stderr);
  const html = dom.stdout || '';
  assert.match(html, /dir="rtl"/);
  assert.match(html, /lang="he"/);
  assert.ok((html.match(/class="article"/g) || []).length >= 4, 'no rendered article rows');
  assert.ok((html.match(/class="source-card"/g) || []).length === 4, 'expected four source status cards');
  assert.ok(html.includes('לפי המועצה: 3 תוכניות אושרו'), 'fixture headline not rendered');
  assert.ok(html.includes('כותרת מקור'), 'original-title label missing');
  assert.doesNotMatch(html, /SyntaxError|ReferenceError|TypeError/);
  for (const [width, height, file] of [[390, 844, 'mobile'], [1440, 1000, 'desktop']]) {
    const shot = render([`--window-size=${width},${height}`, `--screenshot=${join(tmpdir(), `positivity-bias-${file}.png`)}`, `http://127.0.0.1:${port}/`]);
    assert.equal(shot.status, 0, shot.stderr);
  }
  console.log(`Browser render passed: RTL Hebrew page, rendered article rows and source cards, original-title label; screenshots in ${tmpdir()}.`);
} finally { await mf.dispose(); }
