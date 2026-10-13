# Current state

- Hebrew RTL news Worker on `main`: configurable source registry; RSS/Atom and Kan
  news-sitemap adapters; category/source rotation; hourly ingestion; SQLite Durable
  Object storage; guarded Workers AI rewrites with originals preserved.
- Chosen name: **במבט**. English subtitle removed from the visible header/logo.
- Sessions/control are on `shurik-control/main`. The user stopped Shurik and the
  hourly Codex checkup on 2026-10-13; both remain stopped.

## Rewrite coverage and UI (2026-10-13)

- Three grounded alternatives per article; native Clef Flash choice plus separate
  factual/material-context checks for each option in the same call, explicit original
  fallback, stable option IDs, 0.7 factual-check guard and strict response checks.
  Unchanged echoes cannot count as conversions. Fingerprints retire prior decisions.
- Finite backlog continuation (at most 32 chunks per edition), persisted attempts,
  a shared 48-request guard with native AI slots reserved, and a day-long inaccessible-body cooldown; at most four full HTML fetches at once.
  No repeated model attempts within an edition; daily budget remains 6,000 neurons.
  Unknown provider usage retains reservations. Status reports actual full-feed coverage.
- Originals use quieter readable typography; authored UI glyphs replaced with SVG
  icons and CSS shapes. Responsive interaction checks pass.
- Local validation: 72 unit tests; syntax/build; pipeline, shared-window/budget and
  28-article continuation fixture (24 rewritten, 4 inaccessible, zero retries), malformed-batch isolation and concurrent refresh/continuation handling.
- Live rollout and real conversion/quality measurement pending. The 90% target is
  not yet verified; source access limits continue to preserve originals.

## Live-site repair (2026-10-13)

- Fixed refresh windows around the existing minute-7 cron. A reader refresh no longer
  suppresses the following tick; failed attempts and policy-repair recovery remain
  serialized and bounded, with the same 6,000-neuron project budget.
- Fixed native Qwen structured output: explicit JSON schema, short request-local IDs,
  restored article identity and a raw chat prompt with a closed thinking prefix.
  Complete alternate-channel schema output remains only a candidate; prose/truncation
  is rejected. Clef Flash is the only executable validator. Source originals, full
  transient grounding, and the outcome/material-context regressions are preserved.
- Direct live verification at 19:37 UTC: all four feeds healthy (ynet 115, Kan 8,
  N12 74, mako 62), zero feed errors; both rewrite batches completed, all 10 usable
  contexts answered, all 6 proposed titles evaluated by native Clef, 1 accepted,
  failureStage=null and rewriteStatus=ok. The public archive contained 217 unique
  articles with the accepted title displayed and its original preserved.
- Added bounded page rechecks while a refresh is running, so its completed result
  appears without manual reload. Polling stops on completion and preserves draft
  searches. Status exposes contract versions and counts without private model text.
- Verification: 73 unit tests, syntax/registry checks, dry-run Worker build, smoke,
  rewrite/budget pipeline, batch splitting, retirement, keyboard/filter/sort/pagination
  and error/retry checks; browser refresh/draft-search regression checks passed.
- Shurik and the hourly Codex checkup remain stopped at the user's request.

## Verified (2026-10-13, iteration 2-17)

35. **A Qwen3 reasoning wrapper around the JSON answer was treated as unparseable.**
    Qwen3 is now the default rewrite model and it is a reasoning model: its chat template
    emits a ` thinking...` block even when thinking is disabled (Qwen documents this), and
    Workers AI normally returns the reasoning in a separate `reasoning_content` field. If
    the wrapper instead arrives inline in `choices[].message.content`, the previous JSON
    extraction began at a brace inside the reasoning and returned null, so every rewrite
    was reported as `invalid_response` and no headline was ever produced. `parseJsonObject`
    now strips a paired reasoning block before JSON parsing, so a reasoning wrapper (empty
    or containing braces) can never hide the result; a truncated reasoning-only answer is
    still unparseable and keeps the preserved original. No editorial/grounding policy
    changed, so no fingerprint bump and no rewrite retirement. Verified: two new unit
    tests (a braces-in-reasoning wrapper and an inline-wrapper rewrite-batch acceptance)
    and the `npm run test:pipeline` Qwen3 mock now returns its answer inside an inline
    reasoning block; all three were shown to fail against the pre-fix parser
    (`invalid_response`) and pass after it. 65 unit tests pass.

