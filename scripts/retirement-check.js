// Integration check: a rewrite cached under an older pipeline must never be served,
// even when no inference is available to replace it. The wrong cached headline is
// seeded directly into the Durable Object, then read back through the real API.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { LLAMA_REWRITE_MODEL, policyFingerprint, sourceFingerprint } from '../src/policy.js';

const directory = await mkdtemp(join(process.cwd(), '.probe-'));
const outfile = join(directory, 'probe.js');
await build({ entryPoints: ['scripts/retirement-probe.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile });

const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, name: 'positivity-bias', scriptPath: outfile, modules: true, compatibilityDate: '2026-10-13',
  durableObjects: { NEWS: { className: 'SeedableStore', useSQLite: true } },
  assets: { directory: 'public', binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } },
  outboundService: async () => new Response('not found', { status: 404 })
}));

try {
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace('NEWS');
  const store = namespace.get(namespace.idFromName('edition'));
  const now = new Date().toISOString();
  // Mirror the real pre-correction (bootstrap) snapshot: the old pipeline stored
  // `<model>:editorial-v2` on each rewrite and no snapshot-level policy fingerprint.
  // The correction must retire exactly that state on first serve, without inference.
  const legacyFingerprint = `${LLAMA_REWRITE_MODEL}:editorial-v2`;
  const article = { id: 'drone-1', url: 'https://www.ynet.co.il/news/article/1', sourceId: 'ynet', sourceName: 'ynet',
    originalHeadline: 'התעשייה האווירית השלימה בהצלחה ניסוי במל״ט שמצויד במקלע',
    headline: 'תעשייה אווירית: ניסוי במל״ט עם מקלע נכשל', rewriteStatus: 'rewritten',
    rewriteFingerprint: legacyFingerprint, verification: { supported: true }, context: 'x'.repeat(4000),
    categories: ['חדשות'], publishedAt: now, description: 'תיאור' };
  // A partial/legacy snapshot can lose the decision marker entirely while still
  // holding a wrong generated headline. With no fingerprint it must not be served.
  const orphan = { id: 'orphan-2', url: 'https://www.ynet.co.il/news/article/2', sourceId: 'ynet', sourceName: 'ynet',
    originalHeadline: 'המועצה אישרה 7 תוכניות חדשות',
    headline: 'המועצה דחתה 7 תוכניות חדשות',
    categories: ['חדשות'], publishedAt: new Date(Date.now() - 60_000).toISOString(), description: 'תיאור' };
  // A snapshot that lost the generated headline entirely must still restore the original.
  const headless = { id: 'headless-3', url: 'https://www.ynet.co.il/news/article/3', sourceId: 'ynet', sourceName: 'ynet',
    originalHeadline: 'הצעת החוק אושרה בקריאה ראשונה', categories: ['חדשות'],
    publishedAt: new Date(Date.now() - 120_000).toISOString(), description: 'תיאור' };
  // A partial snapshot can also lose an article's categories entirely. The serve path must
  // stay up (no 503) and return an empty category list instead of crashing on the field.
  const noCategories = { id: 'nocat-4', url: 'https://www.ynet.co.il/news/article/4', sourceId: 'ynet', sourceName: 'ynet',
    originalHeadline: 'המועצה אישרה תוכנית חדשה',
    publishedAt: new Date(Date.now() - 180_000).toISOString(), description: 'תיאור' };
  const seeded = { articles: [article, orphan, headless, noCategories], updatedAt: now, lastAttemptAt: now,
    rewriteStatus: 'ok', sources: [] };
  assert.equal(seeded.policyFingerprint, undefined); // the old snapshot had no policy fingerprint
  const seed = await store.fetch('https://news.internal/seed', { method: 'POST', body: JSON.stringify(seeded) });
  assert.equal(seed.status, 200);

  const api = await (await mf.dispatchFetch('https://fixture.local/api/news')).json();
  const byId = new Map(api.articles.map((entry) => [entry.id, entry]));
  const served = byId.get(article.id);
  assert.equal(served.headline, article.originalHeadline);
  assert.equal(served.rewriteStatus, 'original');
  assert.equal(served.rewriteFingerprint, undefined);
  assert.deepEqual(served.categories, ['חדשות']);
  const orphanServed = byId.get(orphan.id);
  assert.equal(orphanServed.headline, orphan.originalHeadline); // no fingerprint: never served
  assert.equal(orphanServed.rewriteStatus, 'original');
  const headlessServed = byId.get(headless.id);
  assert.equal(headlessServed.headline, headless.originalHeadline); // lost headline restored, never empty
  assert.equal(headlessServed.rewriteStatus, 'original');
  const noCategoriesServed = byId.get(noCategories.id); // missing categories: served, not a 503
  assert.ok(noCategoriesServed, 'article without categories was not served');
  assert.deepEqual(noCategoriesServed.categories, []);
  assert.equal(noCategoriesServed.headline, noCategories.originalHeadline);

  // The idempotent migration persisted: a later read still shows the originals.
  const again = await (await store.fetch('https://news.internal/snapshot')).json();
  for (const entry of again.articles) assert.equal(entry.headline, entry.originalHeadline);
  assert.ok(again.policyFingerprint);
  assert.notEqual(again.policyFingerprint, legacyFingerprint);

  // Serve-time enforcement is article-level, not flag-level: even when the snapshot
  // already carries the ACTIVE policy fingerprint, a stale/headless cached headline is
  // retired on read, while a genuinely current rewrite is kept.
  const active = policyFingerprint({});
  const staleArticle = { id: 'stale-3', url: 'https://www.ynet.co.il/news/article/3', sourceId: 'ynet', sourceName: 'ynet',
    originalHeadline: 'המועצה אישרה 5 תוכניות', headline: 'המועצה דחתה 5 תוכניות', rewriteStatus: 'rewritten',
    rewriteFingerprint: 'old-policy', categories: ['חדשות'], publishedAt: now, description: 'תיאור' };
  const headlessArticle = { id: 'headless-4', url: 'https://www.ynet.co.il/news/article/4', sourceId: 'ynet', sourceName: 'ynet',
    originalHeadline: 'הצעת החוק אושרה בקריאה ראשונה', categories: ['חדשות'], publishedAt: now, description: 'תיאור' };
  const trusted = { id: 'trusted-5', url: 'https://www.ynet.co.il/news/article/5', sourceId: 'ynet', sourceName: 'ynet',
    originalHeadline: 'העירייה תפתח 2 גנים חדשים', headline: 'העירייה תפתח 2 גנים חדשים בשכונה', rewriteStatus: 'rewritten',
    rewriteFingerprint: active, categories: ['חדשות'], publishedAt: now, description: 'תיאור' };
  // A partial persist can leave the ACTIVE fingerprint/status set while losing the
  // generated headline. That decision is not displayable and must restore the original
  // rather than serve an empty headline.
  const trustedHeadless = { id: 'trusted-headless-6', url: 'https://www.ynet.co.il/news/article/6', sourceId: 'ynet', sourceName: 'ynet',
    originalHeadline: 'הנמל ייפתח מחדש בשבוע הבא', headline: undefined, rewriteStatus: 'rewritten',
    rewriteFingerprint: active, categories: ['חדשות'], publishedAt: now, description: 'תיאור' };
  const rejectedSeed = { ...trustedHeadless, id: 'trusted-rejected-7', headline: '', rewriteStatus: 'rejected' };
  rejectedSeed.rewriteSource = sourceFingerprint(rejectedSeed);
  // A cached rejection must display the preserved original. A corrupted snapshot can leave
  // `rejected` with the active fingerprint/source but a generated headline; the public API
  // maps `rejected` to `original`, so serving it would present the rewrite as the
  // publisher's own headline with no disclosure.
  const pollutedRejected = { ...trustedHeadless, id: 'polluted-rejected-8', headline: 'הנמל ייסגר לצמיתות בשבוע הבא', rewriteStatus: 'rejected' };
  pollutedRejected.rewriteSource = sourceFingerprint(pollutedRejected);
  await store.fetch('https://news.internal/seed', { method: 'POST', body: JSON.stringify({ articles: [staleArticle, headlessArticle, trusted, trustedHeadless, rejectedSeed, pollutedRejected],
    updatedAt: now, lastAttemptAt: now, policyFingerprint: active, rewriteStatus: 'ok', sources: [] }) });
  const forced = await (await mf.dispatchFetch('https://fixture.local/api/news')).json();
  const forcedById = new Map(forced.articles.map((entry) => [entry.id, entry]));
  assert.equal(forcedById.get(staleArticle.id).headline, staleArticle.originalHeadline);
  assert.equal(forcedById.get(headlessArticle.id).headline, headlessArticle.originalHeadline);
  assert.equal(forcedById.get(trusted.id).headline, trusted.headline);
  assert.equal(forcedById.get(trusted.id).rewriteStatus, 'rewritten');
  assert.equal(forcedById.get(trustedHeadless.id).headline, trustedHeadless.originalHeadline); // trusted but headless: restored
  assert.equal(forcedById.get(trustedHeadless.id).rewriteStatus, 'original');
  assert.equal(forcedById.get(rejectedSeed.id).headline, rejectedSeed.originalHeadline); // empty rejected headline: restored
  assert.equal(forcedById.get(rejectedSeed.id).rewriteStatus, 'original');
  assert.equal(forcedById.get(pollutedRejected.id).headline, pollutedRejected.originalHeadline); // generated headline on a rejection: never served as the original
  assert.equal(forcedById.get(pollutedRejected.id).rewriteStatus, 'original');

  console.log('Retirement passed: a stale cached headline is never served and the migration persists without inference.');
} finally { await mf.dispose().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {}); }
