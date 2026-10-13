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

// The shared article context is sent to BOTH the rewrite model and the validator, so
// a request may only be as large as the smallest context window in the pair. Every
// model contributes its documented window, or the conservative default when unknown,
// and the most restrictive result wins.
export function requestContextTokens(models = []) {
  if (!models.length) return 32_768;
  return Math.min(...models.map((model) => MODEL_CONTEXT_TOKENS[model] || 32_768));
}

// Split pending articles into requests that fit the model context window and a
// reserved output space of one complete short result per article. Article context is
// never truncated to fit more articles: an article that cannot fit on its own is
// deferred, not shortened. Pass `contextTokens` to size requests for the smaller of
// the rewrite and validator models (see requestContextTokens).
export function planBatches(items, { model, contextTokens, promptTokens = 1_600, outputTokensPerItem = OUTPUT_TOKENS_PER_ITEM } = {}) {
  const limit = Number.isFinite(contextTokens) ? contextTokens : MODEL_CONTEXT_TOKENS[model] || 32_768;
  const fits = (inputTokens, count) => promptTokens + inputTokens + count * outputTokensPerItem <= limit;
  const batches = [];
  let current = [];
  let currentTokens = 0;
  for (const item of items) {
    const chars = item.contextLength ?? String(item.context ?? '').length;
    const itemTokens = Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN) + 128;
    if (!fits(itemTokens, 1)) continue; // deferred: cannot fit even alone, never truncated
    if (current.length && !fits(currentTokens + itemTokens, current.length + 1)) {
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
