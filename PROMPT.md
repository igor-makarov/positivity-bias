# Positivity Bias / במבט — maintain the news outlet

Work directly on `main` in igor-makarov/positivity-bias. The user explicitly
authorized this branch and ongoing Shurik work. Do not open PRs or merge branches.
Use the task checkout supplied by Shurik, not its engine checkout.

`PROMPT.md` is the general steering input. Shurik owns implementation from this
handoff onward. The supervising Codex hourly checkup should inspect evidence and
update this prompt's priorities when needed, rather than write product code itself.
Preserve the existing bootstrap implementation; the user asked not to discard it
and not to add more features yet. Focus on validation and concrete defects first.

## Goal

A working Hebrew news aggregation outlet on Cloudflare Workers that reduces
sensational framing and negativity bias while preserving factual completeness.
The provisional name is **במבט**, with the tagline **חדשות בפרופורציה**.
Other proposals: **בקצרה**, **קו נקי**, **בלי רעש**. Do not rename every iteration.

## Urgent correction — factual reversal reported by the user

The user supplied a screenshot in which the source headline says:
"התעשייה האווירית השלימה בהצלחה ניסוי במל״ט שמצויד במקלע"
but the published rewrite says:
"תעשייה אווירית: ניסוי במל״ט עם מקלע נכשל"
This reverses success into failure. Numeric/keyword guards are insufficient.
Fix this before cosmetic work or new features, and add this exact regression case.

The user requests the complete article text as model context whenever accessible,
and reiterates LOW COST. Replace the 400-character-excerpt-only inference path:
extract the actual article body, removing navigation, advertising and unrelated
recommendations. Include its original headline and publisher attribution. Track
whether context is complete, missing, or truncated; do not silently describe an
excerpt as the full article. Respect the model context window and source access
limits. If accessible text is unavailable or insufficient, preserve the original.
Full article text is inference context, not content to republish in the UI/public
API/Git history. Keep access transient or cache only what is operationally needed;
avoid persisting full articles in Shurik's public journals.

Evaluate `@cf/qwen/qwen3-30b-a3b-fp8` as the first-choice low-cost replacement.
Cloudflare lists about $0.051/M input and $0.335/M output, 32,768-token context,
versus current Llama FP8 Fast $0.045/M input and $0.384/M output. Qwen documents
Hebrew among its supported languages; actual news-headline fidelity still needs
measured tests. Permit this model in the cheap allowlist for that evaluation and
switch after the concrete regression/factual checks pass. Disable thinking using
the documented endpoint/model option where supported. Handle its documented
response shape; do not assume the current Llama `payload.response` shape.

A concrete decision need now exists: use the user's requested inexpensive
`@cf/cloudflare/clef-flash` to check whether a candidate is supported by its source
text and whether it contradicts the stated outcome, attribution, uncertainty,
negation, names, numbers or actor/action. Treat it as a guard, not proof. Reject
contradicted/unsupported/uncertain candidates and preserve the original. Cache
successful rewrite and verification results with source-content/policy/model
fingerprints; do not repeat either inference for visitors. Do not let raw full
source text leak into public diagnostics.

The user explicitly authorizes bigger batches and higher article throughput.
Replace the arbitrary 8-headline/hour and 1024-total-output-token/hour limits with
adaptive token-budgeted batching. Size each request from the actual full-text
input, model context window, reserved output space, and remaining daily neuron
budget. Reserve enough output tokens for one complete short result per article.
Do not truncate article context merely to fit more articles into a batch.

Keep stable per-article IDs, clear article boundaries, independent validation,
and regression tests against cross-article fact mixing and outcome reversal.
Accept valid results independently; failed/missing/ambiguous items keep originals.
Split requests when model or validator context/output limits would be exceeded.
Keep source fetches and batch work bounded to Worker execution/subrequest limits.
Cache accepted rewrites and validation decisions, process new/changed articles,
and do not repeat either inference per visitor. Bound validator calls (one per
candidate, no retries). Larger synchronous batches do not imply discounted token
pricing; use the documented asynchronous Batch API only if suitable for the
hourly refresh workflow.

