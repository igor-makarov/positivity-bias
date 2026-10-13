# במבט

Hebrew news in perspective: publisher categories, dry headlines, links to original
articles, and a broad reading order that rotates categories and sources. Difficult
news remains visible. No sentiment scoring, viral ranking, infinite scrolling,
sensational imagery, or tracking.

The display follows the device's light/dark preference by default. The Hebrew
color-theme selector saves an explicit light/dark override; “לפי המכשיר” resumes
system changes. Storage failures preserve a working session theme.

## Name

The chosen name is **במבט** — a short, memorable Hebrew name for "news in
perspective". Hebrew taglines such as **חדשות בפרופורציה** and
**אותן עובדות, פחות דרמה** carry the editorial promise. No English subtitle is
shown in the header or any visitor-facing branding. This is a product name only;
the repository, Worker and deployment identities are unchanged.

## Development

All application, browser, test and verification-script sources are TypeScript.
Node 24 runs tests and tools directly with native type stripping; separate strict
TypeScript projects check the Worker, browser and tools against their runtime APIs.
Wrangler's build hook compiles `client/app.ts` and `client/theme.ts` into the static
JavaScript assets on every build/deploy, including Cloudflare Git deployments.
Generated JavaScript is ignored in Git.

Node 24+:

```sh
npm ci --ignore-scripts
npm run dev
npm run check        # strict TypeScript checks for Worker, browser, tests and tools
npm test
npm run build
npm run test:worker   # Miniflare runtime check with fictional fixtures (builds first)
npm run test:browser  # shared Chromium render/interaction suite (builds first, needs Chromium on PATH)
npm run test:interaction  # keyboard/interaction QA in headless Chromium (builds first)
```

`test:browser` uses the shared Chromium interaction/render suite. The `dist`-based checks rebuild the bundle first and refuse to run against a
missing or stale `dist/worker.js`, so a runtime check always exercises the current
source rather than an old build. `build` bundles the Worker with Wrangler's dry run;
it does not publish. Live
headlines are never replaced with sample articles. The first request starts a
bounded background refresh; reload after it finishes. Wrangler local development
needs outbound access to the publisher hosts for live aggregation. Additional
workerd checks: `npm run test:worker` (fixtures), `npm run test:extract`
(full-text extraction), `npm run test:retirement` (stale-cache retirement),
`npm run test:pipeline` (mock-model end-to-end), `npm run test:batch`
(validator-window batch splitting) and `npm run test:interaction` (keyboard Tab
traversal, source/category filters, chronological toggle, load-more pagination
the rendered error/retry state, saved/system color themes, text contrast, and responsive widths).

## Cloudflare deployment

Use the existing **Cloudflare Workers Builds** connection to `main`:

