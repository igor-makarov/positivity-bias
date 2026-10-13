# Current state

- Hebrew RTL news Worker on `main`: configurable source registry; RSS/Atom and Kan
  news-sitemap adapters; category/source rotation; hourly ingestion; SQLite Durable
  Object storage; guarded Workers AI rewrites with originals preserved.
- Chosen name: **במבט**. English subtitle removed from the visible header/logo.
- Sessions/control are on `shurik-control/main`; iterations continue immediately
  (`wait-seconds: 0`), with a separate hourly Codex checkup.

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

Latest full validation (iteration 2-8): `npm run check`, **50 unit tests**,
`npm run build`, `npm run test:worker`, `npm run test:extract`, `npm run test:retirement`,
`npm run test:pipeline` (mock model end-to-end + retire/reprocess), `npm run test:batch`
(validator-window splitting + budget-aware reduction), `npm run test:browser` and
`npm run test:interaction` all pass. The budget-aware batch and lost-headline
retirement regressions were each shown to fail against the pre-fix logic and pass
after it. (Iteration 2-5 ran the full battery twice.)

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
   Real-article extraction itself has now been exercised against live pages (see
   iteration 2-5); mako/N12 serve a bot challenge to the project User-Agent, so those
   articles preserve originals rather than bypassing the challenge.
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