36. **A partial snapshot article missing `categories` crashed the whole site.**
    `coverageOrder` (used by every refresh and by API ordering) read
    `article.categories[0]`, and `/api/news` read `article.categories.includes(...)`,
    `articles.flatMap((article) => article.categories)` and the client
    `article.categories.join(...)`. A partial/corrupted snapshot that lost an article's
    `categories` field therefore threw and turned the whole `/api/news` response into a
    503 (and the refresh into a failure) instead of serving the preserved article.
    `coverageOrder` now reads `article.categories?.[0]`, the API treats a missing list as
    empty (filter, category options and the per-article `categories: []` it returns) and
    the client renders an empty list. Valid articles (including Kan's genuinely empty
    category list) are unchanged. Verified: a new unit regression and a
    `npm run test:retirement` seed of an article with no `categories`, both shown to fail
    against the pre-fix code (TypeError / 503) and pass after it. 66 unit tests pass.

37. **Live full-text extraction re-measured on real publisher pages (fresh run).**
    Real feeds ingested `ok`: ynet 115, kan 8, n12 74, mako 61 (publisher categories
    preserved). Sampled article bodies: ynet 3/3 `complete` (884–2,155 chars), kan 3/3
    `complete` (2,228–2,841) and N12 3/3 `complete` (1,872–4,487). Mako was 1/3
    `complete` (3,911) and 2/3 `missing` because the publisher answered with a Radware
    `validate.perfdrive.com` challenge, correctly refused as `unapproved_redirect` (the
    pipeline does not follow bot challenges and keeps the preserved original). Context
    completeness stays transient and is never persisted or exposed.

## Verified (2026-10-13, iteration 2-16)

33. **Default rewrite model switched to the available low-cost Qwen3.** Cloudflare's
    catalog no longer lists `@cf/meta/llama-3.1-8b-instruct-fp8-fast` (its docs page now
    redirects to `/workers-ai/models/?unavailable=llama-3.1-8b-instruct-fp8-fast`), so
    the configured default could not rewrite anything in production. Per the steering
    ("switch after the concrete regression/factual checks pass" — they pass),
    `DEFAULT_REWRITE_MODEL` and `wrangler.jsonc`'s `REWRITE_MODEL` are now
    `@cf/qwen/qwen3-30b-a3b-fp8`. The old Llama slug is kept as `LLAMA_REWRITE_MODEL` in
    the cheap allowlist and the planning window/rate tables, so it remains a valid
    explicit override. Qwen3's chat envelope and thinking-off option were already
    handled. The model is part of the policy fingerprint, so rewrites produced under the
    old model are retired at read time and reprocessed progressively under the same
    daily budget. Verified end-to-end under workerd with no `REWRITE_MODEL` env: the real
    Worker chose `@cf/qwen/qwen3-30b-a3b-fp8`, accepted its
    `choices[].message.content` response (with `reasoning_content` present) and verified
    it with `@cf/cloudflare/clef-flash`. **Live Hebrew-quality and neuron-use measurement
    against the account is still pending**; a candidate the guard or clef cannot
    confidently accept keeps the preserved original. `npm run test:pipeline` now also
    runs a refresh with no `REWRITE_MODEL` env and asserts the Worker called
    `@cf/qwen/qwen3-30b-a3b-fp8` and accepted its chat-shaped response.
