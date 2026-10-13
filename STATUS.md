# Current state

- Bootstrapped Hebrew RTL Worker on `main`: configurable source registry; RSS/Atom
  and Kan news-sitemap adapters; category/source rotation; hourly ingestion; SQLite
  Durable Object storage; guarded Workers AI rewrites (originals preserved).
- Provisional Hebrew name: **במבט**. Alternatives: **בקצרה**, **קו נקי**, **בלי רעש**.
- Sessions/control are on `shurik-control/main`; coding iterations wait ≥1 hour.

## Verified this iteration (2026-10-13)

0. **Local runtime smoke test fixed.** Root cause of the HTTP 500: the raw Miniflare
   v4 options passed to `convertV4MiniflareOptions` did not mark the Worker as the
   user worker, so the assets router refused to dispatch `/api/*`
   (`routerConfig.has_user_worker` was false). Added
   `routerConfig: { has_user_worker: true }` to `scripts/smoke.js`. `npm run
   test:worker` now passes: SQLite persistence, all four adapters, HTMLRewriter
   metadata, original fallback without an AI binding, categories, API filters,
   cooldown, and static assets. Fixtures stay inside Miniflare.
2. **Real publisher endpoints validated from the runner** (2026-10-13, all HTTP 200,
   `application/xml`/`text/xml`): ynet `StoryRss2/3/6/538/8`, Kan
   `media/sitemap/news/sitemap.xml`, mako `news-military|law|money|world`, and the
   four `rcs.mako.co.il/rss/c...` feeds.
   - **ynet feed labels were wrong** and are repaired in `websites.json` using the
     published channel titles: `StoryRss3` = ספורט (was כלכלה), `StoryRss6` = כלכלה
     (was ספורט), `StoryRss538` = תרבות ובידור (was תרבות). `StoryRss8` is the ynet
     **home page** (`ynet - דף הבית`), not health, so it was removed rather than
     mislabeled. No publisher health feed exists among the checked StoryRss ids.
   - Live workerd refresh (real network, `REWRITES_PER_REFRESH=0`):
     `ynet=ok(114) kan=ok(8) n12=ok(74) mako=ok(58)`; ynet categories now match
     content (חדשות/ספורט/כלכלה/תרבות ובידור); n12/mako labels match channel titles.
   - Kan JSON-LD supplies headline/description/date but **no `articleSection`**, so
     Kan categories remain missing (per the invariant). Note for tooling: plain Node
     has no `HTMLRewriter` global, so Node-only live checks misreport Kan as
     `fetch_failed`; Kan metadata must be exercised under workerd/Miniflare.
4. **Browser render verified.** Committed `scripts/browser-check.js`
   (`npm run test:browser`, needs a prior build and Chromium/Chrome on PATH). Against
   the fixture Worker, headless Chromium at 390×844 and 1440×1000 renders the RTL
   Hebrew page, article rows, four source cards, category options, and the
   original-title label. Screenshot inspection confirmed correct RTL layout at both
   widths. Interactive QA (keyboard traversal, filter/order/pagination interactions,
   error states) is still pending.
5. **Headline guards tightened.** `acceptRewrite` now also rejects question marks
   (rhetorical questions) and sensational terms the source did not contain
   (e.g. בהלם / מזעזע / לא תאמינו), so a rewrite cannot add drama the publisher did
   not use. The rewrite fingerprint was bumped to `editorial-v2`. Unit coverage: 21
   tests pass.

Validation at handoff plus this iteration: `npm run check`, all 21 unit tests,
`npm run build` (dry run), `npm run test:worker`, and `npm run test:browser` pass.

## Blocked / needs input

1. **Cloudflare deployment unverified.** No Cloudflare credentials or account access
   in this environment; the existing Worker name, build/deploy commands, routes, and
   deployed URL could not be inspected. Reconcile `wrangler.jsonc` (`positivity-bias`)
   with the connected Workers Builds Worker once access is available. Do not create a
   parallel deployment.
3. **Deployed `/api/status` and `/api/news` smoke checks pending** the verified URL.
   Workers AI Hebrew quality, the native `AI` binding, JSON response shape, and real
   neuron use are unverified (no deployment). Offline probe: Miniflare's local `AI`
   binding reports `provider_unavailable` and the refresh still completes with
   originals preserved, confirming the fallback path. Keep the 8-attempt/hour,
   1024-token, cheap-model-allowlist limits; prefer honest originals on failure.
5. Factual-headline validation can still be strengthened with observed rewrite errors
   once live inference is reachable (names/quotes/causal claims are not yet guarded).

Steering goes through `PROMPT.md`; further implementation belongs to Shurik.
