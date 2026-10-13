# Current state

- Hebrew RTL news Worker on `main`: configurable source registry; RSS/Atom and Kan
  news-sitemap adapters; category/source rotation; hourly ingestion; SQLite Durable
  Object storage; guarded Workers AI rewrites with originals preserved.
- Chosen name: **במבט**. English subtitle removed from the visible header/logo.
- Sessions/control are on `shurik-control/main`; iterations continue immediately
  (`wait-seconds: 0`), with a separate hourly Codex checkup.

## Verified (2026-10-13, iteration 2-10)

21. **Clef acceptance boundary corrected (uncertain verdicts now keep the original).**
    The guard accepted a candidate when both `noul` probabilities were `>= 0.5`, so a
    maximally uncertain 0.5 verdict — and any weak lean-yes — was treated as a confident
    yes, contradicting the code's own comment and the requirement to keep the original
    when a check is uncertain. `CLEF_ACCEPT_PROBABILITY` is now `0.7` (documented
    confident-yes boundary; values at or above it accept, everything lower keeps the
    preserved original). `VALIDATOR_VERSION` is bumped to `clef-guard-v3` so any rewrite
    verified under the looser boundary is retired by the existing fingerprint path and
    reprocessed progressively. The clef request/response contract was re-checked against
    the live Cloudflare docs (`state` may be structured JSON; `questions` are typed
    `noul`/`choice`/`score`, 1–64, with `criteria` valid for `noul`; `answers[id].noul` is
    the probability the answer is yes) — the verifier already matches it. New unit
    regression fails against the old `0.5` boundary and passes after the fix.
    Live re-check (2-10): two live ynet article pages exposed JSON-LD `articleBody`
    (1,925 and 2,826 chars) with no bot-block interstitial, so full-text grounding
    still works on real accessible articles; ynet categories come from its RSS labels.
    `articleSection` was absent on those pages, matching the policy that missing
    publisher categories stay missing.

## Verified (2026-10-13, iteration 2-9)

19. **Clef factual-verification call was fundamentally wrong and is now fixed.**
    `@cf/cloudflare/clef-flash` is a *decision* model, not a chat/completion model: its
    documented API takes `{ model, state, questions }` (typed `noul`/`choice`/`score`
    questions) and returns probabilities under `answers`. The previous verifier sent a
    chat envelope (`messages`, `response_format`, `temperature`, `max_tokens`) and parsed
    `choices`/`response`, which the real endpoint cannot accept, so in production every
    rewrite would have fallen back to its original and the refresh would report
    `provider_unavailable`. `verifyBatch` now builds the documented schema (two `noul`
    questions per candidate, keyed by candidate index for per-article independence),
    parses `answers[*].noul`, and accepts only when both probabilities are a confident
    yes. Requests are chunked to the documented 64-question limit; a non-clef validator
    is refused (`validator_misconfigured`). New unit regressions assert the exact request
    shape (no `messages`/`response_format`/`max_tokens`), that a chat-shaped response is
    never accepted as a verdict, and that uncertain/missing answers keep the original.
20. **Clef window, pricing and budget corrected to the documented values.** The
    validator window is 24,576 tokens (not 32,768) and clef charges input tokens only
    ($0.038/M → 0.0034545 neurons/token, no output charge). `requestContextTokens`,
    `MODEL_NEURON_RATES`/`MODEL_CONTEXT_TOKENS` and `estimateBatchNeurons` now reflect
    that, and the shared per-item reservation includes the two clef questions, so a
    rewrite+verify batch is sized for the real validator window without truncating
    article context. `VALIDATOR_VERSION` is bumped to `clef-guard-v2`, retiring any
    rewrite verified under the broken validator. `npm run test:batch` now reports the
    24,576-token window; all other checks are unchanged.

## Verified (2026-10-13, iteration 2-8)