34. **Live validation re-run (real feeds, no AI binding).** A real workerd refresh
    ingested all four sources `ok`: ynet 115, kan 8, n12 74, mako 61, with publisher
    categories preserved (12 distinct labels). A fresh live extraction sample: ynet
    12/12 `complete` (854–5,832 chars); kan 8/8 `complete` (1,758–3,361), including the
    exact reported drone-test article (defense/1108988, 1,680 chars, "הניסוי, שנערך
    בהצלחה"); mako/N12 mostly `missing` because the publisher served a Radware
    `validate.perfdrive.com` challenge (correctly refused as `unapproved_redirect` — the
    pipeline does not follow bot challenges). Context completeness stays transient and is
    never persisted or exposed.

## Verified (2026-10-13, iteration 2-15)

32. **Live Kan article bodies were silently dropped by an over-broad noise wrapper.**
    The body extractor treats any element whose class/id contains a noise token
    (`nav`/`navigation`/`menu`/`share`/`related`/...) as removable and suppresses its
    whole subtree with a `skipDepth` counter. Live Kan pages wrap the entire page,
    including `<main>`, in `<div class="row navigation">`, so `skipDepth` stayed above
    zero for the whole article and every Kan article extracted as a 42-char navigation
    shell (`missing`) — including the exact reported drone-test article. Entering a
    non-noise `<main>` now suspends the inherited skip depth and leaving it restores that
    depth, so the primary content region is authoritative while noise INSIDE `<main>`
    (ads, sharing, related) and a recommendation `<article>` nested under a noise
    `<aside>` are still removed. Measured on live pages: Kan defense/politic/global
    articles now extract `complete` 1,680/1,919/2,364-char bodies (was 42 → `missing`),
    including the drone-test article ("הניסוי, שנערך בהצלחה"); ynet (4,262/2,213) and
    mako (1,872) extraction is byte-for-byte unchanged. `CONTEXT_POLICY` is bumped to
    `full-text-v3`, so rewrites grounded on the older extraction are retired at read
    time and reprocessed progressively under the same daily budget. New `npm run
    test:extract` fixture (a noise-named layout wrapper around `<main>`) was shown to
    fail pre-fix (`missing`) and pass after it; all other checks pass.

## Verified (2026-10-13, iteration 2-14)

30. **A clef response that decided NONE of the candidates was reported as a healthy
    `ok`.** `verifyBatch` computed its batch `status` only from `accepted.size`, so a
    validator that returned no usable `noul` answer for any candidate (e.g. an empty
    `answers` object after a schema/provider drift) still looked like a definitive
    rejection, and `rewritePending` then reported the whole refresh as `ok` with zero
    rewrites — the same honesty defect fixed for the rewrite model in 2-12. `verifyBatch`
    now returns an `evaluated` set of the candidates it actually decided (a definite yes
    or no), and the worker flags `invalid_response` when candidates were submitted but
    the validator decided none of them. Ambiguous answers keep the preserved original and
    are retried (not cached); a legitimate rejection of every candidate is unchanged.
    New unit regression (the pre-fix code had no `evaluated` and looked like a rejection)
    and a `npm run test:pipeline` `MOCK_VALIDATOR: empty` case (shown to fail pre-fix with
    `ok` and pass with `invalid_response`, originals preserved and retried).
31. **The model table under-stated the non-flash clef cost ~6.3x and had two wrong
    Llama windows.** Re-checked every entry against the live Cloudflare model pages and
    pricing (2026-10-13): `@cf/cloudflare/clef` is 65,536 tokens and 21,818 neurons/M
    input (not 24,576 / 3,455), `llama-3.2-1b` is 60,000 tokens (not 128,000) and
    `llama-3.2-3b` is 80,000 (not 128,000). All rates are now the published per-million
    neuron counts (llama-3.1-8b-fp8-fast 4119/34868, qwen3 4625/30475, clef-flash 3455
    input-only, clef 21818 input-only), so an allowed validator can no longer be
    under-reserved against the shared 10,000-neuron/day allowance. A new unit test pins
    every window and rate and asserts the non-flash clef is never cheaper than flash.

## Verified (2026-10-13, iteration 2-13)

28. **A cached rejection could be served as a generated headline labelled "original".**
    `retireStaleRewrites` trusted any `rejected` article whose policy fingerprint and
    `rewriteSource` matched the active policy, without checking that its stored
    `headline` was actually the preserved original. A partial/corrupted/legacy snapshot
    could therefore leave `rejected` carrying a generated headline; the public API maps
    every non-`rewritten` status to `original`, so the visitor would see the rewrite as
    if the publisher had written it, with no original-headline disclosure. A cached
    rejection is now trusted only when it carries the preserved original headline
    (`showsOriginal`); anything else is retired to the original like any stale rewrite.
    The restore step also keeps an existing headline when a malformed snapshot has no
    original to restore, so nothing is blanked. New unit regression (`60` unit tests)
    and a `npm run test:retirement` seeded current-fingerprint rejection with a generated
    headline: both were shown to fail against the pre-fix trust condition (the generated
    headline was served) and pass after it, while a genuine cached rejection
    (`headline === originalHeadline`) is still trusted and never re-inferred.
29. **Live full-text extraction re-measured on real publisher articles (fresh run).**
    Real feeds ingested `ok`: ynet 115, kan 8, n12 74, mako 61. Sampled contexts:
    ynet `complete` 1,920/2,384/2,688 chars, N12 `complete` 4,487, mako `complete` 908;
    a sampled mako request was answered with a Radware `validate.perfdrive.com`
    challenge and correctly refused (`unapproved_redirect`, original kept — the pipeline
    does not follow bot challenges). The live kan feed contains the exact reported
    drone-test headline (`...השלימה בהצלחה ניסוי במל״ט שמצויד במקלע`, kan-news/defense/1108988),
    but kan article pages are client-rendered shells (42 chars → `missing`), so that
    article keeps its preserved original rather than being rewritten from chrome.
    (Superseded by 2-15: the noise-wrapper fix now extracts a complete Kan body.)
    Context completeness stays transient and is never persisted or exposed.

## Verified (2026-10-13, iteration 2-12)

26. **A model omission was cached as a source-grounded rejection.** `rewritePending`
    cached a rejection for every non-accepted article whenever the batch status was
    `ok`/`partial`/`rejected`, even though its own comment promised to cache only
    "source-grounded rejections". When the model returned fewer items than requested
    (`partial`), the omitted articles were marked `rejected` with a matching
    `rewriteSource`, so `needsRewrite` skipped them forever and they were never retried.
    `rewriteBatch` now reports the `evaluated` ids it actually answered and `verifyBatch`
    reports the ids with a *definitive* clef no (`rejected`) separately from accepted and
    from missing/ambiguous answers; the worker caches a rejection only for a guard-rejected
    answered item or a definitive clef no, and keeps+retries everything else. No trusted
    rewrite changes meaning, so no fingerprint bump was needed. Unit regressions cover the
    omission and the ambiguous-answer split; `npm run test:pipeline` now runs a `partial`
    mock that drops one article, proves the omitted article stays `original` (not cached)
    and is rewritten on the next refresh. Both new assertions were shown to fail against the
    pre-fix loop (omitted article served as `rejected`, zero retry calls) and pass after it.

27. **A parseable-but-empty model response was reported as a healthy `ok`.** The
    unparseable-response fix (2-10) only caught invalid JSON; a response that parsed to
    valid JSON with no usable items (the model answered none of the requested articles,
    or answered with unmatched ids) still set the snapshot `rewriteStatus` to `ok` while
    nothing was rewritten, hiding a silently failing pipeline. The run now also tracks
    `invalid_response` when a `rejected` batch evaluated (answered) zero of its articles.
    Unit regression covers the empty-items contract; `npm run test:pipeline` runs an
    `empty` mock and asserts `invalid_response` with untouched originals and no cached
    rejections. The integration assertion was shown to fail (`ok`) against the pre-fix
    status logic and pass after the fix.

## Verified (2026-10-13, iteration 2-11)

23. **Headline-less trusted rewrite could still be served.** `retireStaleRewrites`
    trusted any article whose `rewriteFingerprint` matched the active policy and whose
    `rewriteStatus` was `rewritten`/`rejected`, so a partial/corrupted snapshot that kept
    the current fingerprint/status but lost the generated `headline` was still served with
    `headline: undefined` (the API omits the key, so the client rendered an empty link).
    The decision is now trusted only when it carries a usable (non-empty string) stored
    headline; a headline-less decision is retired to the preserved original and queued for
    reprocessing. New unit regression fails against the pre-fix early return and passes
    after it; `npm run test:retirement` seeds a current-fingerprint headless `rewritten`
    and an empty-headline `rejected` article into the real Worker and proves both are
    restored on serve while a genuine current rewrite is still kept (shown to fail
    pre-fix).
24. **Clef and Qwen3 request/answer contracts re-verified against the live docs.**
    Fetched `schema-input.json`/`schema-output.json` and the model pages: clef requires
    `{ model: "clef-flash", state, questions }` (1–64 typed questions; `noul` answer is an
    object `{ type: "noul", noul: 0..1 }` keyed by question id; `usage` carries
    `input_tokens`/`output_tokens`; 24,576-token window, input-only billing). The verifier
    matches this exactly. Qwen3 (`@cf/qwen/qwen3-30b-a3b-fp8`) documents 32,768 tokens and
    $0.0509/M in, $0.335/M out (matching `MODEL_NEURON_RATES`); no documented
    thinking-off parameter, so the `/no_think` soft switch plus best-effort
    `chat_template_kwargs` remains the approach.
25. **Live refresh re-measured (real feeds, mock model, no credentials).** 127 articles
    ingested, all four sources `ok`: ynet 115, kan 8, n12 74, mako 61. Sampled rewrite
    contexts were `complete` (ynet 876–2688, N12 1872–4080, mako 3196–3911 chars) with two
    mako articles `truncated` at the 6,000-char cap; no bot-block or extraction failure.
    Context completeness stays transient (never persisted or exposed).

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

22. **Unparseable model output is no longer reported as a healthy rewrite.** When the
    rewrite model returned JSON that could not be parsed, the refresh kept the originals
    (correct) but still recorded the snapshot `rewriteStatus` as `ok`, so a silently
    failing pipeline looked healthy. The run now tracks `invalid_response` and reports
    that status when nothing was accepted; originals are preserved and no rejection is
    cached, so the articles are retried on the next refresh. `npm run test:pipeline`
    seeds a mock that returns unparseable output and asserts the honest status, zero
    verification calls and untouched originals; the assertion was shown to fail (`ok`)
    against the pre-fix status logic and pass after it.

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
    under the new policy instead of being fed chrome. (Superseded by 2-15: a
    noise-named layout wrapper was suppressing `<main>`; Kan now extracts a complete
    body and is rewritten normally.) Its JSON-LD still supplies the
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

Latest full validation (iteration 2-17): `npm run check`, **66 unit tests**,
`npm run build`, `npm run test:worker`, `npm run test:extract`, `npm run test:retirement`,
`npm run test:pipeline`, `npm run test:batch`, `npm run test:browser` and
`npm run test:interaction` all pass, plus an end-to-end workerd run proving the new
default `@cf/qwen/qwen3-30b-a3b-fp8` is selected without `REWRITE_MODEL` and its
chat-shaped response (returned inside an inline Qwen3 reasoning wrapper) is accepted and
clef-verified (also asserted in `npm run test:pipeline`). Iteration 2-17 fixed the
inline-reasoning-wrapper parse failure and the missing-`categories` serve crash (both
shown to fail pre-fix, pass after). Prior
iteration 2-15 covered the noise-named layout-wrapper extraction regression (shown to
fail pre-fix, pass after); iteration 2-14 added the current-fingerprint generated-headline
rejection serve-time regression and the clef-decision-invariant unit/pipeline regressions.

Live re-check (iteration 2-15): a 20-article live sample across ynet (news/sport/
/economy), mako (culture) and Kan (politic/global/local) measured: ynet 12/12 `complete`
(854–5,202 chars), Kan 4/4 `complete` (1,960–2,364 chars, was a 42-char shell),
including the exact reported drone-test article, and mako 4/4 `missing` because the
publisher served a Radware bot challenge (544 chars, correctly refused — the pipeline
does not follow challenges). Kan still exposes no `articleSection`, so its categories
remain missing by policy.

## Remaining limits

- Cloudflare Workers Builds and direct public responses now verify deployment and
  successful native Qwen/Clef inference. Direct account logs and billing totals are
  unavailable here; the existing project budget remains enforced.
- The concrete editorial regressions pass. Broader Hebrew editorial-quality review
  and account-wide neuron measurements remain separate from functional verification.
- Worker/browser runtime checks pass locally. CI still runs syntax/unit/build checks;
  changing that workflow is outside this repair.
- Kan exposes no `articleSection`; its categories remain missing by publisher policy.

Shurik and its hourly supervisor are stopped. Future work requires a new user request.
