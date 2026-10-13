# Current state

- Hebrew RTL news Worker on `main`: configurable source registry; RSS/Atom and Kan
  news-sitemap adapters; category/source rotation; hourly ingestion; SQLite Durable
  Object storage; guarded Workers AI rewrites with originals preserved.
- Chosen name: **במבט**. English subtitle removed from the visible header/logo.
- Sessions/control are on `shurik-control/main`; iterations continue immediately
  (`wait-seconds: 0`), with a separate hourly Codex checkup.

## Verified this iteration (2026-10-13, iteration 2-3)

0. **Branding correction.** Removed the `POSITIVITY BIAS` span from
   `public/index.html` and the now-unused `.brand-caption` rules and reserved
   spacing from `public/style.css` (desktop + mobile). The editorial prompt no
   longer names the English brand. Hebrew slogans and deployment identities kept.
1. **Full-text grounding.** `src/extract.js` extracts the article body with one
   bounded `HTMLRewriter` pass, skipping navigation/advertising/related/footer and
   reading JSON-LD metadata plus `articleBody`. Context completeness is tracked as
   `complete`/`truncated`/`missing`; missing context keeps the original. Full text
   is fetched transiently only for rewrite candidates and is never persisted or
   exposed. `scripts/extraction-check.js` verifies this under workerd.
2. **Editorial + verification prompts.** The rewrite prompt now requires the primary
   point and its material context (actor/speaker, action, geographic scope, result)
   and forbids outcome reversal. `@cf/cloudflare/clef-flash` answers two separate
   questions — supported and context-preserved — and a candidate is accepted only
   when both are true. Qwen3 is on the cheap allowlist with thinking disabled and a
   chat-style response parser; default remains Llama until live checks.
3. **Policy fingerprint + retirement.** `src/policy.js` fingerprints model,
   grounding policy, editorial version and validator version. Stale rewrites are
   retired at read/serve time and by a persisted idempotent migration: the generated
   headline is cleared, the original returns, article identity/source facts stay.
   `scripts/retirement-check.js` seeds a stale wrong headline and confirms it is not
   served even with no inference available.
4. **Adaptive daily budget.** `src/budget.js` replaces the 8/hour and 1024-token
   caps with token-budgeted batches sized from full-text input, model context and a
   persisted reservation against `DAILY_NEURON_BUDGET` (default 6000 of the shared
   10,000/day), reconciled with provider usage and deferred instead of overspending.
   `MAX_CONTEXT_FETCHES` (20) keeps page fetches inside subrequest limits.
5. **Regressions.** Exact reported success→failure reversal (heuristic + Clef
   rejection), the Karmiel/Dimona material-context case (omitted speakers fail;
   faithful rewrite accepted), cross-article independence, and stale-cache
   retirement are all covered.

Validation this iteration: `npm run check`, **38 unit tests**, `npm run build`,
`npm run test:worker`, `npm run test:extract`, `npm run test:retirement` all pass.

## Blocked / needs input

1. **Cloudflare deployment unverified.** No Cloudflare credentials or account access
   in this environment; the existing Worker name, build/deploy commands, routes and
   deployed URL could not be inspected. Reconcile `wrangler.jsonc`
   (`positivity-bias`) with the connected Workers Builds Worker once access is
   available. Do not create a parallel deployment.
2. **Live inference unverified.** Workers AI Hebrew quality, the `AI` binding,
   Clef Flash behaviour and real neuron use remain unmeasured. Mocks/fixtures prove
   wiring and fallbacks only. Switch the default to Qwen3 only after measured live
   checks. Do not interpret a passing fixture as successful production inference.
3. **Interactive QA pending** (keyboard traversal, filters, order, pagination,
   error states). Render checks at 390×844 and 1440×1000 passed previously.
4. Kan JSON-LD has no `articleSection`, so Kan categories remain missing by policy.

Steering goes through `PROMPT.md`; further implementation belongs to Shurik.
