// Workerd-level check of the full-text extraction policy. Plain Node has no
// HTMLRewriter, so the probe is bundled with esbuild and run inside Miniflare.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// The bundle must live under the working directory so workerd resolves it.
const directory = await mkdtemp(join(process.cwd(), '.probe-'));
const outfile = join(directory, 'probe.js');
await build({ entryPoints: ['scripts/extract-probe.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile });

const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, name: 'extract-probe', scriptPath: outfile, modules: true, compatibilityDate: '2026-10-13'
}));

try {
  await mf.ready;
  // A self-closing SVG <path> in this page must not abort extraction (real pages have them).
  const data = await (await mf.dispatchFetch('https://probe.local/?case=article')).json();
  assert.equal(data.headline, 'התעשייה האווירית השלימה בהצלחה ניסוי במל״ט');
  assert.deepEqual(data.categories, ['בטחון']);
  assert.equal(data.completeness, 'complete');
  assert.match(data.body, /השלימה בהצלחה ניסוי במל״ט/);
  assert.match(data.body, /הניסוי נערך באזור דרומי/);
  for (const noise of ['דף הבית', 'ספורט', 'פרסומת', 'כתבות נוספות', 'מומלץ עבורך', 'כל הזכויות שמורות']) {
    assert.ok(!data.body.includes(noise), `noise leaked into context: ${noise}`);
  }
  const block = await (await mf.dispatchFetch('https://probe.local/?case=block')).json();
  assert.equal(block.completeness, 'missing');
  assert.equal(block.body, '');
  const thin = await (await mf.dispatchFetch('https://probe.local/?case=thin')).json();
  assert.equal(thin.completeness, 'missing');
  assert.equal(thin.body, '');
  // A generic outer wrapper whose class happens to contain a noise word (e.g. Bootstrap's
  // "row navigation") must not suppress the whole page: the <main> article body survives
  // while noise inside <main> and a recommendation card under a noise <aside> are removed.
  const layout = await (await mf.dispatchFetch('https://probe.local/?case=layout')).json();
  assert.equal(layout.completeness, 'complete');
  assert.match(layout.body, /גוף הכתבה המלא/);
  for (const noise of ['דף הבית', 'ספורט', 'שיתוף', 'כתבה מומלצת', 'כל הזכויות שמורות']) {
    assert.ok(!layout.body.includes(noise), `noise leaked through the layout wrapper: ${noise}`);
  }
  console.log('Extraction passed: article body kept (self-closing SVG tolerated), navigation/advertising/related/footer removed, a noise-named layout wrapper does not suppress <main>, JSON-LD metadata read, bot-block and thin shells rejected.');
} finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
