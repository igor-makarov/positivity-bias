import type { FixtureResponse } from './fixture-types.ts';
interface Focus { tag: string; id: string; classes: string[] }
interface Target { type: string; webSocketDebuggerUrl: string }
interface CDPResult { data?: string; result?: { value?: unknown }; exceptionDetails?: { text: string; exception?: {description?: string} } }
interface CDPMessage { id?: number; error?: {message: string}; result: CDPResult }
// Interactive QA against the local build with fictional fixtures only: real keyboard
// traversal (Chrome DevTools Protocol Tab events), source/category filtering, the
// chronological order toggle, explicit load-more pagination and the rendered error
// state. Requires a prior `npm run build` and a Chromium/Chrome binary on PATH.
// No external traffic; fixtures exist only inside Miniflare.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { requireFreshBundle } from './bundle-guard.ts';

const browser = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
  .find((name) => spawnSync('which', [name]).status === 0);
if (!browser) { console.error('No Chromium/Chrome binary found on PATH; interaction check skipped. Install one to run this check.'); process.exit(2); }
requireFreshBundle('npm run test:interaction');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise<number>((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); });
});

// Enough distinct, fictional articles that the explicit load-more control is shown.
let counter = 0;
const base = Date.now() - 300_000;
const fixture = async (request: Request) => {
  const url = new URL(request.url);
  if (url.pathname.includes('/sitemap/')) {
    const entries = Array.from({ length: 4 }, () => {
      const n = ++counter;
      return `<url><loc>https://www.kan.org.il/content/kan-news/fixture-${n}</loc><news:news><news:title>כאן: עדכון ${n}</news:title><news:publication_date>${new Date(base - n * 60_000).toISOString()}</news:publication_date></news:news></url>`;
    });
    return new Response(`<urlset>${entries.join('')}</urlset>`);
  }
  if (url.pathname.includes('/kan-news/')) {
    const id = url.pathname.split('/').pop();
    return new Response(`<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: `כאן: עדכון ${id}`, description: 'ידיעה בדיונית.', articleSection: 'בארץ', datePublished: new Date(base).toISOString() })}</script></head><body><article><h1>כאן: עדכון</h1><p>תוכן בדיוני לבדיקה.</p></article></body></html>`);
  }
  const domain = url.hostname.includes('ynet') ? 'www.ynet.co.il' : url.hostname.includes('mako') ? 'www.mako.co.il' : 'www.n12.co.il';
  const category = domain.includes('ynet') ? 'חדשות' : domain.includes('mako') ? 'תרבות' : 'בעולם';
  const items = Array.from({ length: 8 }, () => {
    const n = ++counter;
    const publishedAt = new Date(base - n * 60_000).toISOString();
    return `<item><title>${category} ${n}: עדכון כללי</title><link>https://${domain}/news/Article-${n}.htm</link><pubDate>${new Date(publishedAt).toUTCString()}</pubDate><category>${category}</category><description>ידיעה בדיונית לבדיקת תוכנה בלבד.</description></item>`;
  });
  return new Response(`<rss version="2.0"><channel><title>חדשות</title>${items.join('')}</channel></rss>`);
};

const port = await freePort();
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, port, log: new Log(LogLevel.ERROR), host: '127.0.0.1',
  name: 'positivity-bias', scriptPath: 'dist/worker.js', modules: true, compatibilityDate: '2026-10-13',
  durableObjects: { NEWS: { className: 'NewsStore', useSQLite: true } },
  assets: { directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } },
  outboundService: fixture
}));

