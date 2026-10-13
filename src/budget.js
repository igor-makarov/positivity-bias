// Daily free-tier neuron accounting and adaptive, token-budgeted batching.
//
// The Free account gets a shared 10,000-neuron/day Workers AI allocation. The
// project reserves a smaller, configurable slice (`DAILY_NEURON_BUDGET`) so other
// account usage keeps headroom. Reservations are persisted before any model call
// so concurrent refreshes or restarts cannot overspend, and are reconciled with
// provider-reported usage when available.

import { MODEL_CONTEXT_TOKENS, modelNeuronRate } from './policy.js';

export const DEFAULT_DAILY_NEURON_BUDGET = 6_000;
export const MAX_DAILY_NEURON_BUDGET = 10_000;
export const ESTIMATED_CHARS_PER_TOKEN = 1.5; // deliberately conservative for Hebrew + JSON wrappers
export const OUTPUT_TOKENS_PER_ITEM = 180; // one complete short headline (and one verdict)

export function estimateTokens(value) {
  return Math.ceil(String(value ?? '').length / ESTIMATED_CHARS_PER_TOKEN) + 8;
}

export function estimateNeurons(model, inputTokens, outputTokens) {
  const rate = modelNeuronRate(model);
  return inputTokens * rate.in + outputTokens * rate.out;
}

export function dailyNeuronBudget(env = {}) {
  const configured = Number(env.DAILY_NEURON_BUDGET);
  if (!Number.isFinite(configured)) return DEFAULT_DAILY_NEURON_BUDGET;
  // Never automatically raise the project slice past the free allocation.
  return Math.max(0, Math.min(MAX_DAILY_NEURON_BUDGET, Math.floor(configured)));
}

export function budgetDecision(used, estimate, budget) {
  if (!Number.isFinite(budget) || budget <= 0) return { allowed: false, reason: 'budget_disabled' };
  const remaining = Math.max(0, budget - Math.max(0, used));
  if (estimate > remaining) return { allowed: false, reason: 'budget_exhausted', remaining };
  return { allowed: true, remaining: remaining - estimate };
}

// Split pending articles into requests that fit both the model context window and a
// reserved output space. Article context is never truncated to fit more articles:
// an article that cannot fit on its own is deferred, not shortened.
export function planBatches(items, { model, promptTokens = 1_600, outputTokensPerItem = OUTPUT_TOKENS_PER_ITEM } = {}) {
  const contextTokens = MODEL_CONTEXT_TOKENS[model] || 32_768;
  const usableInputTokens = contextTokens - outputTokensPerItem * 4 - promptTokens;
  const batches = [];
  let current = [];
  let currentTokens = 0;
  for (const item of items) {
    const chars = item.contextLength ?? String(item.context ?? '').length;
    const itemTokens = Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN) + 128;
    if (itemTokens > usableInputTokens) continue;
    if (current.length && currentTokens + itemTokens > usableInputTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += itemTokens;
  }
  if (current.length) batches.push(current);
  return batches;
}
