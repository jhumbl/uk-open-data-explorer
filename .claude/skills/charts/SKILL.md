---
name: charts
description: Use BEFORE building or changing any chart, dashboard, stat tile, or table view in this repo — the settled design language, the shared primitives in src/components/charts/, and the ship checklist. Triggers on adding a dashboard, editing chart code, choosing chart form or colour, or reviewing a chart PR.
---

# Charts in uk-open-data-explorer

The stack is settled (CLAUDE.md · Charting): **D3-in-React** — React
renders the SVG, D3 does scales and shape math only. No `d3.select`,
no other charting library. Exemplars to copy from:

- Line chart: `src/components/charts/LineChart.tsx` (promoted 2026-07 when vehicle-fleet became its second consumer)
- Vertical bars: `src/components/charts/CategoryBars.tsx` (promoted 2026-07; supports negative values below the baseline)
- Ranked horizontal bars: `src/components/charts/RankedBars.tsx` (promoted 2026-07; data-driven axis, or `domainMax` to fix it)
  (steal the rounded-data-end path helpers from the bar charts)

Whole chart types stay dashboard-local; promote one to
`src/components/charts/` only when a second dashboard needs it.

**The proofing page:** `#/charts-template` (`src/gallery/ChartsGallery.tsx`;
dev-only — `npm run dev`, absent from production builds) renders every chart type and primitive on synthetic data — no DuckDB, no
network (one exception: the map card streams real basemap tiles; its
marks are synthetic). Iterate on the design language there (deterministic data keeps
screenshots comparable; Shuffle stress-tests geometry), and preview any
new primitive there before a dashboard uses it. It is unlisted and is
NOT a dashboard — no registry entry, ever.

## Dashboard philosophy — overview, filter, detail

How a page is composed and how interaction behaves. Grounded in the
established literature (Shneiderman's mantra: overview first, zoom and
filter, details on demand; Cockburn's overview+detail: overview and
detail SIMULTANEOUSLY visible in spatially separate, stable regions;
NN/g on spatial memory and progressive disclosure; BI-industry
convention separating cross-filter / drill-down / drill-through) and
in what was built-and-rejected here 2026-07-17: chips (layout nudge)
and a drill-swap (the chart mutated under the click).

The page is a fixed stack of **stable slots**:

    dash-title + dash-sub     what the data IS (incl. stock-vs-flow)
    filter bar                one control per filterable dimension
    StatRow                   the headline; may re-headline under filters
    overview facet cards      distributions / rankings, one question each
    detail facet card(s)      decompose whatever the filters scope
    caveats                   how to read it

Interaction rules — each earns its place by a principle, not taste:

1. **Cards never appear, disappear, or swap in response to selection.**
   Interaction changes the data *within* cards (and their scope lines),
   never the layout or a card's identity. Spatial memory is part of the
   interface; a chart must not mutate under the user's click.
2. **Every chart is a filter, and the filter bar is the single display
   of filter state.** Clicking a mark writes the same state as its
   control in the always-rendered bar (Segmented for ≤~6 values, Select
   beyond that, "All" defaults, a permanent Reset disabled at
   defaults). No chips — never add a second display of filter state.
3. **Selection = highlight + narrow** (the crossfilter convention). The
   clicked chart keeps its full distribution — selected mark
   full-strength, others `.mark-dimmed`, selected `.cat-label` firms
   up — because it is the navigation and re-selection surface. Every
   other facet re-queries under all active filters EXCEPT its own
   dimension; tiles and detail cards apply ALL filters. Enter/Space on
   the active mark is the keyboard twin of the click (`useActiveIndex`
   `onSelect`); say so in the ariaLabel.
4. **Detail lives in its own permanent card, designed to be meaningful
   at every filter state** — "across all areas" down to "within
   Emberton". When a selection makes a comparison card's question moot
   (a ranking with one row highlighted), the answer is NOT to swap
   that card for a breakdown; it is a detail card that was there all
   along, plus a residue line in the ranking's subtitle ("Emberton
   ranks 5 of 16"). Detail cards are not click-filterable (v1 — no
   nested drills).
5. **Filters (data scope) live in the page-level bar; view controls
   (presentation choices: time range, metric variant) stay per-card**
   as a Segmented in the card's controls slot. Don't mix the two.
6. **A full member page (drill-through) is explicit navigation** — its
   own route, deliberately visited — never a side effect of clicking a
   mark. None built yet.
7. Filter changes re-query and snap (no transitions). Small parquets
   (≤ ~10 MB): `CREATE TABLE AS read_parquet(url)` once at dashboard
   load, then every interaction queries DuckDB memory — zero network
   per click. Big files: only pre-pinned dimensions (e.g. police
   `month`) are cross-filterable, or add an `_agg_` parquet upstream.