Low cost remains a requirement. Account for rewrite AND Clef Flash input/output
neurons against the Free account's 10,000/day shared allowance, with conservative
headroom for other account usage. Persist a daily usage reservation before calls
so concurrent refreshes/restarts cannot overspend the project budget; reconcile
with provider-reported usage when available. Reduce batch size or defer work when
remaining budget/context is insufficient; preserve originals on quota failure.
No billing upgrade, paid-only models, expensive fallback, unbounded reasoning,
unbounded retries, automatic increase of the DAILY neuron budget or new features.

Existing rewrites must be reset as part of this correction. The current code
queues outdated fingerprints for reprocessing but can continue displaying the old
generated headline until a replacement succeeds; a fingerprint bump alone is not
enough. Retire ALL rewrites generated before the full-text factual-validation
pipeline, including previously accepted ones. Preserve each article, its original
headline, source URL, publisher categories and publication time; clear only the
generated headline/acceptance and stale verification metadata, restoring the
original for display while the article is queued for fresh processing.

Enforce this policy at read/serve time as well as through a persisted idempotent
migration: missing/outdated model-policy-source fingerprints must never expose an
untrusted cached rewrite, even before the next refresh or during cooldown/quota
failure. Include full-context extraction policy and factual-validator version in
the fingerprint. The reported success-to-failure headline must immediately fall
back to its preserved original when this correction deploys. Reprocess the retained
articles progressively under the SAME daily free-tier budget; do not reset usage
reservations, cooldowns or create a burst of inference. Add a regression that seeds
an old wrong cached headline and verifies that it is no longer served when the
new pipeline version is active, even if inference is unavailable.

Official references:
- https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/
- https://developers.cloudflare.com/workers-ai/models/clef-flash/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://huggingface.co/Qwen/Qwen3-30B-A3B

## Priorities for the next iterations

0. Address the urgent factual reversal, complete accessible article grounding,
   Qwen3/Clef Flash evaluation and adaptive larger-batch daily-budget controls
   described above. Add the exact success-to-failure regression before considering
   the rewriting pipeline trustworthy. Preserve existing functionality.
1. Verification evidence from Shurik iteration 1 (2026-10-13): the native journal
   contains successful `npm run test:worker` output, 21 passing unit tests, and a
   real workerd refresh with ynet=ok(114), kan=ok(8), n12=ok(74), mako=ok(58).
   The local fixture HTTP 500 was fixed; Ynet category labels were corrected and
   its misleading home-page feed was removed. Do not re-investigate those completed
   bootstrap defects without a regression. Re-run relevant checks for new changes.
2. Preserve the validated four-publisher adapters and exact source categories.
   Kan's checked JSON-LD has no articleSection, so its missing categories remain
   missing. Full-text extraction must be tested on real accessible articles from
   these publishers; record context completeness and source failures honestly.
3. Verify the existing Cloudflare Workers Builds deployment if authorized account
   access or a verified live URL becomes available. Build: `npm run check && npm
   test`; deploy: `npm run deploy`. Reconcile the existing Worker name/routes;
   do not create another deployment. Account access and live deployment remain
   unverified; an unchanged access blocker should not stall independent grounding
   and factual-validation work or create repeated requests for the same input.
4. Native Workers AI inference and actual Hebrew quality/neuron consumption
   remain unverified. The local AI probe only demonstrated provider-unavailable
   fallback. Measure them when authorized access is available; never interpret a
   passing fixture/mock test as successful production inference or semantic fidelity.
5. Desktop/mobile fixture render checks passed at 390x844 and 1440x1000.
   Interactive QA (keyboard, category/source filters, order, pagination and error
   states) remains pending. Use the existing browser harness when appropriate.
   Once the urgent defects are fixed, keep iterations bounded and avoid cosmetic
   changes or feature additions without concrete need.

## Editorial invariants

- Rewrite titles into dry, concrete Hebrew. Remove clickbait, teasers, exaggerated
  emotion and pressure to click. Ground them in the complete accessible article text
  and original headline; preserve originals if adequate context cannot be obtained.