16. **Budget-aware batch sizing.** `planBatches` sized requests by the context window
    only; the remaining daily neuron budget was a yes/no gate per pre-planned batch, so
    a batch larger than what was left deferred **every** article in it even though some
    could fit. New `estimateBatchNeurons`/`fitBatchToBudget` (`src/budget.js`) reduce a
    context-sized batch to the largest prefix whose estimated rewrite+verify cost fits
    the remaining budget, without truncating article context; `src/worker.js` uses them
    per request. This directly satisfies "size each request from the actual full-text
    input, model context window, reserved output space, and remaining daily neuron
    budget". Unit regressions cover the fit/truncate/overspend cases; `npm run test:batch`
    now runs a fresh Durable Object with a 60-neuron budget and proves one article is
    rewritten (1 rewrite + 1 verify call) instead of deferring all nine, with usage ≤ 60.
    The new integration assertion was shown to fail against the pre-fix per-batch gate
    (0 rewrite calls) and pass after the fix. Existing budget=0 deferral, full-budget
    throughput, retirement and reprocessing behaviour is unchanged.
17. **Lost-headline retirement hardening.** `retireStaleRewrites` only treated a stored
    headline as untrusted when it was a string that differed from the original, so a
    legacy/partial snapshot whose generated `headline` was missing (and had no
    status/fingerprint) was served with `headline: undefined` instead of the preserved
    original, violating the display invariant (and `mergeArticles` could propagate the
    missing headline). Any article whose stored headline is missing or differs from the
    preserved original is now retired to the original. New unit and
    `npm run test:retirement` regressions cover a headless article and were shown to
    fail against the pre-fix logic and pass after it.
18. **Article-level serve-time enforcement.** `applyPolicyRetirement` returned early
    whenever the snapshot-level `policyFingerprint` already matched, so an inconsistent
    snapshot (flag advanced while an article still held a stale/headless cached headline)
    would keep serving it until the next refresh. The check now runs against the actual
    article state on every read and writes only when something changed; a current-policy
    accepted rewrite is still kept. `npm run test:retirement` seeds the active fingerprint
    together with a stale and a headless headline and proves both are retired on read while
    the trusted rewrite is served; the assertion was shown to fail against the pre-fix
    early return and pass after it.

## Verified (2026-10-13, iteration 2-7)

14. **Missing-fingerprint retirement defect fixed.** `retireStaleRewrites` treated an
    article as having a decision only when `rewriteStatus` was `rewritten`/`rejected`
    or a fingerprint existed. A legacy/partial snapshot that lost both but still held
    a wrong generated `headline` was therefore served as a generated headline,
    violating "missing fingerprints must never expose an untrusted cached rewrite."
    Now any stored headline that differs from the preserved original is treated as an
    untrusted rewrite and retired to the original. New unit regression fails on the
    pre-fix logic and passes after it; `npm run test:retirement` seeds such an orphan
    article (no status, no fingerprint) into the real Worker and confirms it is never
    served and the migration persists.
15. **Qwen3 response-shape handling hardened.** `parseModelText` now resolves chat
    `choices` under top-level, `result` and `response` wrappers; `modelUsageNeurons`
    also reads nested `result.usage`; a thinking-only `reasoning_content` with empty
    `content` is not mistaken for the JSON result. New unit and batch regressions
    cover the nested Qwen3 envelope. Default model remains Llama pending the live
    Hebrew/neuron measurement described under Blocked.

## Verified (2026-10-13, iteration 2-6)

11. **Runtime checks now exercise current source.** `test:worker`, `test:browser` and
    `test:interaction` rebuild the bundle first, and new `scripts/bundle-guard.js`
    refuses a missing or stale `dist/worker.js` (compared by mtime against `src/`,
    `websites.json`, `package.json`). A passing runtime check can no longer validate an
    old build, and a direct `node scripts/smoke.js` exits with a clear message instead
    of an ENOENT stack. The esbuild-based checks already read `src/` directly.
12. **Retire→reprocess regression.** `npm run test:pipeline` now seeds a stale wrong
    cached headline for a fixture article, runs the real refresh with the mock model,
    and asserts the wrong headline is never served while the article is reprocessed
    under the active policy and replaced by the verified rewrite (same daily budget).