8. **Cards are fixed-geometry at every filter state** (user, 2026-07-17):
   a filter change may reword a scope line and re-rank rows, but no card
   ever changes size or position. Concretely: text slots reserve their
   maximum line count (`.dash-grid` sets `chart-sub` to 3lh / 2lh on
   `.full`, tile deltas 2lh on `.container.wide`); charts keep fixed
   bins/rows — rankings zero-fill every dimension member from the domain
   (a member with nothing in scope gets a zero-length bar, never
   `HAVING`-dropped); no empty-state text ever swaps in for a chart; tile
   copy is written to a stable shape ("plus 0 exempt…" beats a sentence
   that comes and goes). Verify by measuring card bounding boxes across a
   filter toggle, not by eye.
9. **Fill the space** (user, 2026-07-17): no ragged edges at any filter
   state or viewport. Grid cards stretch to their tracks (no
   `align-items: start`); the stat row is an auto-fit grid that fills the
   container width — a tile count that leaves a hole means adding a real
   fourth stat, not shipping the gap; a tall card's row pitch is tuned
   (e.g. boroughs 17px vs types 15px) so its chart meets the neighbouring
   column's height.

Designing from a new dataset: inventory dimensions and measures from
its `datapackage.json`; pick the ONE question; choose 2–4 dimensions
that earn overview cards (forms per the table in step 2); decide which
dimensions are filterable and which ONE deserves the detail card;
check the query budget; then write the caveats before the charts —
they usually dictate the SQL.

## The procedure

Work through these in order — form first, colour near the end.

### 1. Schema first

Read the source's `datapackage.json` in the pipeline repo
(`sources/<name>/datapackage.json`, fetchable from
`raw.githubusercontent.com/jhumbl/uk-open-data/main/...`). The caveats
block usually dictates the SQL — string-typed numerics, publisher
Total rows, margins cubes (see CLAUDE.md · Query discipline).

### 2. One question, then the form

A dashboard answers one question; the data's job picks the form:

| The data's job | Form |
|---|---|
| Change over time | Line (area wash optional) |
| Distribution over ordered bins | Vertical bars |
| Ranked categories | Horizontal bars, sorted, category labels left |
| Single headline figure | StatTile — not a chart |
| Benchmark/average context | Labelled reference line on an existing chart |
| Exact values for lookup | An open table card — a table is a form in its own right, never a collapsed appendix (see step 7) |

**One y-axis, ever.** Two measures of different scale → two charts or
an index to a common base. A generic table-viewer is not a dashboard.

### 3. Anchor the data before writing chart code

Run the dashboard's exact aggregations against the live HF parquet
first (local `python -c "import duckdb; ..."` with httpfs, or a
scratchpad script) and record 2–3 anchor numbers. Every number the
finished page shows must be checkable against these. Magnitude bugs
(margins cubes, unit columns in thousands) are caught here, not in
review.

### 4. Compose the primitives

Everything shared lives in `src/components/charts/`:

| Import | Owns |
|---|---|
| `useContainerWidth()` | responsive width via ResizeObserver → `{ ref, width }` |
| `innerSize(width, height, margin)` | plot area inside margins → `{ iw, ih }` |
| `ChartFrame` | wrapper div (tooltip context) + focusable `<svg>` + margin group; takes `wrapRef, width, height, margin, ariaLabel, onKeyDown, onBlur, overlay` |
| `GridLines` / `Baseline` | hairline recessive gridlines / the one-notch-darker zero line; `orient="h"\|"v"` |
| `ChartTooltip` | the floating tooltip chrome; chart computes and clamps `style` position |
| `useActiveIndex(count)` | shared active-mark state: arrow keys, Escape, `clear` for blur/pointer-leave |
| `StatRow` / `StatTile` | the headline row; `label, value, delta` |
| `Segmented` | the controls slot: segmented toggle for filters/dataset switches; `label, options, value, onChange` — state lives with the caller |

Skeleton every chart follows:

```tsx
const { ref, width } = useContainerWidth();
const { iw, ih } = innerSize(width, HEIGHT, MARGIN);
const { active, setActive, onKeyDown, clear } = useActiveIndex(n);

<ChartFrame wrapRef={ref} width={width} height={HEIGHT} margin={MARGIN}
    ariaLabel="… Use arrow keys to step through values."
    onKeyDown={onKeyDown} onBlur={clear}
    overlay={activeItem && <ChartTooltip value={…} label={…} style={…clamped…} />}>
  <GridLines positions={ticks.map(y)} length={iw} />
  {/* tick text uses className="tick-label" */}
  <Baseline at={ih} length={iw} />
  {/* marks, then direct labels, then LAST: */}
  <rect x={0} y={0} width={iw} height={ih} fill="transparent"
      onPointerMove={(e) => setActive(hitTest(e))} onPointerLeave={clear} />
</ChartFrame>
```

