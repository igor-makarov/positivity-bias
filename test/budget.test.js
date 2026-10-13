import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DAILY_NEURON_BUDGET, MAX_DAILY_NEURON_BUDGET, SHARED_RESERVED_TOKENS_PER_ITEM, VERIFY_QUESTION_CHARS_PER_CANDIDATE, budgetDecision, dailyNeuronBudget, estimateBatchNeurons, estimateNeurons, estimateTokens, fitBatchToBudget, planBatches, requestContextTokens } from '../src/budget.js';
import { MODEL_CONTEXT_TOKENS } from '../src/policy.js';

test('The daily budget defaults conservatively and never exceeds the free allocation', () => {
  assert.equal(dailyNeuronBudget({}), DEFAULT_DAILY_NEURON_BUDGET);
  assert.ok(DEFAULT_DAILY_NEURON_BUDGET < MAX_DAILY_NEURON_BUDGET);
  assert.equal(dailyNeuronBudget({ DAILY_NEURON_BUDGET: '999999' }), MAX_DAILY_NEURON_BUDGET);
  assert.equal(dailyNeuronBudget({ DAILY_NEURON_BUDGET: '-5' }), 0);
  assert.equal(dailyNeuronBudget({ DAILY_NEURON_BUDGET: 'not a number' }), DEFAULT_DAILY_NEURON_BUDGET);
});

test('Budget decisions reserve atomically and refuse overspend', () => {
  assert.equal(budgetDecision(0, 100, 1000).allowed, true);
  assert.equal(budgetDecision(950, 100, 1000).allowed, false);
  assert.equal(budgetDecision(950, 100, 1000).reason, 'budget_exhausted');
  assert.equal(budgetDecision(0, 10, 0).allowed, false);
  assert.equal(budgetDecision(500, 100, 1000).remaining, 400);
});

test('Neuron estimates are positive and model-aware', () => {
  assert.ok(estimateTokens('שלום') > 0);
  assert.ok(estimateNeurons('@cf/meta/llama-3.1-8b-instruct-fp8-fast', 1000, 100) > 0);
  assert.ok(estimateNeurons('@cf/qwen/qwen3-30b-a3b-fp8', 1000, 100) > 0);
});

test('Adaptive batches split on the model context window without truncating context', () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ id: `a${index}`, contextLength: 6000 }));
  const batches = planBatches(items, { model: '@cf/qwen/qwen3-30b-a3b-fp8' });
  assert.equal(batches.flat().length, 10);
  assert.ok(batches.length > 1); // 10 full-context articles do not fit one 32k-token request
  assert.ok(batches.every((batch) => batch.every((item) => item.contextLength === 6000))); // never shortened to fit
  const tooLarge = planBatches([{ id: 'huge', contextLength: 100_000 }], { model: '@cf/qwen/qwen3-30b-a3b-fp8' });
  assert.equal(tooLarge.length, 0); // deferred rather than truncated
});

test('Requests are limited by the smaller of the rewrite and validator context windows', () => {
  const clefWindow = MODEL_CONTEXT_TOKENS['@cf/cloudflare/clef-flash'];
  assert.equal(clefWindow, 24_576); // documented decision-model window
  assert.equal(requestContextTokens(['@cf/meta/llama-3.1-8b-instruct-fp8-fast', '@cf/cloudflare/clef-flash']), clefWindow);
  assert.equal(requestContextTokens(['@cf/meta/llama-3.2-1b-instruct']), 128_000);
  assert.equal(requestContextTokens(['@cf/unknown/model']), 32_768); // conservative default
  assert.equal(requestContextTokens(['@cf/meta/llama-3.1-8b-instruct-fp8-fast', '@cf/unknown/model']), 32_768); // unknown peer stays conservative
  assert.equal(requestContextTokens([]), 32_768);
  const items = Array.from({ length: 20 }, (_, index) => ({ id: `a${index}`, contextLength: 6000 }));
  const rewriteOnly = planBatches(items, { model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' });
  const shared = planBatches(items, { model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    contextTokens: requestContextTokens(['@cf/meta/llama-3.1-8b-instruct-fp8-fast', '@cf/cloudflare/clef-flash']) });
  assert.ok(shared.length > rewriteOnly.length); // the smaller validator window forces more splits
  const itemTokens = Math.ceil(6000 / 1.5) + 128;
  for (const batch of shared) assert.ok(1600 + batch.length * itemTokens + batch.length * 180 <= clefWindow);
});

test('The shared reservation covers the clef questions and clef charges no output tokens', () => {
  assert.ok(SHARED_RESERVED_TOKENS_PER_ITEM > 180);
  const items = [{ id: 'a', contextLength: 6000 }];
  const estimate = estimateBatchNeurons({ rewrite: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', validator: '@cf/cloudflare/clef-flash' }, items);
  const verifyInput = estimateTokens('x'.repeat(6000 + VERIFY_QUESTION_CHARS_PER_CANDIDATE)) + 400;
  const expected = estimateNeurons('@cf/meta/llama-3.1-8b-instruct-fp8-fast', estimateTokens('x'.repeat(6000)) + 400, 180)
    + estimateNeurons('@cf/cloudflare/clef-flash', verifyInput, 0);
  assert.ok(Math.abs(estimate - expected) < 1e-6);
  // The clef output rate is zero: requested output never adds neurons.
  assert.equal(estimateNeurons('@cf/cloudflare/clef-flash', 1000, 10_000), estimateNeurons('@cf/cloudflare/clef-flash', 1000, 0));
});

test('Output space is reserved per article, not as a fixed amount', () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ id: `b${index}`, contextLength: 4308 })); // ~3000 input tokens each
  const batches = planBatches(items, { model: '@cf/qwen/qwen3-30b-a3b-fp8', contextTokens: 32_768 });
  assert.equal(batches.flat().length, 10);
  assert.ok(batches.length > 1); // 10 * (3000 input + 180 output) cannot fit one 32k request
  for (const batch of batches) assert.ok(1600 + batch.length * 3000 + batch.length * 180 <= 32_768);
});

test('Batch size is reduced to the remaining daily budget without truncating context', () => {
  const models = { rewrite: '@cf/qwen/qwen3-30b-a3b-fp8', validator: '@cf/cloudflare/clef-flash' };
  const items = Array.from({ length: 5 }, (_, index) => ({ id: `c${index}`, contextLength: 6000 }));
  const one = estimateBatchNeurons(models, items.slice(0, 1));
  const two = estimateBatchNeurons(models, items.slice(0, 2));
  assert.ok(one > 0 && two > one); // cost grows with the number of articles
  // A budget that fits exactly one article must reduce the request, not defer it all.
  const fitted = fitBatchToBudget(items, models, one + 1);
  assert.equal(fitted.length, 1);
  assert.equal(fitted[0].contextLength, 6000); // context is never shortened to make room
  assert.deepEqual(fitBatchToBudget(items, models, two + 1).map((item) => item.id), ['c0', 'c1']);
  assert.equal(fitBatchToBudget(items, models, one - 1).length, 0); // defer instead of overspending
  assert.equal(fitBatchToBudget(items, models, 0).length, 0);
  assert.equal(fitBatchToBudget(items, models, Number.NaN).length, 0);
});
