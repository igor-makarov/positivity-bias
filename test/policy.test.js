import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_POLICY, EDITORIAL_VERSION, DEFAULT_REWRITE_MODEL, DEFAULT_VALIDATOR_MODEL, VALIDATOR_VERSION, policyFingerprint, retireStaleRewrites } from '../src/policy.js';

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
  assert.notEqual(policyFingerprint({ REWRITE_MODEL: '@cf/qwen/qwen3-30b-a3b-fp8' }), fingerprint);
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