13. **Deploy-migration regression made faithful.** `npm run test:retirement` now seeds
    the actual pre-correction bootstrap state — `rewriteFingerprint`
    `<model>:editorial-v2` and a snapshot with no `policyFingerprint` — and still
    proves the reported success→failure headline is retired to its original on first
    serve, with no inference available.

## Verified (2026-10-13, iteration 2-5)

8. **Interactive/keyboard QA.** New `scripts/interaction-check.js`
   (`npm run test:interaction`) drives the local build in headless Chromium over the
   DevTools Protocol against a dedicated fictional fixture (100 articles). It sends
   real `Tab` key events and proves every primary control is keyboard-reachable
   (skip link, brand, about link, search, source/category selects, filter submit,
   both order buttons, load-more, an article link), then exercises the source and
   category filters, the chronological toggle (descending `dateTime`), explicit
   load-more pagination without duplicate rows, and the rendered error/retry state
   when `/api/news` is blocked. Passes locally; README documents the command.

9. **Real-article extraction defects found and fixed.** Ran `readArticleData`/
   `prepareContext` against live accessible pages (ynet, mako/N12, kan) under workerd.
   Two concrete defects: (a) `element.onEndTag` threw `Parser error: No end tag.` for
   self-closing foreign elements (SVG `<path>`), aborting extraction on real pages —
   every kan article failed; end-tag registration is now guarded so such elements are
   treated as having no subtree. (b) Bot-mitigation interstitials (Radware: "made us
   think that you are a bot") and thin client-rendered shells (kan: 42-char nav text)
   were marked `complete` and would have been fed to the model; `prepareContext` now
   treats known challenge/denied text and bodies under `MIN_CONTEXT_CHARS` (120) as
   `missing`, preserving the original. `CONTEXT_POLICY` is bumped to `full-text-v2`, so
   rewrites grounded on the old extraction are retired by the existing fingerprint path.
   Measured after the fix: ynet 3075 chars `complete`; mako/N12 block pages and kan
   shells `missing` (no crash). A further sample of six live ynet articles all expose
   JSON-LD `articleBody` (1063–7620 chars, one truncated at the 6000 cap); one is the
   exact second-screenshot article ("האוכלוסייה בישראל רואה את הצפון כצימר לסופ״ש...",
   2688 chars), so the Karmiel/Dimona grounding context is accessible in production.
   Regressions: `test:extract` now includes a self-closing SVG and block/thin cases;
   unit tests cover thin/block handling.

10. **Honest limitation recorded:** kan article pages are client-rendered, so their
    initial HTML body is only navigation (42 chars) — kan keeps original headlines
    under the new policy instead of being fed chrome. Its JSON-LD still supplies the
    headline; categories remain missing (no `articleSection`).

## Verified (2026-10-13, iteration 2-4)

6. **Shared batch sizing fix.** `planBatches` previously sized requests by the
   rewrite model's context window only, so the same full article contexts were then
   sent to `clef-flash` (32,768 tokens) in an oversized verification request — e.g.
   20 articles (~82k tokens) or 9 articles (~37k tokens) in one request. Requests are
   now sized for the **smaller** of the rewrite and validator windows
   (`requestContextTokens`), output space is reserved per article, and the runtime
   plans from the **actual** extracted text length. `scripts/batch-check.js` seeds
   nine full-text articles and proves they split into multiple requests with every
   verification inside the validator window; `npm run test:batch` passes.
7. **Interactive-QA API coverage.** `scripts/smoke.js` now also checks category
   filtering, `order=latest` chronology, offset pagination (non-overlapping pages)
   and the summary-only `/api/status` shape, alongside the existing source/search
   filters and error codes.

## Verified (2026-10-13, iteration 2-3)

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
   served even with no inference available. `scripts/pipeline-check.js` runs the real
   refresh/rewrite/verify/budget flow against a deterministic mock model, proving
   independent acceptance/rejection, cached decisions (no re-inference on a second
   refresh), the usage ledger and budget deferral.
4. **Adaptive daily budget.** `src/budget.js` replaces the 8/hour and 1024-token
   caps with token-budgeted batches sized from full-text input, model context and a
   persisted reservation against `DAILY_NEURON_BUDGET` (default 6000 of the shared
   10,000/day), reconciled with provider usage and deferred instead of overspending.
   `MAX_CONTEXT_FETCHES` (20) keeps page fetches inside subrequest limits. Accepted
   rewrites and source-grounded rejections are cached by policy+source fingerprint,
   so neither inference is repeated for unchanged articles.
5. **Regressions.** Exact reported success→failure reversal (heuristic + Clef
   rejection), the Karmiel/Dimona material-context case (omitted speakers fail;
   faithful rewrite accepted), cross-article independence, cross-article fact mixing
   on both the rewrite and verification paths, and stale-cache retirement are all
   covered.

Latest full validation (iteration 2-10): `npm run check`, **55 unit tests**,
`npm run build`, `npm run test:worker`, `npm run test:extract`, `npm run test:retirement`,
`npm run test:pipeline` (mock model end-to-end + retire/reprocess), `npm run test:batch`
(validator-window splitting, budget-aware reduction and the documented clef decision
schema), `npm run test:browser` and `npm run test:interaction` all pass. The new
confident-yes boundary regression was shown to fail against the previous `0.5` boundary
and pass after the fix.

Live re-check (iteration 2-9): four live ynet article pages and two live mako article
pages extracted `complete` bodies (1,872–7,620 chars, one truncated at the 6,000-char
cap) with JSON-LD headlines/sections; kan article pages remain client-rendered shells
(42 chars → `missing`, original kept). A full live refresh (real feeds, mock model)
ingested 126 articles across ynet/kan/n12/mako, all `ok`, with real full-text context.

## Blocked / needs input

1. **Cloudflare deployment unverified.** No Cloudflare credentials or account access
   in this environment; the existing Worker name, build/deploy commands, routes and
   deployed URL could not be inspected. Reconcile `wrangler.jsonc`
   (`positivity-bias`) with the connected Workers Builds Worker once access is
   available. Do not create a parallel deployment.
2. **Live inference unverified.** Workers AI Hebrew quality, the `AI` binding and real
   neuron use remain unmeasured. Mocks/fixtures prove wiring and fallbacks only. Switch
   the default to Qwen3 only after measured live checks. Do not interpret a passing
   fixture as successful production inference. Real-article extraction was re-exercised
   against live pages in iteration 2-9; mako/N12 now served extractable pages, kan
   remains a client-rendered shell.
   Iteration 2-9 fixed the clef-flash integration: the verifier now uses the documented
   decision schema (`state` + typed `noul` questions → `answers[*].noul`) instead of a
   chat envelope, and the 24,576-token window / input-only pricing are used. A live
   account is still needed to measure the *quality* of clef's yes/no probabilities and
   real neuron use; the request/response contract now matches the published schema.
   Evidence for the Qwen3 switch (iteration 2-6, docs/schema check): Cloudflare's
   Qwen3 page documents `response_format` and exposes `choices.message.reasoning_content`,
   and workerd's bundled AI types declare `chat_template_kwargs` for gpt-oss but not for
   Qwen3, so thinking-off currently relies on the Qwen `/no_think` soft switch plus a
   best-effort `chat_template_kwargs`. A live call must confirm which option the account
   honors before the default is switched; both parser paths (chat `choices` and text
   `response`) are already covered.
3. **Interactive QA.** Keyboard traversal, filter/order/pagination interaction and
   the rendered error/retry state are now covered by `npm run test:interaction`
   (see iteration 2-5). Render checks at 390×844 and 1440×1000 passed previously.
   CI (`ci.yml`) still runs only `npm run check && npm test && npm run build`; adding
   the workerd/browser checks to CI is a workflow change for the maintainer.
4. Kan JSON-LD has no `articleSection`, so Kan categories remain missing by policy.

Steering goes through `PROMPT.md`; further implementation belongs to Shurik.