const profile = mkdtempSync(join(tmpdir(), 'pb-interaction-'));
let child = null;
let ws: WebSocket | null = null;
try {
  await mf.ready;
  const pageUrl = `http://127.0.0.1:${port}`;
  const namespace = await mf.getDurableObjectNamespace('NEWS');
  await namespace.get(namespace.idFromName('edition')).fetch('https://news.internal/refresh', { method: 'POST' });
  const site = await mf.dispatchFetch('https://fixture.local/api/news').then((r) => r.json() as Promise<FixtureResponse>);
  assert.ok(site.total > 30, `expected more than one page of articles, got ${site.total}`);

  const debugPort = await freePort();
  child = spawn(browser, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', () => {});
  let target: Target | undefined;
  for (let attempt = 0; attempt < 80 && !target; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as Target[];
      target = list.find((entry) => entry.type === 'page');
    } catch { /* devtools not up yet */ }
    if (!target) await wait(200);
  }
  assert.ok(target, 'Chrome DevTools endpoint did not become ready');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  ws = socket;
  let messageId = 0;
  const pending = new Map<number,{resolve: (value: CDPResult) => void; reject: (error: Error) => void}>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as CDPMessage;
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)!; pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  });
  await new Promise<Event>((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  const send = (method: string, params: Record<string,unknown> = {}) => new Promise<CDPResult>((resolve, reject) => {
    const id = ++messageId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');

  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    return result.result!.value as T;
  };
  const waitFor = async (expression: string, timeout = 25_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try { if (await evaluate(expression)) return; } catch { /* execution context not ready yet */ }
      await wait(100);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  };
  // Wait until the in-flight load finished (app.js disables #more while loading).
  const settle = async () => { await waitFor('!document.getElementById("more").disabled', 20_000); await wait(120); };
  const tab = async () => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await wait(50);
  };
  const describeFocus = () => evaluate<Focus | null>(`(() => { const el = document.activeElement; if (!el || el === document.body) return null;
    return { tag: el.tagName, id: el.id || '', classes: typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean) : [] }; })()`);

  await send('Page.navigate', { url: pageUrl });
  await waitFor('document.querySelectorAll(".article").length >= 4');
  await waitFor('document.getElementById("more") && !document.getElementById("more").hidden');
  await settle();
  assert.equal(await evaluate<string>('document.documentElement.dir'), 'rtl');
  assert.equal(await evaluate<string>('document.documentElement.lang'), 'he');
  assert.equal(await evaluate<number>('document.querySelectorAll(".source-card").length'), 4);
  assert.ok(await evaluate<boolean>('[...document.querySelectorAll(".rewrite-label")].every(el => el.textContent === "כותרת מקור")'));

  // 1. Keyboard traversal: every primary control is reachable with Tab alone.
  const seen: Focus[] = [];
  for (let press = 0; press < 90; press++) { await tab(); const focus = await describeFocus(); if (focus) seen.push(focus); }
  const reachable = (tag: string, id = '', cls = '') => seen.some((focus) => focus.tag === tag && focus.id === id && (cls ? focus.classes.includes(cls) : true));
  const controls = [['A', '', 'skip-link'], ['A', '', 'brand'], ['A', '', 'about-link'], ['INPUT', 'search'], ['SELECT', 'source'],
    ['SELECT', 'category'], ['SELECT', 'theme'], ['BUTTON', '', 'filter-submit'], ['BUTTON', 'broad'], ['BUTTON', 'latest'], ['BUTTON', 'more']];
  for (const [tag, id, cls] of controls) {
    assert.ok(reachable(tag, id, cls), `keyboard traversal never reached ${tag}${id ? '#' + id : ''}${cls ? '.' + cls : ''}`);
  }
  assert.ok(seen.some((focus) => focus.tag === 'A' && !focus.classes.length), 'no article link was reachable by keyboard');

  // 2. Source filter: selecting a publisher re-renders only that publisher.
  await evaluate(`(() => { const el = document.getElementById('source'); el.value = 'kan'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor('document.querySelectorAll(".article").length > 0 && [...document.querySelectorAll(".article-source")].every((n) => n.textContent === "כאן")');
  const kanCount = await evaluate<number>('document.querySelectorAll(".article").length');
  assert.ok(kanCount > 0, 'source filter rendered no rows');
  await settle();
  await evaluate(`(() => { const el = document.getElementById('source'); el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor('document.querySelectorAll(".article").length >= 4');
  await settle();

  // 3. Category filter: selecting a publisher category narrows the rows.
  const category = await evaluate<string>('[...document.querySelectorAll("#category option")].map((o) => o.value).find((v) => v)');
  assert.ok(category, 'no publisher category was offered');
  await evaluate(`(() => { const el = document.getElementById('category'); el.value = ${JSON.stringify(category)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`document.querySelectorAll(".article").length > 0 && [...document.querySelectorAll(".category-label")].every((n) => n.textContent.includes(${JSON.stringify(category)}))`);
  await settle();
  await evaluate(`(() => { const el = document.getElementById('category'); el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor('document.querySelectorAll(".article").length >= 4');
  await settle();

  // 4. Chronological order toggle.
  await evaluate('document.getElementById("latest").click()');
  await waitFor('document.getElementById("latest").getAttribute("aria-pressed") === "true" && document.getElementById("broad").getAttribute("aria-pressed") === "false"');
  await waitFor('document.getElementById("view-explanation").textContent.includes("זמן")');
  await settle();
  const times = await evaluate<string[]>('[...document.querySelectorAll(".article time")].map((t) => t.dateTime)');
  assert.deepEqual(times, [...times].sort((a, b) => b.localeCompare(a)), 'chronological order is not descending');
  await evaluate('document.getElementById("broad").click()');
  await waitFor('document.getElementById("broad").getAttribute("aria-pressed") === "true"');
  await settle();

  // 5. Explicit load-more pagination appends new rows without duplicates.
  const before = await evaluate<number>('document.querySelectorAll(".article").length');
  const firstHrefs = await evaluate<string[]>('[...document.querySelectorAll(".article-title a")].map((a) => a.href)');
  await evaluate('document.getElementById("more").click()');
  await waitFor(`document.querySelectorAll(".article").length > ${before}`, 20_000);
  const allHrefs = await evaluate<string[]>('[...document.querySelectorAll(".article-title a")].map((a) => a.href)');
  assert.equal(new Set(allHrefs).size, allHrefs.length, 'pagination produced duplicate rows');
  assert.ok(firstHrefs.every((href) => allHrefs.includes(href)), 'pagination dropped earlier rows');

  // 6. Rendered error state: a failed request shows the retry affordance, and retry recovers.
  await send('Network.setBlockedURLs', { urls: ['*/api/news*'] });
  await send('Page.navigate', { url: pageUrl });
  await waitFor('!!document.querySelector(".empty-state button")');
  assert.match(await evaluate<string>('document.querySelector(".empty-state h3").textContent'), /לא זמינים/);
  await send('Network.setBlockedURLs', { urls: [] });
  await evaluate('document.querySelector(".empty-state button").click()');
  await waitFor('document.querySelectorAll(".article").length >= 4');

  // 7. Theme follows the device until explicitly overridden; overrides survive reload.
  const chooseTheme = async (theme: string) => {
    await evaluate(`(() => { const el = document.getElementById('theme'); el.value = ${JSON.stringify(theme)}; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  };
  await send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: 'dark'}]});
  await chooseTheme('system');
  await waitFor('document.documentElement.dataset.theme === "dark"');
  await chooseTheme('light');
  await waitFor('document.documentElement.dataset.theme === "light"');
  await send('Page.reload');
  await waitFor('document.getElementById("theme")?.value === "light" && document.documentElement.dataset.theme === "light"');
  await chooseTheme('dark');
  await send('Page.reload');
  await waitFor('document.getElementById("theme")?.value === "dark" && document.documentElement.dataset.theme === "dark"');
  // Test actual rendered text contrast, including the smaller originals and controls.
  for (const theme of ['light', 'dark']) {
    await chooseTheme(theme);
    const contrasts = await evaluate<number[]>(`(() => {
      const rgb = value => value.match(/\\d+/g).slice(0,3).map(Number);
      const lum = color => rgb(color).map(v => {const x=v/255; return x<=.04045 ? x/12.92 : ((x+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      return ['.article-title', '.article-time', '.category-label', '.filters input', '#theme', '.button'].map(selector => {
        const el=document.querySelector(selector), style=getComputedStyle(el);
        let parent=el, bg=style.backgroundColor;
        while(bg==='rgba(0, 0, 0, 0)' && parent.parentElement){parent=parent.parentElement;bg=getComputedStyle(parent).backgroundColor;}
        const fg=lum(style.color), back=lum(bg);return (Math.max(fg,back)+.05)/(Math.min(fg,back)+.05);
      });
    })()`);
    assert.ok(contrasts.every(value => value >= 4.5), `${theme} text contrast failed: ${contrasts}`);
    for (const width of [320, 390, 768, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: width < 720});
      assert.equal(await evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth'), true, `${theme} overflow at ${width}px`);
      if (width === 390 || width === 1440) {
        await evaluate('document.fonts.ready');
        const image = await send('Page.captureScreenshot', {format: 'png'});
        assert.equal(typeof image.data, 'string');
        writeFileSync(join(tmpdir(), `positivity-bias-${theme}-${width === 390 ? 'mobile' : 'desktop'}.png`), Buffer.from(image.data!, 'base64'));
      }
    }
  }
  await chooseTheme('system');
  await send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: 'light'}]});
  await waitFor('document.documentElement.dataset.theme === "light"');
  await send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: 'dark'}]});
  await waitFor('document.documentElement.dataset.theme === "dark"');

  console.log('Interaction passed: keyboard Tab traversal of every primary control, source and category filters, chronological toggle, explicit load-more without duplicates, the rendered error/retry state, persistent/system themes, text contrast and four responsive widths.');
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  try { child?.kill(); } catch { /* already exited */ }
  await mf.dispose().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
