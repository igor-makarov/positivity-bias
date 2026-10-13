import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedPublisherFetch, mapConcurrently, pendingArticles, rewriteCoverage } from '../src/progress.js';
import { sourceFingerprint } from '../src/policy.js';
import { mergeArticles } from '../src/news.js';

const now = Date.parse('2026-10-13T20:00:00Z');
const policy = 'current';
const article = (id) => ({ id, sourceId: 'ynet', categories: ['בארץ'],
  publishedAt: '2026-10-13T19:00:00Z', originalHeadline: `כותרת ${id}`, headline: `כותרת ${id}`, rewriteStatus: 'original' });
const attempted = (item, state = 'missing') => ({ ...item, contextState: state,
  rewriteAttemptAt: '2026-10-13T19:00:00Z', rewriteAttemptPolicy: policy, rewriteAttemptSource: sourceFingerprint(item) });

test('Inaccessible articles do not starve untouched backlog; they retry after a day', () => {
  const blocked = attempted(article('blocked'));
  const fresh = article('fresh');
  assert.deepEqual(pendingArticles([blocked, fresh], policy, now, 1).map(({ id }) => id), ['fresh']);
  assert.equal(pendingArticles([blocked], policy, now, 1).length, 0);
  assert.equal(pendingArticles([blocked], policy, now + 24 * 3600_000, 1).length, 1);
  assert.equal(pendingArticles([blocked], 'new-policy', now, 1).length, 1);
  assert.equal(pendingArticles([{ ...blocked, description: 'new facts' }], policy, now, 1).length, 1);
});

test('Untouched retained articles precede recently attempted undecided ones', () => {
  assert.deepEqual(pendingArticles([attempted(article('old'), 'available'), article('new')], policy, now, 2).map(({ id }) => id), ['new', 'old']);
});

test('Continuation attempts each article at most once within an edition', () => {
  const item = attempted(article('already-tried'), 'available');
  assert.equal(pendingArticles([item], policy, now, 1, now - 2 * 3600_000).length, 0);
  assert.equal(pendingArticles([item], policy, now, 1, now).length, 1);
});

test('Feed re-ingestion preserves progress for unchanged source facts and resets it for corrections', () => {
  const previous = attempted(article('blocked'));
  const same = mergeArticles([previous], [article('blocked')], now)[0];
  assert.equal(same.contextState, 'missing');
  assert.equal(same.rewriteAttemptAt, previous.rewriteAttemptAt);
  const corrected = mergeArticles([previous], [{ ...article('blocked'), description: 'updated source facts' }], now)[0];
  assert.equal(corrected.rewriteAttemptAt, undefined);
});

test('Publisher request accounting stops before the Free subrequest ceiling', async () => {
  let calls = 0;
  const fetcher = boundedPublisherFetch(async () => { calls++; return new Response('ok'); }, 2);
  await fetcher('https://publisher.test'); await fetcher('https://publisher.test/redirect');
  assert.throws(() => fetcher('https://publisher.test/next'), /subrequest_budget/);
  assert.equal(calls, 2); assert.equal(fetcher.remaining(), 0);
});

test('Publisher requests and native AI calls share the request ceiling with reserved verification slots', async () => {
  let publisherCalls = 0, modelCalls = 0;
  const fetcher = boundedPublisherFetch(async () => { publisherCalls++; }, 48);
  fetcher.reserveModels(32);
  for (let i = 0; i < 16; i++) await fetcher('https://publisher.test');
  assert.throws(() => fetcher('https://publisher.test/redirect'), /subrequest_budget/);
  for (let i = 0; i < 32; i++) await fetcher.modelCall(async () => { modelCalls++; });
  assert.equal(publisherCalls + modelCalls, 48);
  assert.throws(() => fetcher.modelCall(() => { modelCalls++; }), /subrequest_budget/);
  assert.equal(modelCalls, 32);
});

test('Large context batches keep at most four full HTML loads active and preserve article order', async () => {
  let active = 0, peak = 0;
  const result = await mapConcurrently(Array.from({ length: 40 }, (_, i) => i), async (item) => {
    active++; peak = Math.max(peak, active);
    await Promise.resolve();
    active--; return item * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(result, Array.from({ length: 40 }, (_, i) => i * 2));
});

test('Coverage counts genuine changed current-policy titles over the full feed', () => {
  const rewritten = { ...article('changed'), headline: 'ניסוח חדש', rewriteStatus: 'rewritten', rewriteFingerprint: policy };
  const unchanged = { ...article('echo'), rewriteStatus: 'rewritten', rewriteFingerprint: policy };
  const unavailable = attempted(article('missing'));
  const rejected = { ...article('rejected'), rewriteStatus: 'rejected', rewriteFingerprint: policy, rewriteSource: sourceFingerprint(article('rejected')) };
  assert.deepEqual(rewriteCoverage([rewritten, unchanged, unavailable, rejected, article('pending')], policy),
    { total: 5, rewritten: 1, original: 4, convertedPercent: 20, sourceUnavailable: 1, rejected: 1, pending: 2 });
});
