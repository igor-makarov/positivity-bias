// Central editorial/AI policy. The fingerprint below is written onto every accepted
// rewrite and checked again at read/serve time, so a rewrite produced by an older
// pipeline (or an older grounding/verification policy) can never be displayed.

export const EDITORIAL_VERSION = 'editorial-v3';
export const CONTEXT_POLICY = 'full-text-v2';
export const VALIDATOR_VERSION = 'clef-guard-v1';

export const DEFAULT_REWRITE_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
export const DEFAULT_VALIDATOR_MODEL = '@cf/cloudflare/clef-flash';

// Cheap models only. No paid-only or expensive fallback is permitted.
export const CHEAP_MODELS = new Set([
  DEFAULT_REWRITE_MODEL,
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/meta/llama-3.2-1b-instruct',
  '@cf/meta/llama-3.2-3b-instruct',
]);

// Documented context windows (tokens), used to split requests without ever
// truncating an article merely to fit more articles into a batch.
export const MODEL_CONTEXT_TOKENS = {
  [DEFAULT_REWRITE_MODEL]: 128_000,
  '@cf/qwen/qwen3-30b-a3b-fp8': 32_768,
  '@cf/meta/llama-3.2-1b-instruct': 128_000,
  '@cf/meta/llama-3.2-3b-instruct': 128_000,
  [DEFAULT_VALIDATOR_MODEL]: 32_768,
};

// Estimated neurons per token, derived from Cloudflare's published per-million-token
// prices and the $0.011 / 1,000-neuron rate. These are planning estimates only; the
// ledger is reconciled with provider-reported usage when available.
export const MODEL_NEURON_RATES = {
  [DEFAULT_REWRITE_MODEL]: { in: 0.00409, out: 0.03491 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { in: 0.00464, out: 0.03045 },
  '@cf/meta/llama-3.2-1b-instruct': { in: 0.00500, out: 0.03000 },
  '@cf/meta/llama-3.2-3b-instruct': { in: 0.00600, out: 0.03300 },
  [DEFAULT_VALIDATOR_MODEL]: { in: 0.00400, out: 0.03300 },
};

export function modelNeuronRate(model) {
  return MODEL_NEURON_RATES[model] || { in: 0.005, out: 0.035 };
}

export function policyFingerprint(env = {}) {
  const model = env.REWRITE_MODEL || DEFAULT_REWRITE_MODEL;
  const validator = env.VALIDATOR_MODEL || DEFAULT_VALIDATOR_MODEL;
  return `${model}|${validator}|${EDITORIAL_VERSION}|${CONTEXT_POLICY}|${VALIDATOR_VERSION}`;
}

// Stable, non-reversible fingerprint of the source facts a decision was made from.
// Used to cache validation rejections without persisting any article text.
export function sourceFingerprint(article) {
  const value = `${article?.originalHeadline || ''}\u0001${article?.description || ''}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

// An article needs a fresh rewrite unless it already carries a current-policy
// decision for the same source content: an accepted rewrite, or a cached rejection.
export function needsRewrite(article, fingerprint) {
  if (article.rewriteFingerprint !== fingerprint) return true;
  if (article.rewriteStatus === 'rewritten') return false;
  if (article.rewriteStatus === 'rejected') return article.rewriteSource !== sourceFingerprint(article);
  return true;
}

// A cached rewrite is trusted only when its fingerprint matches the active policy.
// Anything else is removed: the preserved original headline returns to display and
// the stale acceptance/verification metadata is dropped. Never touches article
// identity, URL, publisher, categories or publication time.
export function retireStaleRewrites(articles, fingerprint) {
  let changed = false;
  const next = articles.map((article) => {
    // A stored headline that differs from the preserved original is a generated
    // rewrite even when the legacy snapshot lost its status/fingerprint. Such an
    // untrusted headline must never be served, so treat it as a decision to retire.
    const generated = typeof article.headline === 'string' && typeof article.originalHeadline === 'string'
      && article.headline !== article.originalHeadline;
    const hasDecision = article.rewriteStatus === 'rewritten' || article.rewriteStatus === 'rejected'
      || article.rewriteFingerprint != null || generated;
    if (!hasDecision) return article;
    if (article.rewriteFingerprint === fingerprint && article.rewriteStatus === 'rewritten') return article;
    if (article.rewriteFingerprint === fingerprint && article.rewriteStatus === 'rejected' && article.rewriteSource === sourceFingerprint(article)) return article;
    changed = true;
    const { rewriteFingerprint, rewriteSource, verification, context, contextCompleteness, ...rest } = article;
    return { ...rest, headline: article.originalHeadline, rewriteStatus: 'original' };
  });
  return { articles: changed ? next : articles, changed };
}