SVG text typography is enforced by CSS classes in `src/index.css` —
`.tick-label` (muted, 11px), `.cat-label` (secondary, 11px),
`.end-label` (secondary, 12px, 600). Never inline fill/font on chart
text. Numbers go through `src/lib/format.ts` (en-GB); add a formatter
there rather than inlining `toFixed`.

### 5. Colour

- Tokens by role (`var(--series-1)`, `var(--gridline)`), never raw hex.
  Light and dark are both hand-picked in `index.css`.
- Sequential (one hue) is the default; categorical only when the series
  are the subject. ≥2 series always gets a legend; 1 series never does.
- Text never wears the series colour — identity comes from a coloured
  mark beside text in text tokens.
- Adding series colours beyond `--series-1`: validate with the bundled
  Claude Code `dataviz` skill's `scripts/validate_palette.js` against
  BOTH surface colours before shipping. Pre-validated slots: green
  `#008300`, magenta `#e87ba4`/`#d55181`, yellow `#eda100`/`#c98500`
  (light/dark).

### 6. Marks

2px lines with round joins; area fills ~10% opacity; bars fill their
band (~25% inner padding) up to a 64px cap (decided 2026-07 — the old
≤24px rule read as anaemic with few categories), with 4px rounded
**data-ends only** (anchored end stays square, radius clamped to bar
size — see `roundedTopBar`/`roundedRightBar`); markers
≥8px with a 2px `--surface-1` ring; gridlines hairline and solid.
Label selectively — the endpoint, the extreme, never every mark.

### 7. Interaction and accessibility

- Hover layer is mandatory: crosshair + tooltip on lines, per-mark on
  bars. The pointer hit area is the whole plot, never the mark.
- Keyboard parity is mandatory and comes free from `useActiveIndex` +
  `ChartFrame` — arrow keys must surface exactly what hover does. Say
  so in the `ariaLabel`.
- **No collapsed "View the data as a table"** (removed 2026-07-17 —
  the user judged it superfluous; the old `DataTable` primitive is
  deleted). Values are reachable by pointer AND keyboard through the
  tooltip; when exact values are the point, the card's form is an open
  table (`.table-wrap` + `<table>`, styles in index.css), not an
  appendix under a chart. Corollary: for multi-series colours below
  3:1 contrast, the mandated relief is the tooltip (which names every
  series with a swatch), no longer a table.
- **Transitions: none, deliberately (2026-07).** Data changes snap. An
  animated-transition system was built, showed artifacts, and was
  reverted; the user owns this decision and will revisit it. Do NOT
  reintroduce animation ad hoc. Lessons recorded for that future
  attempt: tween in PIXEL space keyed by entity (never tween raw
  values under a snapping scale — the domain change makes marks jump;
  never match old→new by array index); enters/exits/resizes snap;
  first render never animates; respect prefers-reduced-motion; verify
  continuity by sampling mark positions through a toggle, not by
  eyeballing. The gallery's toggles are the test harness.

### 8. The page around the chart

Copy the exemplar anatomy: `dash-title` + `dash-sub` (what the data
IS, including stock-vs-flow) → `StatRow` → `chart-card`s, each with
`h3` + `chart-sub` + [controls] + chart → `caveats` block.

**Filters/controls** (settled 2026-07-17 — see Dashboard philosophy):
data-scope filters live in the page-level filter bar under `dash-sub`
(`.filter-bar`: `filter-label` + `Segmented`/`Select` per dimension +
permanent Reset); per-card `Segmented` controls are for view choices
only (time range, metric variant), between `chart-sub` and the chart.
Every filter change re-queries: respect the query budget (small files
load into a DuckDB table once; the police parquet only month-filtered).
Caveats are invariant 4: units, coverage, comparability breaks, what
was excluded and why, HF repo link, publisher link, OGL v3.0. Register
the dashboard in `src/dashboards/registry.ts` with an honest blurb.
Loading state must say the query runs in the visitor's browser.

### 9. Ship checklist

- [ ] `npm run build` passes.
- [ ] On-screen numbers match the step-3 anchors.
- [ ] Light AND dark eyeballed (Playwright against the dev server:
      `emulateMedia({ colorScheme })`, screenshot, actually look).
