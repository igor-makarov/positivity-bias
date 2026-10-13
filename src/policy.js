// Central editorial/AI policy. The fingerprint below is written onto every accepted
// rewrite and checked again at read/serve time, so a rewrite produced by an older
// pipeline (or an older grounding/verification policy) can never be displayed.

export const EDITORIAL_VERSION = 'editorial-v3';
// v2: bounded HTMLRewriter body extraction with navigation/advertising/related removed.
// v3: a noise-named layout wrapper (e.g. Bootstrap's "row navigation") wrapping the
// whole page no longer suppresses <main>; live Kan article pages now yield a complete
// body instead of a 42-char navigation shell. Any rewrite grounded on the older
// extraction is retired by the existing fingerprint path and reprocessed progressively.
export const CONTEXT_POLICY = 'full-text-v3';
// v2: clef-flash is driven through its documented decision schema (state + typed
// yes/no questions), not the chat completion shape that its API does not accept.
// v3: a candidate is accepted only on a confident yes; a weakly-positive or uncertain
// probability keeps the preserved original (the previous >=0.5 boundary accepted the
// maximally uncertain 0.5 verdict).
export const VALIDATOR_VERSION = 'clef-guard-v3';

// First-choice low-cost rewrite model. `@cf/qwen/qwen3-30b-a3b-fp8` documents Hebrew
// support, has a 32,768-token window and is cheaper on output tokens than the previous
// default. The concrete regression/factual checks (success-to-failure reversal, the
// Karmiel/Dimona material-context case, cross-article independence, the confident-yes
// guard) pass with it, and its chat-style response envelope plus thinking-off option are
// handled. Live Hebrew-quality and neuron-use measurement against the account is still
// pending, so a candidate that the guard or clef cannot confidently accept keeps the
// preserved original.
//
// The previous default `@cf/meta/llama-3.1-8b-instruct-fp8-fast` is no longer listed in
// Cloudflare's model catalog (its docs page redirects to `?unavailable=`), so it is kept
// only as an explicitly overridable allowlist entry and planning rate, never as the
// default. Switching the default changes the policy fingerprint, so rewrites produced
// under the old model are retired at read time and reprocessed progressively under the
// same daily free-tier budget.
export const DEFAULT_REWRITE_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const LLAMA_REWRITE_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
export const DEFAULT_VALIDATOR_MODEL = '@cf/cloudflare/clef-flash';

// Cheap models only. No paid-only or expensive fallback is permitted.
export const CHEAP_MODELS = new Set([
  DEFAULT_REWRITE_MODEL,
  LLAMA_REWRITE_MODEL,
  '@cf/meta/llama-3.2-1b-instruct',
  '@cf/meta/llama-3.2-3b-instruct',
]);

// Documented context windows (tokens), used to split requests without ever
// truncating an article merely to fit more articles into a batch. Pinned to the live
// Cloudflare model pages (2026-10-13): clef-flash 24,576, clef 65,536,
// llama-3.2-1b 60,000, llama-3.2-3b 80,000, qwen3-30b-a3b 32,768.
export const MODEL_CONTEXT_TOKENS = {
  [LLAMA_REWRITE_MODEL]: 128_000,
  [DEFAULT_REWRITE_MODEL]: 32_768,
  '@cf/meta/llama-3.2-1b-instruct': 60_000,
  '@cf/meta/llama-3.2-3b-instruct': 80_000,
  // clef-flash is a decision model with a documented 24,576-token window; the larger,
  // pricier clef has a documented 65,536-token window. Keeping them separate stops an
  // oversized request from being planned for the flash model.
  [DEFAULT_VALIDATOR_MODEL]: 24_576,
  '@cf/cloudflare/clef': 65_536,
};

// Estimated neurons per token, taken from Cloudflare's published "neurons per M
// tokens" (2026-10-13), which is the unit the Free account is billed in. These are
// planning estimates only; the ledger is reconciled with provider-reported usage.
export const MODEL_NEURON_RATES = {
  [LLAMA_REWRITE_MODEL]: { in: 4119 / 1_000_000, out: 34868 / 1_000_000 },
  [DEFAULT_REWRITE_MODEL]: { in: 4625 / 1_000_000, out: 30475 / 1_000_000 },
  '@cf/meta/llama-3.2-1b-instruct': { in: 2457 / 1_000_000, out: 18252 / 1_000_000 },
  '@cf/meta/llama-3.2-3b-instruct': { in: 4625 / 1_000_000, out: 30475 / 1_000_000 },
  // 3,455 neurons per M input tokens and no output-token charge.
  [DEFAULT_VALIDATOR_MODEL]: { in: 3455 / 1_000_000, out: 0 },
  // 21,818 neurons per M input tokens, no output-token charge. This is ~6.3x the
  // flash rate, so it must never be under-reserved if it is ever configured.
  '@cf/cloudflare/clef': { in: 21818 / 1_000_000, out: 0 },
};

export function modelNeuronRate(model) {
  return MODEL_NEURON_RATES[model] || { in: 0.005, out: 0.035 };
}

// The factual-consistency decision may only be delegated to a documented clef
// decision model; other models do not accept the state/questions schema below.
export const CLEF_MODELS = new Set([DEFAULT_VALIDATOR_MODEL, '@cf/cloudflare/clef']);

export function isClefModel(model) {
  return CLEF_MODELS.has(model);
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
    // A stored headline that is missing or differs from the preserved original is a
    // generated rewrite even when the legacy snapshot lost its status/fingerprint. Such
    // an untrusted headline must never be served, so treat it as a decision to retire
    // and restore the preserved original (never serve an empty headline).
    // A decision with a missing/empty stored headline is never displayable, so it is
    // retired to the original even when its fingerprint matches the active policy; a
    // partial or corrupted snapshot must not be able to expose a headline-less article.
    const usable = typeof article.headline === 'string' && article.headline.length > 0;
    const generated = typeof article.originalHeadline === 'string'
      && (!usable || article.headline !== article.originalHeadline);
    const hasDecision = article.rewriteStatus === 'rewritten' || article.rewriteStatus === 'rejected'
      || article.rewriteFingerprint != null || generated;
    if (!hasDecision) return article;
    if (usable && article.rewriteFingerprint === fingerprint && article.rewriteStatus === 'rewritten') return article;
    // A cached rejection is a decision to display the PRESERVED original headline. Trust
    // it only when it actually carries that original: a partial/corrupted snapshot could
    // leave `rejected` with a generated headline, which the public API maps to
    // `original` and would serve as if the publisher had written it. Such a decision is
    // retired to the preserved original like any other stale rewrite.
    const showsOriginal = usable && typeof article.originalHeadline === 'string' && article.headline === article.originalHeadline;
    if (showsOriginal && article.rewriteFingerprint === fingerprint && article.rewriteStatus === 'rejected' && article.rewriteSource === sourceFingerprint(article)) return article;
    changed = true;
    const { rewriteFingerprint, rewriteSource, verification, context, contextCompleteness, ...rest } = article;
    // Restore the preserved original. If a malformed snapshot has no usable original to
    // restore, keep the existing headline rather than blanking the article.
    const restored = typeof article.originalHeadline === 'string' && article.originalHeadline.length > 0
      ? article.originalHeadline : usable ? article.headline : article.originalHeadline;
    return { ...rest, headline: restored, rewriteStatus: 'original' };
  });
  return { articles: changed ? next : articles, changed };
}
