# Current state

- Bootstrapped on `main`: Hebrew RTL interface; configurable source registry;
  RSS/Atom and Kan news-sitemap adapters; category/source rotation; hourly Worker
  ingestion; SQLite Durable Object storage; guarded Workers AI headline rewrites.
- Provisional Hebrew name: **במבט**. Alternatives: **בקצרה**, **קו נקי**, **בלי רעש**.
- The bootstrap workflow starts Shurik loop `main` once. Sessions/control are on
  `shurik-control/main`; coding iterations wait at least one hour between runs.

## Next checks

0. Diagnose `npm run test:worker`: the isolated Miniflare fixture harness returned
   HTTP 500 on the Node-side Durable Object call without useful error details.
   Wrangler's actual local `/api/news` returned 200 with an empty edition; the
   runtime fixture ingestion has not passed. Keep the harness as pending work.
1. Verify all feed URLs from Actions. Initial setup could not fetch publisher hosts
   under its network policy. Mako/N12 URLs follow Mako's official RSS directory;
   Kan's sitemap follows robots.txt; Ynet URLs need live validation.
2. Verify the existing Cloudflare deployment name, build/deploy commands, and URL.
   No Cloudflare credentials/configuration were exposed to this environment.
3. Verify the native `AI` binding, cheap Llama 3.1 8B FP8 Fast Hebrew quality and
   real neuron use. Hard cap: 8 headline attempts/hour, 1024 output tokens/batch.
   No Worker API key is needed. Preserve originals on quota/validation failure.
   Classification is unnecessary; use Clef Flash only if a concrete need arises.
4. Complete browser QA using supported browser tooling when available.

This file records actual evidence; do not claim deployment or live feeds are verified
until a successful check supplies it.

Steering goes through `PROMPT.md`; further implementation belongs to Shurik.

Validation at handoff (2026-10-13): source checks and all 20 unit tests passed;
Wrangler dry-run bundled the Worker with NEWS, AI, and ASSETS bindings.
Live publisher access, production Hebrew inference and browser QA remain unverified.
