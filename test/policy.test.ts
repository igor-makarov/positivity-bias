import test from 'node:test';
import assert from 'node:assert/strict';
import { CHEAP_MODELS, CONTEXT_POLICY, EDITORIAL_VERSION, DEFAULT_REWRITE_MODEL, DEFAULT_VALIDATOR_MODEL, LLAMA_REWRITE_MODEL, MODEL_CONTEXT_TOKENS, MODEL_NEURON_RATES, VALIDATOR_VERSION, needsRewrite, policyFingerprint, retireStaleRewrites, sourceFingerprint } from '../src/policy.ts';

const fingerprint = policyFingerprint({});
const stale = { id: 'drone-1', url: 'https://www.ynet.co.il/news/article/1', sourceId: 'ynet', sourceName: 'ynet',
  originalHeadline: 'התעשייה האווירית השלימה בהצלחה ניסוי במל״ט שמצויד במקלע',
  headline: 'תעשייה אווירית: ניסוי במל״ט עם מקלע נכשל', rewriteStatus: 'rewritten',
  rewriteFingerprint: 'old-policy', verification: { supported: true }, context: 'x'.repeat(5000),
  description: 'תיאור', categories: ['חדשות'], publishedAt: '2026-10-13T11:00:00Z' };

test('The policy fingerprint covers the model, grounding policy, editorial and validator versions', () => {
  assert.ok(fingerprint.includes(DEFAULT_REWRITE_MODEL));
  assert.ok(fingerprint.includes(DEFAULT_VALIDATOR_MODEL));
  assert.ok(fingerprint.includes(EDITORIAL_VERSION) && fingerprint.includes(CONTEXT_POLICY) && fingerprint.includes(VALIDATOR_VERSION));
  assert.notEqual(policyFingerprint({ REWRITE_MODEL: LLAMA_REWRITE_MODEL }), fingerprint);
});

test('The default rewrite model is the available low-cost Qwen3 and the removed Llama slug stays overridable', () => {
  assert.equal(DEFAULT_REWRITE_MODEL, '@cf/qwen/qwen3-30b-a3b-fp8');
  assert.ok(CHEAP_MODELS.has(DEFAULT_REWRITE_MODEL));
  // The previous default is no longer in Cloudflare's catalog; it must not be the
  // default but must remain a valid explicit override with planning window/rate.
  assert.notEqual(DEFAULT_REWRITE_MODEL, LLAMA_REWRITE_MODEL);
  assert.ok(CHEAP_MODELS.has(LLAMA_REWRITE_MODEL));
  assert.ok(MODEL_CONTEXT_TOKENS[LLAMA_REWRITE_MODEL] > 0);
  assert.ok(MODEL_NEURON_RATES[LLAMA_REWRITE_MODEL].in > 0);
  assert.equal(MODEL_CONTEXT_TOKENS[DEFAULT_REWRITE_MODEL], 32_768);
});

test('A wrong cached headline is retired at serve time when the pipeline version changes', () => {
  const { articles, changed } = retireStaleRewrites([stale], fingerprint);
  assert.equal(changed, true);
  assert.equal(articles[0].headline, stale.originalHeadline);
  assert.equal(articles[0].rewriteStatus, 'original');
  assert.equal(articles[0].rewriteFingerprint, undefined);
  assert.equal(articles[0].verification, undefined);
  assert.equal(articles[0].context, undefined);
  // Only the generated headline/acceptance is cleared; identity and source facts stay.
  assert.equal(articles[0].id, stale.id);
  assert.equal(articles[0].url, stale.url);
  assert.equal(articles[0].originalHeadline, stale.originalHeadline);
  assert.equal(articles[0].publishedAt, stale.publishedAt);
  assert.deepEqual(articles[0].categories, ['חדשות']);
});

test('Retirement is idempotent and trusts a current-policy rewrite', () => {
  const current = { ...stale, rewriteFingerprint: fingerprint };
  const first = retireStaleRewrites([stale], fingerprint);
  const second = retireStaleRewrites(first.articles, fingerprint);
  assert.equal(second.changed, false);
  assert.deepEqual(second.articles[0], first.articles[0]);
  const kept = retireStaleRewrites([current], fingerprint);
  assert.equal(kept.changed, false);
  assert.equal(kept.articles[0].headline, stale.headline);
  assert.equal(kept.articles[0].rewriteStatus, 'rewritten');
});

test('Cached validation rejections are kept, invalidated by source changes, and never re-inferred', () => {
  const rejected = { ...stale, headline: stale.originalHeadline, rewriteStatus: 'rejected',
    rewriteFingerprint: fingerprint, rewriteSource: sourceFingerprint(stale) };
  assert.equal(needsRewrite(rejected, fingerprint), false);
  assert.equal(retireStaleRewrites([rejected], fingerprint).changed, false);
  assert.equal(needsRewrite(rejected, 'other-policy'), true);
  const corrected = { ...rejected, description: 'תיקון במקור' };
  assert.equal(needsRewrite(corrected, fingerprint), true); // source changed: reprocess
  const retired = retireStaleRewrites([corrected], fingerprint);
  assert.equal(retired.changed, true);
  assert.equal(retired.articles[0].rewriteStatus, 'original');
  assert.equal(retired.articles[0].rewriteSource, undefined);
});

