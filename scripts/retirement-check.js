// Integration check: a rewrite cached under an older pipeline must never be served,
// even when no inference is available to replace it. The wrong cached headline is
// seeded directly into the Durable Object, then read back through the real API.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const directory = await mkdtemp(join(process.cwd(), '.probe-'));
const outfile = join(directory, 'probe.js');
await build({ entryPoints: ['scripts/retirement-probe.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile });

const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, name: 'positivity-bias', scriptPath: outfile, modules: true, compatibilityDate: '2026-10-13',
  durableObjects: { NEWS: { className: 'SeedableStore', useSQLite: true } },
  assets: { directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } }
}));

try {
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace('NEWS');
  const store = namespace.get(namespace.idFromName('edition'));
  const now = new Date().toISOString();
  const article = { id: 'drone-1', url: 'https://www.ynet.co.il/news/article/1', sourceId: 'ynet', sourceName: 'ynet',
    originalHeadline: 'התעשייה האווירית השלימה בהצלחה ניסוי במל״ט שמצויד במקלע',
    headline: 'תעשייה אווירית: ניסוי במל״ט עם מקלע נכשל', rewriteStatus: 'rewritten',
    rewriteFingerprint: 'old-policy', verification: { supported: true }, context: 'x'.repeat(4000),
    categories: ['חדשות'], publishedAt: now, description: 'תיאור' };
  const seeded = { articles: [article], updatedAt: now, lastAttemptAt: now, policyFingerprint: 'old-policy',
    rewriteStatus: 'ok', sources: [] };
  const seed = await store.fetch('https://news.internal/seed', { method: 'POST', body: JSON.stringify(seeded) });
  assert.equal(seed.status, 200);

  const api = await (await mf.dispatchFetch('https://fixture.local/api/news')).json();
  assert.equal(api.articles[0].headline, article.originalHeadline);
  assert.equal(api.articles[0].rewriteStatus, 'original');
  assert.equal(api.articles[0].rewriteFingerprint, undefined);
  assert.equal(api.articles[0].id, article.id);
  assert.deepEqual(api.articles[0].categories, ['חדשות']);

  // The idempotent migration persisted: a later read still shows the original.
  const again = await (await store.fetch('https://news.internal/snapshot')).json();
  assert.equal(again.articles[0].headline, article.originalHeadline);
  assert.equal(again.articles[0].rewriteFingerprint, undefined);
  assert.notEqual(again.policyFingerprint, 'old-policy');
  console.log('Retirement passed: a stale cached headline is never served and the migration persists without inference.');
} finally { await mf.dispose().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {}); }
