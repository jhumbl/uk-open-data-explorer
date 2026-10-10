# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this repo is

**uk-open-data-explorer** — the designed frontend for the
[uk-open-data](https://github.com/jhumbl/uk-open-data) pipeline: a
catalogue of small, hand-tailored dashboards, one per question worth
asking of each dataset. A static site on **GitHub Pages** that queries
the published parquets **directly in the visitor's browser** with
DuckDB-Wasm. There is no backend, no build-time data, and no data in
this repo, ever.

The two-repo split is deliberate: this site is a *consumer* of the
pipeline's public contract, with no privileged access. If a dashboard
needs something the contract doesn't provide (an aggregate parquet, a
catalog field, a typed column), the fix is **upstream in the pipeline
repo** — never a workaround here. The site dogfoods the contract; gaps
it exposes are valuable.

## The data contract (what we consume)

- **Stable URLs** (safe to hard-code via `hfFileUrl()` in
  `src/lib/catalog.ts`):

      latest:    https://huggingface.co/datasets/jhumbl/<family>/resolve/main/<filename>
      snapshot:  https://huggingface.co/datasets/jhumbl/<family>/resolve/archive-YYYY-MM/<filename>

- **catalog.json** — fetched at runtime from
  `raw.githubusercontent.com/jhumbl/uk-open-data/main/catalog.json`:
  the machine-readable index (per-file sha256, sizes, row counts,
  period coverage, source/family health). The site reflects each weekly
  pipeline run without redeploying. It is chrome, not a dependency: if
  the fetch fails, dashboards still work.
- **Schemas** — each parquet's columns are declared in its source's
  `datapackage.json` in the pipeline repo
  (`sources/<name>/datapackage.json`). Filenames and schemas are API on
  the pipeline side (its invariant 6); breaking changes there get
  transition periods, so this site never breaks silently.
- **Serving behaviour** (CORS + HTTP Range on HF; CORS on
  raw.githubusercontent.com) is **verified, never assumed**: the
  pipeline smoke-tests every published URL weekly, and this repo's
  `scripts/smoke_test.mjs` re-verifies the consumer path before every
  deploy and every Tuesday.

When working here you usually won't have the pipeline repo checked out.
Its CLAUDE.md is the authority on the data side; the facts this repo
needs day-to-day are duplicated below deliberately.