- [ ] Arrow keys drive the tooltip on a focused chart.
- [ ] On a filtered dashboard: card geometry identical at every filter
      state (measure bounding boxes across a filter toggle), and no
      ragged edges — tracks filled at the working viewport.
- [ ] Queries obey the two-tier rule — small files may query per
      interaction; the police parquet only with a `month` filter; heavy
      repeated scans mean an `_agg_` parquet upstream, not a workaround.
- [ ] Caveats + source links present.

## Maps — surface, interaction and archetype settled; colours provisional

Stack (settled): MapLibre GL basemap + deck.gl overlay, wired through
`MapboxOverlay`. What exists, proofed in the gallery's map card, the
first map dashboard (food-hygiene-london's point map, 2026-07-17) and
the first map-first page (london-trees, signed off 2026-07-19):

- **`src/components/map/MapCanvas.tsx` — the one shared map surface.**
  It owns the basemap, the theme listener, the overlay plumbing and the
  ChartTooltip rendering; callers pass deck.gl `layers`, initial
  `bounds`, an `ariaLabel`, and optionally `getTooltip(info)` mapping a
  pick to `{ value, label }`. Never instantiate maplibre directly in a
  dashboard. Degrades on its own: if the browser refuses a WebGL2
  context, MapCanvas renders a quiet notice in the map's exact frame —
  a map failure never throws past its card (verified by loading the
  gallery with `--disable-webgl`: the SVG charts all survive).
- **Tooltip stacking is load-bearing** (bug found+fixed 2026-07-17):
  deck's overlay canvas is added via `map.addControl`, so it lives in
  maplibre's control container (z-index 2) and paints OVER unstacked
  siblings — without an explicit z-index the data marks draw on top of
  the tooltip. The `.map-canvas .chart-tooltip` rule in index.css
  carries `z-index: 5` (plus wrap + 260px max-width for long row-detail
  labels; the base chart tooltip is nowrap). Don't remove either, and
  remember the cause when adding any new overlay chrome to MapCanvas.
- **Map cards are full-bleed** (user, 2026-07-17): title, sub and
  legend keep the card's padding; the map itself extends through it to
  the card's left, right and bottom edges — wrap it in
  `<div className="map-bleed">` (rule in index.css, matched to the
  card's 20px padding and inner radius).
- **Interaction defaults (settled with the map-first sign-off,
  2026-07-19):** cooperative gestures for maps in cards (Ctrl+scroll /
  two-finger zoom — page scroll never hijacks); map-first pages pass
  `gestures="direct"` (plain scroll zooms — no page scroll to protect)
  **but direct applies only to fine-pointer devices: on touch (coarse
  pointer) MapCanvas always uses cooperative gestures**, because even
  the map-first page stacks the map above a scrollable panel on mobile
  and one-finger pans would trap page scrolling (user decision
  2026-07-19). Rotation and pitch disabled (flat figures, not globes),
  zoom control top-right, compact attribution bottom-right (the OSM
  credit is a licence requirement — never remove it). **Approved (user,
  2026-07-17): every map carries a fullscreen toggle just below the
  zoom buttons** — built into MapCanvas via maplibre's
  FullscreenControl, targeting the `.map-canvas` wrapper (NOT the map
  target: the tooltip is a sibling and must come along; the
  `:fullscreen` CSS in index.css releases the card height).
- **The basemap style is built at runtime** by
  `src/components/map/basemapStyle.ts` from the `--map-*` tokens in
  index.css — near-monochrome, light AND dark hand-picked like every
  other token; the data layers own the chroma. Theme flips swap the
  whole style (snap, no transition). Restyle the basemap by editing the
  tokens/style builder, never by pasting a third-party style JSON.
- **Tiles: OpenFreeMap `/planet` vectors** (OpenMapTiles schema),
  keyless per the no-secrets rule. Provisional choice — PMTiles
  self-hosting is the recorded fallback if OpenFreeMap wobbles. Glyphs
  are OpenFreeMap's too, so map labels are Noto Sans, not Inter;
  matching Inter means self-hosting glyph PBFs (open task).
- **deck.gl colours are JS arrays, not live CSS vars**: read tokens
  with `tokenRgb("--series-1")` (basemapStyle.ts) and rebuild layers
  when `usePrefersDark()` flips. Never hard-code a mark colour.
- **Bundle discipline:** maplibre + deck are ~470 KB gz and live only
  in lazy chunks (the gallery today). Only ever import MapCanvas from
  a lazy-loaded page, never from the entry.
- The map card is the gallery's one exception to "no network": basemap
  tiles stream from OpenFreeMap; the data marks stay synthetic.

**Approved interaction rule (user, 2026-07-17): a map mark is a filter
if and only if it represents a member of a filterable dimension.**
A choropleth region or a city/LA bubble is a dimension member — clicking
it writes the same state as its filter-bar control, with the crossfilter
selection language (pick full-strength, rest dimmed via alpha; the map
keeps all members as the re-selection surface). Marks representing
individual rows (incident dots, single establishments) are
details-on-demand only — tooltip at most, never pickable as a filter:
the filter bar could never display "one row" as a dimension control, so
a row click would create filter state with no home. Row-derived
textures (dot clouds) still re-derive under the active filters. Wire
clicks via MapCanvas's `onClick`; size/colour changes on a stable data
array need deck `updateTriggers` (deck ignores accessor identity).
Viewport-as-scope / drawn-area filtering over points is explicitly
parked — it needs its own design. Proofed in the gallery: the
cross-filter section's map card is a linked facet over the synthetic
city × rating dataset.

**Camera rule (amended by the user 2026-07-17): fly-to-scope.** On a
filter change the camera flies to frame the extent of the points now in
scope (MapCanvas's `focusBounds` prop; pass null at default filters and
it flies home to the initial bounds). The dashboard computes the extent
clipped against a plausibility box — a handful of bad published
geocodes must not drag the camera across the country (see
`extentOf`/`CLIP` in the food-hygiene HygieneMap). Flying is
navigation, not a data transition, so it animates (~900 ms, snap under
prefers-reduced-motion; the no-transitions rule is about data marks,
not the camera). `focusBounds` is keyed by value, so a re-query that
leaves the extent unchanged never yanks a camera the visitor has moved;
between flights the visitor still owns the camera. The gallery's
member-bubble map keeps its static camera — fly-to has only been
approved for row-detail point maps so far.

**The map-first archetype (settled 2026-07-19, exemplar:
london-trees).** For datasets that ARE a map (row payload =
coordinates + attributes, no time dimension): registry `mapPage: true`
→ App swaps the container/header/footer chrome for `.page.map-page`
(the rail stays). The dashboard renders two siblings: `.map-panel`
(424px, scrollable, on the left: back link, kicker, title, dash-sub,
colour-mode Segmented + Legend, stacked filter bar, 2×2 StatRow, two
clickable facet cards, caveats + OGL — invariant 4 lives in the panel
since there is no footer) and `.map-stage` (the map fills the
viewport; `.stage-note` carries the honest loading copy). Mobile: map
58vh on top, panel scrolls below. All page interaction rules hold
unchanged (filter bar = single display of state, fixed card geometry —
the panel's `chart-sub` reserve is 5lh, the measured worst-case scope
phrase — row dots tooltip-only, fly-to-scope). Panel charts use
`fmtCompact` ticks and pass `RankedBars labelWidth` sized to their
dimension (76 for tree kinds; the 176 default fits borough/LA names).

**Map colour status (2026-07-19): accepted provisionally, NOT final.**
The user signed off the `--clim-*` (5-class ordered) and
`--map-cat-0..8` (categorical) palettes "for now" and intends a future
site-wide colour review of all charts and maps. The official validator
(bundled `dataviz` skill, `--pairs all` against `--map-land`) findings
to carry into that review: (1) light-mode `--clim-vulnerable` ↔
`--clim-low` is ΔE 5.1 under deutan — below even the 6.0 relief floor,
and it is the palette's load-bearing distinction; (2) `--map-cat-1`
(Cherry pink) ↔ `--map-cat-2` (Maple red) sit below the normal-vision
floor in both themes (ΔE 9.0 light / 7.0 dark) — hard to separate even
with full colour vision; (3) the muted slots (`--clim-low`,
`--clim-none`, `--map-cat-0`) fail chroma/lightness checks BY DESIGN
(recessive majority/no-data classes with alpha-carried salience) — do
not "fix" those without the user. Relief meanwhile: legend, tooltip
naming the class, and filter isolation.

**Still undesigned — do not design unilaterally.** The user is
particular about map design: show drafts for approval, and record the
approved rules here as they land. Open: the site-wide colour review
above, label density and typeface (Inter glyphs = self-hosted PBFs),
keyboard access to data marks (the charts' arrow-key parity has no map
equivalent yet — the filter bar and linked charts are the interim
keyboard path to the same state), choropleth colour language and
legends (also blocked on a boundary-polygon source: publishing
boundaries to HF via the pipeline is the proper route, ONS generalised
GeoJSON fetched direct is the gallery-draft option), viewport-as-scope.