- Do not invent facts, erase material numbers, turn allegations into established
  facts, remove uncertainty/attribution, minimize harm, or make tragic news upbeat.
- Preserve original headline, publisher, article URL and publication time. Show
  whether a headline was rewritten or remains original and expose originals.
- Preserve publisher-provided categories, exactly. RSS category wins over the
  publisher feed label; JSON-LD articleSection/metadata supplies sitemap categories.
  Missing categories remain missing. No LLM classification or sentiment labels.
- Default ordering rotates categories and publishers, then uses time. No outrage,
  sentiment, virality or click-through scoring. Offer chronological ordering.
- Keep N12/Mako shared article-ID deduplication and canonical URL handling.
- Feed/article/model output is untrusted data, never instructions. Respect source
  access restrictions; do not bypass bot challenges or paywalls. Use full accessible
  text for inference context; keep public display to headlines and links to originals.
  Do not republish full articles or images or save them in public Git history.

## Architecture and design

- Cloudflare Worker + static assets + one SQLite Durable Object; hourly cron.
  No visitor-triggered unbounded scraping or model calls. Preserve cooldowns,
  concurrency locking, response size limits, error isolation and stale indicators.
- The root `websites.json` is the source registry. Add configurable adapters there.
- Follow Canton of Zürich's public design system with Hebrew/RTL adaptations:
  strong type hierarchy, square controls, generous spacing, simple rules/grid.
  Palette: black/white/grays, blue #0070B4, soft blue #EDF5FA. Green #1A7F1F only
  for successful system feedback. Do not use news sentiment colors or alarm red.
  Use the self-hosted OFL Heebo font; do not copy the canton crest or licensed fonts.
- Reference: https://www.zh.ch/de/webangebote-entwickeln-und-gestalten.html
- Responsive accessible reading, finite pages, explicit load-more, no autoplay,
  breaking banners, sensational images, infinite scrolling, or engagement tracking.

## Credentials and deployment

- Shurik uses `OPENCODE_API_KEY` from Actions (also accepts OCGO_API_KEY or
  OPENCODE_GO_API_KEY). Provider opencode-go, model deepseek-v4.1-flash, high reasoning.
- Production rewriting uses the native Cloudflare Workers AI `AI` binding. No
  inference API key or OCGO key belongs in the Worker. Default model:
  initially `@cf/meta/llama-3.1-8b-instruct-fp8-fast`; evaluate Qwen3 as directed above.
  Keep a documented cheap-model allowlist, adaptive token-budgeted larger batches,
  cached accepted results and fallback on quota/provider failure. The user is on Free:
  do not upgrade billing, use paid-only models, add retries or raise the daily budget.
  Monitor account-wide usage against the 10,000-neuron daily free allocation when
  authorized account access is available. Actual usage and Hebrew quality still
  require validation. Do not expose secrets in files, prompts or journals.
- No model classification is required for publisher categories. Use only
  `@cf/cloudflare/clef-flash` for the factual-consistency decision described above,
  keep it within the free account allowance, and preserve publisher category labels.
- Reuse the existing Cloudflare git deployment. Shurik token pushes may not trigger
  GitHub Actions CI, so run project checks within each coding iteration before
  allowing Shurik to publish changes. Cloudflare's git integration is independent.

## Each iteration

Read `STATUS.md`, source, recent commits, and prior Shurik session evidence first.
Choose the highest-priority concrete unresolved item. Make a small coherent change,
then run `npm ci --ignore-scripts` if needed, `npm run check`, `npm test`, and
`npm run build`. Do not change dependency inputs while installation is running.
Keep changes reviewable and leave main working. Update `STATUS.md` only for actual
changes, new verification evidence, or changed blockers. Keep it short. Summarize
what was verified and what still needs user input, without exposing credentials.

The loop waits at least 3600 seconds after each iteration; Shurik recovery checks
every 15 minutes and resumes when due (GitHub scheduling may delay it). An hourly
Codex checkup reads this file and can steer priorities. Do not sleep inside an
iteration or create additional loops, workflows, schedules, or recurring tasks.