## Architecture

    index.html                     Vite entry
    vite.config.ts                 base: /uk-open-data-explorer/  (Pages path — see gotchas)
    src/main.tsx, src/App.tsx      Shell + hand-rolled hash routing (#/ and #/d/<id>)
    src/HomePage.tsx               The catalogue: dashboard cards + full file index
    src/index.css                  Design tokens (light AND dark) + all site chrome
    src/lib/duckdb.ts              DuckDB-Wasm singleton, bundled locally (no CDN);
                                   query<T>() returns plain rows, BigInt→Number
    src/lib/catalog.ts             catalog.json client, types, URL builders
    src/lib/format.ts              en-GB number/date formatters
    src/components/                Genuinely shared UI (ErrorBoundary) +
                                   charts/ — the shared chart primitives
                                   (frame, tooltip, stat tiles, data table,
                                   segmented control)
    src/dashboards/registry.ts     The dashboard catalogue — one entry per dashboard
    src/dashboards/<id>/           One folder per dashboard, lazy-loaded,
                                   self-contained (its chart code lives here)
    src/gallery/                   #/charts-template — dev-only proofing page:
                                   every chart type on synthetic data
    scripts/smoke_test.mjs         Consumer-path check: catalog CORS + parquet Range
    .claude/skills/charts/         The chart design language (project skill)
    .github/workflows/deploy.yml   Build → smoke → deploy to Pages (on push to main)
    .github/workflows/smoke.yml    Weekly re-check between deploys

- **React 19 + TypeScript + Vite**, deployed by Actions
  (`actions/deploy-pages`). `dist/` is never committed; there is no
  gh-pages branch.
- **Dashboards are lazy and isolated**: each is registered in
  `registry.ts`, loaded on demand, and rendered inside an ErrorBoundary
  so one broken dashboard never takes down the catalogue.
- **Routing is hand-rolled hash routing** — two route shapes don't
  justify a router dependency. Revisit only if routes grow real
  structure.

## Charting — settled: D3-in-React

**Decided 2026-07: D3 is the chart library, in one specific discipline —
React renders the SVG; D3 does scales and shape math only. No
`d3.select`, no D3 owning the DOM.** Don't introduce another charting
library. Rationale, so this isn't relitigated: the authoring-speed
advantage of higher-level libraries (Plot, ECharts, …) doesn't pay for
anything here, while hand-rendered SVG is what makes the design
language enforceable — every mark reads its colour from a token, the
tooltip/keyboard layer is ours, and d3's scale/shape modules tree-shake
to a few KB on a site already shipping a wasm engine.

Where chart code lives:
- **Shared primitives** in `src/components/charts/` — the frame
  (measure + margins + gridlines + ticks + baseline), tooltip, stat
  tiles, data-table wrapper. These encode the design language; compose
  them rather than re-rolling their pieces.
- **Whole chart types** (LineChart, BarChart, …) stay dashboard-local
  until a second dashboard needs the same one, then get promoted to
  `src/components/charts/`.

Maps are a separate, also-settled stack: MapLibre GL + deck.gl, built —
the shared surface lives in `src/components/map/` (MapCanvas + the
token-driven basemap style; keyless OpenFreeMap tiles, per invariant 1
and the no-secrets rule; ~470 KB gz, so import it only from lazy
chunks). The charts skill · Maps is the authority on the contract, the
settled interaction rules and the map-first page archetype
(signed off 2026-07-19), and what remains open — notably the map
colour palettes, which are accepted only provisionally pending a
site-wide colour review. The map language is co-designed with the
user, never extended unilaterally.

## Dataviz conventions

**The full design language lives in the project skill at
`.claude/skills/charts/SKILL.md` — invoke it (`/charts`) before
building or changing any chart, stat tile, or dashboard.** It carries
the form heuristic, the shared-primitives catalogue, mark specs,
colour rules and the ship checklist. The core that must never be
violated, skill loaded or not:

- The design tokens in `src/index.css` are the palette (light and dark
  both hand-picked — dark is not an automatic flip); chart code
  references tokens by role, never raw hex.
- One y-axis, ever.
- Every chart ships its hover layer with keyboard parity — arrow keys
  surface exactly what hover does. Tables are a form in their own right
  (an open table card when the data's job is exact values), never a
  collapsed "view as table" appendix under a chart.
- Compose the primitives in `src/components/charts/`; don't re-roll
  frames, tooltips, tiles or tables per dashboard.
- New series colours beyond `--series-1` are validated for
  colour-vision deficiency before shipping (validator and pre-approved
  slots are referenced in the skill).

## Query discipline (measured facts — expensive to re-derive)

Measured in-browser against the live HF files, 2026-07:

- **Two-tier pattern.** Queries over small parquets (≤ ~10 MB: the DfT
  and FSA files) are effectively instant and fine to run per-interaction.
  Direct drills into the 887 MB police parquet take ~5–10 s and ~22 MB
  of transfer when filtered on `month` (the file is month-sorted with
  non-overlapping row groups, so month predicates prune hard); repeat
  queries in the same period drop to ~0.5 s. Never scan it unfiltered.
- **Never `SELECT *` on the police files** — `crime_id` alone is 697 of
  the 887 MB and no analytical query needs it (it exists to join to the
  outcomes table).
- **lat/lon are VARCHAR** in the police and FSA schemas — `TRY_CAST(...
  AS DOUBLE)` before any spatial arithmetic.
- **The DfT VEH tables are a margins cube** — the single biggest
  correctness trap here. `fuel`, `body_type` (0105 only) and
  `keepership` each contain publisher `'Total'` rows, AND the geography
  column mixes UK/GB/England/region/county aggregates with local
  authorities. Naive sums over-count roughly 8–10×. Either read the
  publisher's own aggregate rows (pin margins to `'Total'`, take
  `ons_code = 'K02000001'` for the UK), or scope to the non-overlapping
  LA partition: `regexp_matches(ons_code, '^(E06|E07|E08|E09|W06|S12|N09)')`
  with margins pinned. Counts are a **stock** (licensed at quarter end),
  not a flow. Sanity anchors: ~41.5M vehicles, ~2.79M ULEVs (2025 Q4).
  And VEH0105's `count_thousands` is in THOUSANDS; VEH0132's `count` is
  units.
- **FSA `rating_value` is a string** (0–5 but also 'Exempt',
  'AwaitingInspection', 'AwaitingPublication'); component scores count
  points *deducted* — lower is better.
- **HF's anonymous rate limit (~1,000 req/hr/IP) is per visitor**, so it
  scales with audience — but DuckDB's range requests are chatty, so keep
  each dashboard to a handful of queries per interaction. A dashboard
  that needs heavy repeated scans is the documented trigger to add an
  `_agg_` parquet upstream in the pipeline, not to hammer the big files.

## Invariants — do not break these

1. **Static consumer only.** No backend, no server-side rendering, no
   data files committed, no privileged coupling to the pipeline. Data
   gaps are fixed upstream.
2. **`dist/` is never committed.** Deploys happen only via the Actions
   workflow. No gh-pages branch.
3. **The serving promise is tested, not assumed.** `npm run smoke` runs
   before every deploy; never weaken `scripts/smoke_test.mjs` to make a
   run green.
4. **Data + context is the product.** Every dashboard states the caveats
   that change how its chart is read (units, stock-vs-flow, coverage,
   comparability breaks), links its HF dataset repo and publisher, and
   credits OGL v3.0. A chart whose caveats are missing is not done.
5. **One dashboard failing must never take down the catalogue** — keep
   dashboards lazy-loaded and inside the ErrorBoundary; keep the
   catalogue page functional when catalog.json is unreachable.
6. **Correctness over speed on the margins cube.** Any DfT VEH query is
   reviewed against the margins-cube rules above before shipping.

## Local commands

    npm install
    npm run dev        # Vite dev server (queries hit real HF data)
    npm run build      # typecheck + production build into dist/
    npm run preview    # serve the production build locally
    npm run smoke      # verify the data-serving contract from here

## Adding a dashboard (the most common task)

Invoke the `charts` skill first — it is the detailed, procedural
version of this list.

1. Read the source's `datapackage.json` in the pipeline repo — the
   schema block and the caveats. The caveats usually dictate the SQL
   (see the margins cube above).
2. Pick the one question the dashboard answers. A dashboard is a
   designed page about a question, not a generic table-viewer.
3. `src/dashboards/<id>/` with a default-exported component; register it
   in `registry.ts` (id, title, honest blurb, family, files). Copy the
   `ulev-uptake` dashboard as the pattern: headline stat tiles → charts →
   "How to read this" caveats + source links.
4. Keep queries small (see Query discipline). Test in `npm run dev`
   against real data; sanity-check magnitudes against a known anchor
   before trusting a chart.
5. `npm run build` must pass. Eyeball light AND dark mode, and keyboard
   tooltip access.

## Gotchas

- **BigInt:** Arrow returns 64-bit integers as BigInt; `query()` in
  `lib/duckdb.ts` converts to Number. If you bypass it, d3 and
  formatters will throw on BigInt.
- **Vite `base`:** `/uk-open-data-explorer/` must match the GitHub repo
  name or every asset 404s on Pages (dev is unaffected, so the breakage
  only shows in production). Internal links are hash-only (`#/d/...`),
  which sidesteps the Pages-SPA 404 problem — keep it that way.
- **duckdb-wasm upgrades:** the worker/wasm files are bundled via `?url`
  imports in `lib/duckdb.ts`; check those dist paths still exist when
  bumping the package.
- **Judge map performance in `npm run preview`, never in dev.** The
  react-dom dev build's performance-track instrumentation serializes
  changed props into `performance.measure` entries — catastrophic for
  the map dashboards, whose props are million-element typed arrays
  (measured 2026-07-18: 4 s freezes and ~1.5 GB heap in dev vs 0.2 s
  and ~85 MB in the production build, same code). `src/devPerfGuard.ts`
  (the first import in main.tsx, dev-only) disables the instrumentation
  so dev feels like the real site; delete that import if you ever need
  React's performance tracks back in the DevTools profiler.
- **First-load latency is real:** the wasm engine plus first parquet
  fetch takes seconds. Every dashboard shows a loading state saying the
  query runs in the browser — keep that honesty.
- **One-time Pages setup:** repo Settings → Pages → Source = "GitHub
  Actions". Until that's done, deploy runs fail at the deploy step.
- **Scheduled workflows pause** after ~60 days without repo activity
  (GitHub behaviour). The weekly smoke cron can silently stop on a quiet
  repo; the pre-deploy smoke still covers every deploy.
- The site never uploads or mutates anything — no tokens, no secrets.
  If a workflow ever seems to need a secret, the design has gone wrong
  somewhere.
