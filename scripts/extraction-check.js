// Workerd-level check of the full-text extraction policy. Plain Node has no
// HTMLRewriter, so this runs the real module inside Miniflare.
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, name: 'extract-probe', scriptPath: 'scripts/extract-probe.js', modules: true, modulesRoot: '.',
  compatibilityDate: '2026-10-13'
}));

try {
  await mf.ready;
  const data = await (await mf.dispatchFetch('https://probe.local/')).json();
  assert.equal(data.headline, 'התעשייה האווירית השלימה בהצלחה ניסוי במל״ט');
  assert.deepEqual(data.categories, ['בטחון']);
  assert.equal(data.completeness, 'complete');
  assert.match(data.body, /השלימה בהצלחה ניסוי במל״ט/);
  assert.match(data.body, /הניסוי נערך באזור דרומי/);
  for (const noise of ['דף הבית', 'ספורט', 'פרסומת', 'כתבות נוספות', 'מומלץ עבורך', 'כל הזכויות שמורות']) {
    assert.ok(!data.body.includes(noise), `noise leaked into context: ${noise}`);
  }
  console.log('Extraction passed: article body kept, navigation/advertising/related/footer removed, JSON-LD metadata read.');
} finally { await mf.dispose(); }