- Install: `npm ci --ignore-scripts` (or Cloudflare's lockfile-based default install).
- Build command: `npm run check && npm test`.
- Deploy command: `npm run deploy` (`wrangler deploy`, not Pages deploy).
- Root directory: repository root. Node: 24.
- Worker name: `positivity-bias` in `wrangler.jsonc`; match the existing connected
  Worker if its name is different. Preserve its current routes and custom domain.

The SQLite Durable Object binding and migration are declared in Wrangler and are
created by deployment. No manual D1/KV database IDs are needed. The Worker refreshes
at minute 7 each hour (Cloudflare cron is UTC); public dates use Asia/Jerusalem.
The same Durable Object serializes refreshes and persists one attempt per hourly
window aligned with the minute-7 cron, including after failures. A reader refresh
between ticks cannot suppress the next scheduled tick or cause a request storm.

This environment did not have Cloudflare account access, so the existing dashboard
commands and deployed URL could not be inspected. `npm run deploy` requires
Cloudflare authentication outside the connected Builds runner.

## Headline rewrites

Rewrites use **Cloudflare Workers AI**, with the native `AI` binding declared in
`wrangler.jsonc`. No inference API key is needed. The Actions OCGO key is only
for Shurik. The inexpensive default is `@cf/qwen/qwen3-30b-a3b-fp8`
(Hebrew support documented, 32,768-token window, lower output price); the previous
default `@cf/meta/llama-3.1-8b-instruct-fp8-fast` is no longer listed in Cloudflare's
model catalog and is retained only as an overridable allowlist entry. The cheap
allowlist also permits Llama 3.2 1B/3B. Expensive or paid-only models are blocked.
Qwen3's thinking phase is disabled and its chat-style response envelope is handled;
native live inference has been measured, but model scores do not establish factual accuracy.

Each refresh fetches the **full accessible article text** for the candidates it can
afford, strips navigation, advertising and unrelated recommendations, and passes the
publisher, original headline, publication time and body (marked complete, truncated
or missing) to the model. The editorial prompt requires the primary point and its
material context — actor/speaker, action, geographic scope and result — and never
reverses an outcome. Missing context keeps the original headline.

The rewrite call proposes three distinct dry alternatives per article. The first
preserves the original factual clauses with minimal editing. Where possible, a
conservative candidate removes standalone click prompts without removing facts;
it competes in the same validation call, with no extra inference or weaker checks.
New and corrected titles take priority over the retained backlog. `/api/status`
reports `newTitleCoverage` for retained titles first seen or corrected since tracking
started, within the past 24 hours. Blocked/rejected/pending titles remain in the
denominator; unchanged copies never count as conversions. Its 90% target is a
conversion target, not a measured guarantee of factual accuracy. In one native
Clef Flash call, two independent `noul` checks per alternative assess factual support
and preservation of the primary point and material context; a `choice` question ranks
the alternatives and provides an explicit original fallback. Both checks must reach
0.7 for an alternative to qualify. The clearest qualifying alternative is selected;
choice probabilities rank wording, rather than measuring factual validity. Native
distribution confidence is diagnostic metadata and can differ from option probability.
Missing, malformed or uncertain checks preserve originals and remain retryable at the
next edition. A confident original selection with no qualifying alternatives is cached.
Calls respect the 64-question and 24,576-token limits. Clef charges input tokens only.

Rewrite requests use a JSON schema with short, request-local article IDs; those IDs
are restored to the original article identity before factual verification or storage.
The native binding's already-parsed JSON output is supported. Validation permits
only Clef Flash. A changed policy gets one immediate refresh within the
current refresh window, with its attempt and neuron reservation persisted before work.
Qwen uses its documented raw chat format with a closed thinking prefix. A complete
schema document returned through the alternate channel is still only a candidate;
prose and truncated output are rejected, and no reasoning text is exposed or stored.

Requests are sized adaptively from the actual full-text input, the context window,
reserved output space and the remaining daily budget. The same context goes to both
the rewrite model and the validator, so each request is limited to the **smaller** of
their context windows (`clef-flash` is 24,576 tokens) and output space is reserved per
article (three full short alternatives plus the choice and factual-check questions). The project reserves a
conservative slice of the shared **10,000-neuron/day** free allocation
(`DAILY_NEURON_BUDGET`, default 6000), persists the reservation before any model
call, reconciles it with provider-reported usage, and defers work instead of
overspending. No billing upgrade, retries or automatic budget increase.

Each edition processes the retained backlog in at most 32 finite chunks, with progress
persisted between Durable Object alarms. Publisher requests, redirects and native AI calls share a 48-request counter,
with verification slots reserved before body fetches, below the Free plan ceiling. Each article gets at most one model
attempt per edition. Inaccessible bodies wait a day before another fetch, so they do
not starve untouched articles. Malformed/omitted model results preserve their own originals while unrelated backlog
continues; provider failures and budget limits stop processing.
The existing ingestion cron remains hourly; this is not a Codex monitor or Shurik loop.
`/api/status` reports real changed-title coverage across the full feed, missing-source
and pending counts, and the project's daily neuron ledger. Unknown provider usage
keeps the conservative reservation rather than being counted as zero.

Source-visible material guards also run on cached titles before serving them. They
reject clipped Hebrew acronyms, inherited hype, lost denials/rebuttals, softened
critical injury, changed withdrawal demands and unattributed long source quotations.
A failing title returns to its marked original; valid siblings remain cached. These
checks enforce the existing editorial policy and do not replace full-text validation.

The UI presents originals with smaller, regular-weight, readable gray type, while
converted titles retain the stronger hierarchy. Authored controls use SVG icons and
CSS shapes rather than emoji or Unicode icon glyphs; publisher originals are preserved.

Accepted rewrites are cached with a policy fingerprint covering the model, the
full-context extraction policy, the editorial prompt and the validator version, and
source-grounded rejections are cached by the same fingerprint plus a source-content
fingerprint. At read/serve time, and through a persisted idempotent migration, any
decision whose fingerprint does not match the active policy (or whose source content
changed) is retired: the generated headline is cleared, the original returns to
display, and the article is reprocessed progressively under the same daily budget.
Full article text is inference context only — it is never shown in the UI, returned
by the public API, or written to Git. The original remains visible, and rejected
numbers/uncertainty changes, newly added sensational framing, rhetorical questions,
outcome reversals and insufficient context all fall back to an explicitly labeled
original title. Automated guards cannot fully prove factual fidelity; editorial
review is still useful.

**No model classification is currently needed.** If a concrete classification
need arises, use `@cf/cloudflare/clef-flash` as requested. Categories come from RSS category fields,
publisher feed names, JSON-LD `articleSection`, or article metadata. Unknown stays
unknown. Root [`websites.json`](websites.json) controls the four initial publishers.
Each feed has a source-provided fallback label and explicit allowed hosts. N12
uses Mako's official syndication endpoint; shared Mako/N12 article IDs deduplicate.
Full accessible article text is used transiently for rewrite context and is never
returned by the public API or written to Git.
The archive retains up to 480 articles from the last 72 hours.

## Shurik on main

The one-time `Start main loop` push workflow starts `main` using
`igor-makarov/shurik@v1`, `opencode-go/deepseek-v4.1-flash`, high reasoning,
`PROMPT.md`, a 1,800-second work budget and `wait-seconds=0` so iterations continue
immediately.
It skips startup if `shurik-control/main` already exists. Only the iteration job
receives the model key. Supported repository secret names are `OPENCODE_API_KEY`,
`OCGO_API_KEY`, and `OPENCODE_GO_API_KEY` (the first set wins).

Shurik recovery runs every 15 minutes and restarts work after the saved due time;
the interval is approximate, not an exact hourly appointment. A separate hourly
Codex checkup reads source/control evidence and steers `PROMPT.md`; Shurik owns
implementation work. See
[`STATUS.md`](STATUS.md) for current evidence and next priorities.

Stop/resume via **Actions → Shurik → Run workflow** on `main`, `loop_id=main`.
Resume requires explicit reasoning (choose `high`). Blank work/wait inputs on resume
retain saved settings. `wait-seconds=0` resumes immediate continuation. Do not start
another loop on main. Control/session history is public in this public repository;
keep credentials only in secrets.

## Interface and API

- `/api/news`: `q`, `source`, exact `category`, `order=broad|latest`, `limit` (1–120),
  `offset`; includes category options, source states, freshness and original titles.
- `/api/status`: source/freshness/rewrite status and bounded rewrite counters, failure
  stage and completion reason. No article bodies, key values or provider responses.
- During a background refresh, the page checks for its result up to ten times and
  stops when it completes. An unsubmitted search is preserved; no periodic checkup
  or per-visitor inference loop is created.
- No public refresh/admin endpoint. Cron invokes the internal Durable Object.
- A failed source does not replace the last successful articles; old articles expire
  after 72 hours. Stale or partial coverage is visible in the interface.

The UI follows the [Canton of Zürich design system](https://www.zh.ch/de/webangebote-entwickeln-und-gestalten.html),
adapted for Hebrew RTL: square controls, bold/regular type hierarchy, rules and a
clear grid. Black/white and gray carry content; #0070B4 blue/#EDF5FA soft blue mark
interaction. #1A7F1F green indicates a successful source update, not positive news.
The self-hosted Heebo font uses the bundled SIL Open Font License. No canton branding
or licensed Helvetica font assets are used.
