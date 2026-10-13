# במבט

Hebrew news in perspective: publisher categories, dry headlines, links to original
articles, and a broad reading order that rotates categories and sources. Difficult
news remains visible. No sentiment scoring, viral ranking, infinite scrolling,
sensational imagery, or tracking.

## Name proposals

| Name | Idea |
| --- | --- |
| **במבט** (provisional) | News in perspective; short and memorable |
| **בקצרה** | A concise daily view |
| **קו נקי** | Clear, restrained editorial phrasing |
| **בלי רעש** | A direct promise of less sensational coverage |

These are creative proposals; trademark/domain availability has not been checked.

## Development

Node 24+:

```sh
npm ci --ignore-scripts
npm run dev
npm run check
npm test
npm run build
npm run test:worker   # Miniflare runtime check with fictional fixtures (build first)
npm run test:browser  # headless Chromium render check (build first, needs Chromium on PATH)
```

`build` bundles the Worker with Wrangler's dry run; it does not publish. Live
headlines are never replaced with sample articles. The first request starts a
bounded background refresh; reload after it finishes. Wrangler local development
needs outbound access to the publisher hosts for live aggregation. Additional
workerd checks: `npm run test:worker` (fixtures), `npm run test:extract`
(full-text extraction) and `npm run test:retirement` (stale-cache retirement).

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
The same Durable Object serializes refreshes and persists an hourly cooldown,
including after failures, so public reads cannot cause unbounded model usage.

This environment did not have Cloudflare account access, so the existing dashboard
commands and deployed URL could not be inspected. `npm run deploy` requires
Cloudflare authentication outside the connected Builds runner.

## Headline rewrites

Rewrites use **Cloudflare Workers AI**, with the native `AI` binding declared in
`wrangler.jsonc`. No inference API key is needed. The Actions OCGO key is only
for Shurik. The inexpensive default is `@cf/meta/llama-3.1-8b-instruct-fp8-fast`.
The cheap allowlist also permits `@cf/qwen/qwen3-30b-a3b-fp8` (documented Hebrew
support, lower output price) and Llama 3.2 1B/3B. Expensive or paid-only models
are blocked. Qwen3's thinking phase is disabled and its chat-style response
envelope is handled; switching the default still requires measured Hebrew-quality
checks against the live account.

Each refresh fetches the **full accessible article text** for the candidates it can
afford, strips navigation, advertising and unrelated recommendations, and passes the
publisher, original headline, publication time and body (marked complete, truncated
or missing) to the model. The editorial prompt requires the primary point and its
material context — actor/speaker, action, geographic scope and result — and never
reverses an outcome. Missing context keeps the original headline.

A candidate is then checked with `@cf/cloudflare/clef-flash`, which answers two
separate questions: is every claim supported by the source, and are the primary point
and material context preserved without misleading omission, broadening, narrowing or
changed emphasis? A candidate is accepted only when both are true; anything
unsupported, incomplete or uncertain falls back to the preserved original.

Requests are sized adaptively from the full-text input, the model context window,
reserved output space and the remaining daily budget. The project reserves a
conservative slice of the shared **10,000-neuron/day** free allocation
(`DAILY_NEURON_BUDGET`, default 6000), persists the reservation before any model
call, reconciles it with provider-reported usage, and defers work instead of
overspending. No billing upgrade, retries or automatic budget increase.

Accepted rewrites are cached with a policy fingerprint covering the model, the
full-context extraction policy, the editorial prompt and the validator version. At
read/serve time, and through a persisted idempotent migration, any rewrite whose
fingerprint does not match the active policy is retired: the generated headline is
cleared, the original returns to display, and the article is reprocessed
progressively under the same daily budget. Full article text is inference context
only — it is never shown in the UI, returned by the public API, or written to Git.
The original remains visible, and rejected numbers/uncertainty changes, newly added
sensational framing, rhetorical questions, outcome reversals and insufficient
context all fall back to an explicitly labeled original title. Automated guards
cannot fully prove factual fidelity; editorial review is still useful.

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
`PROMPT.md`, a 600-second work budget and a 3600-second wait after each iteration.
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
- `/api/status`: source/freshness/rewrite status. No key values or provider responses.
- No public refresh/admin endpoint. Cron invokes the internal Durable Object.
- A failed source does not replace the last successful articles; old articles expire
  after 72 hours. Stale or partial coverage is visible in the interface.

The UI follows the [Canton of Zürich design system](https://www.zh.ch/de/webangebote-entwickeln-und-gestalten.html),
adapted for Hebrew RTL: square controls, bold/regular type hierarchy, rules and a
clear grid. Black/white and gray carry content; #0070B4 blue/#EDF5FA soft blue mark
interaction. #1A7F1F green indicates a successful source update, not positive news.
The self-hosted Heebo font uses the bundled SIL Open Font License. No canton branding
or licensed Helvetica font assets are used.