test('Source fingerprints are stable and content-sensitive', () => {
  assert.equal(sourceFingerprint(stale), sourceFingerprint({ ...stale }));
  assert.notEqual(sourceFingerprint(stale), sourceFingerprint({ ...stale, originalHeadline: 'אחר' }));
});

test('A generated headline with no status or fingerprint is still retired as untrusted', () => {
  // Legacy/partial snapshots can lose the decision marker while keeping a wrong
  // generated headline. A stored headline that differs from the original must never
  // be served without a current fingerprint, even with no status to key on.
  const legacy = { id: 'legacy-1', url: 'https://www.ynet.co.il/news/article/9', sourceId: 'ynet', sourceName: 'ynet',
    originalHeadline: stale.originalHeadline, headline: 'תעשייה אווירית: ניסוי במל״ט עם מקלע נכשל',
    description: 'תיאור', categories: ['חדשות'], publishedAt: '2026-10-13T11:00:00Z' };
  const { articles, changed } = retireStaleRewrites([legacy], fingerprint);
  assert.equal(changed, true);
  assert.equal(articles[0].headline, legacy.originalHeadline);
  assert.equal(articles[0].rewriteStatus, 'original');
  assert.equal(articles[0].id, legacy.id);
  assert.deepEqual(articles[0].categories, ['חדשות']);
  // A genuine original (headline equals the preserved original) is left untouched.
  const plain = { ...legacy, headline: legacy.originalHeadline, rewriteStatus: 'original' };
  assert.equal(retireStaleRewrites([plain], fingerprint).changed, false);
  // A current-policy rewrite is still trusted.
  const current = { ...legacy, rewriteStatus: 'rewritten', rewriteFingerprint: fingerprint };
  assert.equal(retireStaleRewrites([current], fingerprint).changed, false);
  assert.equal(retireStaleRewrites([current], fingerprint).articles[0].headline, legacy.headline);
  // A lost/empty generated headline must never be served either: restore the original.
  const headless = { ...legacy, headline: undefined, rewriteStatus: 'original' };
  const restored = retireStaleRewrites([headless], fingerprint);
  assert.equal(restored.changed, true);
  assert.equal(restored.articles[0].headline, legacy.originalHeadline);
  assert.equal(restored.articles[0].rewriteStatus, 'original');
});

test('A current-policy decision whose stored headline was lost is still restored, not served empty', () => {
  // Even a decision carrying the ACTIVE fingerprint must not expose a headline-less
  // article: a partial/corrupted persist could leave rewriteStatus/fingerprint set but
  // the generated headline missing, and the display invariant is that the preserved
  // original is always shown. Trust a decision only when it carries a usable headline.
  const trustedRewritten = { ...stale, rewriteFingerprint: fingerprint, rewriteStatus: 'rewritten', headline: undefined };
  const rewritten = retireStaleRewrites([trustedRewritten], fingerprint);
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.articles[0].headline, stale.originalHeadline);
  assert.equal(rewritten.articles[0].rewriteStatus, 'original');

  const trustedRejected = { ...stale, headline: '', rewriteStatus: 'rejected',
    rewriteFingerprint: fingerprint, rewriteSource: sourceFingerprint(stale) };
  const rejected = retireStaleRewrites([trustedRejected], fingerprint);
  assert.equal(rejected.changed, true);
  assert.equal(rejected.articles[0].headline, stale.originalHeadline);
  assert.equal(rejected.articles[0].rewriteStatus, 'original');

  // A trusted decision with a usable headline is still kept, so normal accepted rewrites
  // and cached rejections are untouched.
  const accepted = { ...stale, headline: 'תעשייה אווירית: ניסוי מוצלח במל״ט', rewriteFingerprint: fingerprint, rewriteStatus: 'rewritten' };
  assert.equal(retireStaleRewrites([accepted], fingerprint).changed, false);
  assert.equal(retireStaleRewrites([accepted], fingerprint).articles[0].headline, accepted.headline);
});

test('A trusted rejection that carries a generated headline is restored, not served as the original', () => {
  // A cached rejection means "show the preserved original". A partial/corrupted snapshot
  // can leave `rejected` with the active fingerprint/source but a generated headline; the
  // public API maps `rejected` to `original`, so serving it would present the rewrite as
  // the publisher's own headline with no disclosure. It must be retired to the original.
  const polluted = { ...stale, headline: 'תעשייה אווירית: ניסוי מוצלח במל״ט', rewriteStatus: 'rejected',
    rewriteFingerprint: fingerprint, rewriteSource: sourceFingerprint(stale) };
  const { articles, changed } = retireStaleRewrites([polluted], fingerprint);
  assert.equal(changed, true);
  assert.equal(articles[0].headline, stale.originalHeadline);
  assert.equal(articles[0].rewriteStatus, 'original');
  assert.equal(articles[0].rewriteFingerprint, undefined);
  assert.equal(articles[0].rewriteSource, undefined);
  assert.deepEqual(articles[0].categories, ['חדשות']);
  // A genuine cached rejection (headline IS the preserved original) is still trusted and
  // is not re-reserved/re-inferred.
  const genuine = { ...polluted, headline: stale.originalHeadline };
  assert.equal(retireStaleRewrites([genuine], fingerprint).changed, false);
  assert.equal(needsRewrite(genuine, fingerprint), false);
});
