import { useEffect, useMemo, useState } from "react";
import { query, queryArrow } from "../../lib/duckdb";
import { hfFileUrl, hfRepoUrl } from "../../lib/catalog";
import { useCrossFilter, type FilterState } from "../../lib/crossfilter";
import { fmtCompact, fmtInt, fmtPct } from "../../lib/format";
import { StatRow, StatTile } from "../../components/charts/StatTile";
import LoadingPanel from "../../components/charts/LoadingPanel";
import Segmented from "../../components/charts/Segmented";
import Select from "../../components/charts/Select";
import CategoryBars, { type CategoryBar } from "../../components/charts/CategoryBars";
import RankedBars, { type RankedBar } from "../../components/charts/RankedBars";
import Legend from "../../components/charts/Legend";
import TreesMap, {
  CLIM_LEGEND,
  GENUS_LEGEND,
  type ColourMode,
  type TreeDicts,
  type TreePoints,
} from "./TreesMap";

/**
 * London's public trees — the map-first draft (2026-07-17).
 *
 * The dataset IS a map: 1,136,049 rows, one per publicly maintained
 * tree, whose payload is coordinates + species/age/climate attributes,
 * with no time dimension. So the page archetype inverts: the map fills
 * the viewport, and this panel is the usual stable stack — title,
 * filter bar, tiles, two clickable facet charts, caveats — rotated into
 * a scrollable column. All the interaction rules hold: the filter bar
 * is the single display of state, chart clicks write the same state,
 * cards keep fixed geometry, map dots are row-level (tooltip-only).
 *
 * Memory + speed contract (v3, 2026-07-17, after an OOM report):
 * DuckDB is LOAD-ONLY. It fetches the ~27 MB parquet once, dictionary-
 * encodes every categorical to SMALLINT codes, hands the typed arrays
 * to JS — and then every table is dropped, so the wasm heap returns to
 * baseline and the dataset exists exactly once (compact JS typed
 * arrays, ~40 MB). Every interaction — the GPU filter mask, the
 * fly-to extent, every tile and chart aggregate — is ONE JS pass over
 * those arrays (computePage, ~20 ms). No query, no transfer, no
 * re-upload; the GPU discards filtered dots via DataFilterExtension
 * (see TreesMap).
 *
 * Anchors (live parquet, 2026-07-17): 1,136,049 trees · top kind
 * Cherry 153,821 · climate Low 687,846 (60.5%) / Moderate 222,447 /
 * Vulnerable 112,547 / Not provided 108,752 / High 4,457 · Highways
 * 542,900 · assessed 1,027,297 · Ash is 51,229 of the Vulnerable class.
 */

const FAMILY = "gla-trees";
const FILENAME = "gla_public_realm_trees.parquet";

// ---- load: raw columns → dictionaries → codes → JS, then drop ----

// Column subset only — uniqueid, maintainer, taxonomy beyond species,
// canopy and girth never enter memory. Publisher sentinels are kept as
// published; only true nulls (36 blank boroughs) get a label so the
// dictionary joins can't drop rows.
const LOAD_RAW = `CREATE OR REPLACE TABLE trees_raw AS SELECT
  lat::DOUBLE AS lat, lon::DOUBLE AS lon,
  coalesce(gla_name, 'Not recorded') AS gla_name,
  coalesce(climate_suitability, 'Not provided') AS clim,
  coalesce(borough, 'Not recorded') AS borough,
  coalesce(location, 'Not recorded') AS loc,
  coalesce(age_cat, 'Not provided') AS age,
  coalesce(common_name, 'Not recorded') AS name,
  coalesce(taxon_species, 'NA') AS species,
  coalesce(height_m, 'Not recorded') AS height
FROM read_parquet('${hfFileUrl(FAMILY, FILENAME)}')
WHERE lat IS NOT NULL AND lon IS NOT NULL`;

/** The dictionary tables: distinct value → dense SMALLINT code, in
    alphabetical order (so the genus dictionary doubles as the Kind
    select's option list). d_genus also carries each kind's overall
    count, for the ranking card's frozen top-12 membership. */
const DICT_COLS = {
  d_genus: "gla_name",
  d_clim: "clim",
  d_loc: "loc",
  d_borough: "borough",
  d_name: "name",
  d_species: "species",
  d_age: "age",
  d_height: "height",
} as const;

function dictSql(table: string, col: string): string {
  const counted = table === "d_genus" ? ", count(*)::INT AS n" : "";
  return `CREATE OR REPLACE TABLE ${table} AS
    SELECT v${counted ? ", n" : ""},
           (row_number() OVER (ORDER BY v) - 1)::SMALLINT AS code
    FROM (SELECT ${col} AS v${counted} FROM trees_raw GROUP BY 1)`;
}

// `shuffle` fixes a random draw order once per session: at London-wide
// zoom a million dots overlap many deep, and any systematic order makes
// whatever draws last read as the majority (the overplot-inversion
// lesson from the food-hygiene map, at 20× the density). Random
// interleaving mixes colours in proportion; rare classes keep
// visibility through alpha, not stacking.
const LOAD_TREES = `CREATE OR REPLACE TABLE trees AS SELECT
  r.lat, r.lon,
  (random() * 2147483647)::INT AS shuffle,
  dg.code AS genus_c,
  dc.code AS clim_c, dl.code AS loc_c, db.code AS borough_c,
  dn.code AS name_c,
  ds.code AS species_c, da.code AS age_c, dh.code AS height_c
FROM trees_raw r
JOIN d_genus dg ON r.gla_name = dg.v
JOIN d_clim dc ON r.clim = dc.v
JOIN d_loc dl ON r.loc = dl.v
JOIN d_borough db ON r.borough = db.v
JOIN d_name dn ON r.name = dn.v
JOIN d_species ds ON r.species = ds.v
JOIN d_age da ON r.age = da.v
JOIN d_height dh ON r.height = dh.v`;

/** Pull every point into typed arrays for the GPU, in the fixed
    shuffled order. */
async function loadPoints(): Promise<TreePoints> {
  const tab = await queryArrow(`
    SELECT lon, lat, genus_c, clim_c, loc_c, name_c, species_c, age_c, height_c, borough_c
    FROM trees ORDER BY shuffle
  `);
  const n = tab.numRows;
  const lon = tab.getChild("lon")!.toArray() as Float64Array;
  const lat = tab.getChild("lat")!.toArray() as Float64Array;
  const pos = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 2] = lon[i];
    pos[i * 2 + 1] = lat[i];
  }
  const col = (name: string) => tab.getChild(name)!.toArray() as Int16Array;
  return {
    n,
    pos,
    genus: col("genus_c"),
    clim: col("clim_c"),
    loc: col("loc_c"),
    name: col("name_c"),
    species: col("species_c"),
    age: col("age_c"),
    height: col("height_c"),
    borough: col("borough_c"),
  };
}

interface TreesBundle {
  points: TreePoints;
  dicts: TreeDicts;
  /** The ranking card's frozen membership: overall top 12 kinds. */
  topKindNames: string[];
  totalAll: number;
}

// Once per session (module-level, like lib/duckdb's loadTable): the
// whole load → encode → export sequence, ending with every DuckDB
// table DROPPED — the wasm heap goes back to baseline and the dataset
// lives exactly once, in the JS typed arrays. A failed load forgets
// itself so the next mount retries.
let bundlePromise: Promise<TreesBundle> | null = null;
function loadTreesData(): Promise<TreesBundle> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      await query(LOAD_RAW);
      for (const [table, col] of Object.entries(DICT_COLS)) {
        await query(dictSql(table, col));
      }
      await query(LOAD_TREES);
      await query(`DROP TABLE trees_raw`);
      const dict = async (table: string) =>
        (await query<{ v: string }>(`SELECT v FROM ${table} ORDER BY code`)).map(
          (r) => r.v,
        );
      const [genus, clim, loc, borough, name, species, age, height] =
        await Promise.all(Object.keys(DICT_COLS).map(dict));
      const top = await query<{ g: string }>(
        `SELECT v AS g FROM d_genus ORDER BY n DESC LIMIT ${N_TOP_KINDS}`,
      );
      const points = await loadPoints();
      for (const table of ["trees", ...Object.keys(DICT_COLS)]) {
        await query(`DROP TABLE ${table}`);
      }
      return {
        points,
        dicts: { genus, clim, loc, borough, name, species, age, height },
        topKindNames: top.map((t) => t.g),
        totalAll: points.n,
      };
    })();
    bundlePromise.catch(() => {
      bundlePromise = null;
    });
  }
  return bundlePromise;
}

// ---- dimensions ----

const DIMS = ["genus", "clim", "borough", "loc", "age"] as const;
type Dim = (typeof DIMS)[number];

// Fixed option orders for the low-cardinality selects — publisher
// vocabulary, verified against the live file 2026-07-17. A value that
// disappears upstream simply matches nothing; charts zero-fill.
const CLIMS = ["High", "Moderate", "Low", "Vulnerable", "Not provided"] as const;
const LOCS = ["Highways", "Parks", "Housing", "Other", "Outside London"] as const;
const AGES = [
  "Young (0-15)",
  "Early mature (16-30)",
  "Mature (31-80)",
  "Over mature (81-150)",
  "Veteran (over 150)",
  "Undefined",
  "Not provided",
] as const;

/** Chart bin labels for the 2090 outlook card ("Not provided" doesn't
    fit a 70px bin). Keys are chart labels, values the raw data values. */
const CLIM_SHORT: [label: string, raw: string][] = [
  ["High", "High"],
  ["Moderate", "Moderate"],
  ["Low", "Low"],
  ["Vulnerable", "Vulnerable"],
  ["No data", "Not provided"],
];

const LOC_PHRASE: Record<string, string> = {
  Highways: "on highways",
  Parks: "in parks",
  Housing: "on housing land",
  Other: "on other public land",
  "Outside London": "outside London",
  "Not recorded": "at unrecorded locations",
};

/** Scope phrase for subtitles and tile small print, minus a card's own
    dimension: "mature cherry trees rated low for 2090 on highways in
    Camden". */
function scopePhrase(
  f: FilterState<Dim>,
  exclude: Partial<Record<Dim, boolean>> = {},
): string {
  const age =
    !exclude.age && f.age && !["Undefined", "Not provided"].includes(f.age)
      ? f.age.split(" (")[0].toLowerCase() + " "
      : "";
  const head = !exclude.genus && f.genus ? `${age}${f.genus} trees` : `${age}trees of every kind`;
  const clim =
    !exclude.clim && f.clim
      ? f.clim === "Not provided"
        ? "with no 2090 assessment"
        : `rated ${f.clim.toLowerCase()} for 2090`
      : null;
  const loc = !exclude.loc && f.loc ? (LOC_PHRASE[f.loc] ?? f.loc) : null;
  const place = !exclude.borough && f.borough ? `in ${f.borough}` : "across London";
  return [head, clim, loc, place].filter(Boolean).join(" ");
}

// ---- the per-interaction pass ----

const N_TOP_KINDS = 12;
const KINDS_ROW = 18;
const CLIM_CHART_H = 190;

/** Plausibility clip for fly-to-scope (all current geocodes fall well
    inside, but the camera must never chase a future bad row). */
const CLIP: [[number, number], [number, number]] = [
  [-0.6, 51.2],
  [0.4, 51.8],
];

interface PageData {
  mask: Float32Array;
  extent: [[number, number], [number, number]] | null;
  tiles: { n: number; lowvuln: number; assessed: number; highways: number };
  topKind: { g: string; n: number } | null;
  kindCounts: Map<string, number>;
  kindScopeTotal: number;
  clims: CategoryBar[];
}

/** Everything a filter change needs, in one pass over the resident
    arrays: the GPU mask and fly-to extent (all filters), the tiles
    (all filters), and the two facet aggregates, each excluding its own
    dimension (the crossfilter convention). Replaces per-interaction
    SQL entirely — same numbers the DuckDB queries produced, verified
    against the same anchors. */
function computePage(bundle: TreesBundle, f: FilterState<Dim>): PageData {
  const { points, dicts } = bundle;
  // An active filter whose value is missing from the dictionary yields
  // -1, which matches no code — the honest render of a stale filter.
  const sel = (names: string[], v: string | null) =>
    v === null ? null : names.indexOf(v);
  const gSel = sel(dicts.genus, f.genus);
  const cSel = sel(dicts.clim, f.clim);
  const bSel = sel(dicts.borough, f.borough);
  const lSel = sel(dicts.loc, f.loc);
  const aSel = sel(dicts.age, f.age);
  const lowC = dicts.clim.indexOf("Low");
  const vulnC = dicts.clim.indexOf("Vulnerable");
  const npC = dicts.clim.indexOf("Not provided");
  const hwC = dicts.loc.indexOf("Highways");

  const { genus, clim, loc, borough, age, pos } = points;
  const mask = new Float32Array(points.n);
  const kindBins = new Int32Array(dicts.genus.length);
  const climBins = new Int32Array(dicts.clim.length);
  let n = 0,
    lowvuln = 0,
    assessed = 0,
    highways = 0;
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    nb = -Infinity;
  for (let i = 0; i < points.n; i++) {
    const g = genus[i],
      c = clim[i],
      b = borough[i],
      l = loc[i],
      a = age[i];
    const mg = gSel === null || g === gSel;
    const mc = cSel === null || c === cSel;
    const rest =
      (bSel === null || b === bSel) &&
      (lSel === null || l === lSel) &&
      (aSel === null || a === aSel);
    if (!rest) continue;
    if (mc) kindBins[g]++;
    if (mg) climBins[c]++;
    if (mg && mc) {
      mask[i] = 1;
      n++;
      if (c === lowC || c === vulnC) lowvuln++;
      if (c !== npC) assessed++;
      if (l === hwC) highways++;
      const lon = pos[i * 2];
      const lat = pos[i * 2 + 1];
      if (lon < CLIP[0][0] || lon > CLIP[1][0]) continue;
      if (lat < CLIP[0][1] || lat > CLIP[1][1]) continue;
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > nb) nb = lat;
    }
  }

  const kindCounts = new Map(dicts.genus.map((g, i) => [g, kindBins[i]]));
  const kindScopeTotal = kindBins.reduce((a2, b2) => a2 + b2, 0);
  // Top kind under ALL filters: with a genus filter it is that genus
  // (its bin already carries every other filter); otherwise the argmax.
  let topKind: PageData["topKind"] = null;
  if (gSel !== null) {
    topKind = gSel >= 0 ? { g: f.genus!, n: kindBins[gSel] } : null;
  } else {
    let best = -1;
    for (let i = 0; i < kindBins.length; i++) {
      if (kindBins[i] > (best >= 0 ? kindBins[best] : 0)) best = i;
    }
    if (best >= 0 && kindBins[best] > 0)
      topKind = { g: dicts.genus[best], n: kindBins[best] };
  }
  const climTotal = climBins.reduce((a2, b2) => a2 + b2, 0);
  const clims: CategoryBar[] = CLIM_SHORT.map(([label, raw]) => {
    const idx = dicts.clim.indexOf(raw);
    const count = idx >= 0 ? climBins[idx] : 0;
    return { label, value: count, share: climTotal > 0 ? count / climTotal : 0 };
  });

  return {
    mask,
    extent: e < w ? null : [[w, s], [e, nb]],
    tiles: { n, lowvuln, assessed, highways },
    topKind,
    kindCounts,
    kindScopeTotal,
    clims,
  };
}

// ---- the page ----

export default function TreesDashboard() {
  const { filters: f, set, toggle, reset, isDefault } = useCrossFilter(DIMS);
  const [mode, setMode] = useState<ColourMode>("clim");
  const [bundle, setBundle] = useState<TreesBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTreesData()
      .then((b) => !cancelled && setBundle(b))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  // Every filter change is this one synchronous pass — no queries.
  const page = useMemo(
    () => (bundle ? computePage(bundle, f) : null),
    [bundle, f],
  );

  const pending = page === null && error === null;
  const tiles = page?.tiles ?? null;
  const dicts = bundle?.dicts ?? null;
  const totalAll = bundle?.totalAll ?? null;

  // Fixed membership (overall top 12), re-ranked by the counts now in
  // scope; a kind with nothing in scope keeps its row at zero length.
  const kindRows: RankedBar[] = (bundle?.topKindNames ?? [])
    .map((g) => {
      const count = page?.kindCounts.get(g) ?? 0;
      return { label: g, value: count, count };
    })
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const selectedKindCount =
    f.genus && page ? (page.kindCounts.get(f.genus) ?? 0) : null;

  const climShortOf = (raw: string) =>
    CLIM_SHORT.find(([, r]) => r === raw)?.[0] ?? raw;

  const kindsHeight = N_TOP_KINDS * KINDS_ROW + 52;

  return (
    <>
      <aside className="map-panel">
        <p className="map-home">
          <a href="#/">← UK Open Data Explorer</a>
        </p>
        <p className="chapter-kicker">Environment</p>
        <h2 className="dash-title">London&rsquo;s public trees</h2>
        <p className="dash-sub">
          Every tree in the Greater London Authority&rsquo;s public-realm
          inventory — 1.14 million street, park and estate trees recorded
          by the boroughs, TfL, the Royal Parks and others — with the
          GLA&rsquo;s assessment of how well each species suits
          London&rsquo;s projected 2090 climate. Filter, or click the
          charts, and the map redraws.
        </p>

        <div className="mode-row">
          <span className="filter-label">Colour by</span>
          <Segmented
            label="Colour the map by"
            options={[
              { value: "clim", label: "2090 climate" },
              { value: "genus", label: "Kind" },
            ]}
            value={mode}
            onChange={(v) => setMode(v as ColourMode)}
          />
        </div>
        <Legend items={mode === "clim" ? CLIM_LEGEND : GENUS_LEGEND} />

        <div className="filter-bar">
          <span className="filter-group">
            <span className="filter-label">Kind</span>
            <Select
              label="Filter by kind of tree"
              options={[
                { value: "", label: "All kinds" },
                ...(dicts?.genus ?? []).map((g) => ({ value: g, label: g })),
              ]}
              value={f.genus ?? ""}
              onChange={(v) => set("genus", v === "" ? null : v)}
            />
          </span>
          <span className="filter-group">
            <span className="filter-label">2090 outlook</span>
            <Select
              label="Filter by 2090 climate suitability"
              options={[
                { value: "", label: "All assessments" },
                ...CLIMS.map((c) => ({
                  value: c,
                  label: c === "Not provided" ? "Not assessed" : c,
                })),
              ]}
              value={f.clim ?? ""}
              onChange={(v) => set("clim", v === "" ? null : v)}
            />
          </span>
          <span className="filter-group">
            <span className="filter-label">Borough</span>
            <Select
              label="Filter by borough"
              options={[
                { value: "", label: "All boroughs" },
                ...(dicts?.borough ?? []).map((b) => ({ value: b, label: b })),
              ]}
              value={f.borough ?? ""}
              onChange={(v) => set("borough", v === "" ? null : v)}
            />
          </span>
          <span className="filter-group">
            <span className="filter-label">Location</span>
            <Select
              label="Filter by location type"
              options={[
                { value: "", label: "All locations" },
                ...LOCS.map((l) => ({ value: l, label: l })),
              ]}
              value={f.loc ?? ""}
              onChange={(v) => set("loc", v === "" ? null : v)}
            />
          </span>
          <span className="filter-group">
            <span className="filter-label">Age</span>
            <Select
              label="Filter by age category"
              options={[
                { value: "", label: "All ages" },
                ...AGES.map((a) => ({ value: a, label: a })),
              ]}
              value={f.age ?? ""}
              onChange={(v) => set("age", v === "" ? null : v)}
            />
          </span>
          <button type="button" className="reset" disabled={isDefault} onClick={reset}>
            Reset
          </button>
        </div>

        {error && (
          <div className="notice" role="alert">
            <strong>The query failed.</strong> {error}
            <br />
            The dataset itself is at{" "}
            <a href={hfRepoUrl(FAMILY)}>huggingface.co/datasets/…/{FAMILY}</a>.
          </div>
        )}

        <StatRow>
          <StatTile
            label="Trees in scope"
            loading={pending}
            value={tiles ? fmtInt(tiles.n) : "—"}
            delta={
              totalAll !== null ? `of ${fmtInt(totalAll)} recorded trees` : undefined
            }
          />
          <StatTile
            label="Most common kind"
            loading={pending}
            value={page?.topKind?.g ?? "—"}
            delta={
              page?.topKind ? `${fmtInt(page.topKind.n)} trees in scope` : undefined
            }
          />
          <StatTile
            label="Low or vulnerable"
            loading={pending}
            value={
              tiles && tiles.assessed > 0
                ? fmtPct(tiles.lowvuln / tiles.assessed)
                : "—"
            }
            delta="of assessed trees, for the 2090 climate"
          />
          <StatTile
            label="On highways"
            loading={pending}
            value={tiles && tiles.n > 0 ? fmtPct(tiles.highways / tiles.n) : "—"}
            delta="street trees rather than parks or estates"
          />
        </StatRow>

        <div className="chart-card">
          <h3>Kinds of tree</h3>
          <p className="chart-sub">
            The overall top {N_TOP_KINDS} of {dicts?.genus.length ?? 44}{" "}
            recorded kinds, counted for{" "}
            {scopePhrase(f, { genus: true })}. Click a row to filter
            {f.genus && selectedKindCount !== null ? (
              <>
                {" "}
                — <strong>{f.genus}</strong>: {fmtInt(selectedKindCount)} in
                scope.
              </>
            ) : (
              <>; the Kind filter lists every kind.</>
            )}
          </p>
          {page ? (
            <RankedBars
              rows={kindRows}
              rowHeight={KINDS_ROW}
              labelWidth={76}
              formatTick={fmtCompact}
              formatValue={fmtInt}
              tipValue={(row) => `${fmtInt(row.value)} trees`}
              tipLabel={(row) =>
                page.kindScopeTotal > 0
                  ? `${row.label} · ${fmtPct(row.value / page.kindScopeTotal)} of these trees`
                  : row.label
              }
              selected={f.genus}
              onSelect={(label) => toggle("genus", label)}
              ariaLabel="The twelve most common kinds of tree, ranked by count in the current scope. Use arrow keys to step through the rows; Enter filters the page to that kind."
            />
          ) : (
            pending && <LoadingPanel height={kindsHeight} />
          )}
        </div>

        <div className="chart-card">
          <h3>The 2090 outlook</h3>
          <p className="chart-sub">
            The GLA&rsquo;s climate-suitability assessment of each
            tree&rsquo;s species against projected 2090 conditions, for{" "}
            {scopePhrase(f, { clim: true })}. Click a bar to filter.
          </p>
          {page ? (
            <CategoryBars
              bars={page.clims}
              height={CLIM_CHART_H}
              selected={f.clim ? climShortOf(f.clim) : null}
              onSelect={(label) => {
                const raw = CLIM_SHORT.find(([l]) => l === label)?.[1];
                if (raw) toggle("clim", raw);
              }}
              formatTick={fmtCompact}
              formatValue={fmtInt}
              tipLabel={(b) => `${fmtPct(b.share ?? 0)} of these trees`}
              ariaLabel="Trees by 2090 climate-suitability class. Use arrow keys to step through the bars; Enter filters the page to that class."
            />
          ) : (
            pending && <LoadingPanel height={CLIM_CHART_H} />
          )}
        </div>

        <div className="caveats">
          <h4>How to read this</h4>
          <ul>
            <li>
              This is <em>not</em> London&rsquo;s whole urban forest. The
              GLA&rsquo;s i-Tree survey estimates 8&nbsp;million-plus trees
              in London; this inventory covers the ~1.14&nbsp;million in
              the publicly maintained realm — highways, parks, and some
              school and housing land. Gardens and most woodland are out
              of scope.
            </li>
            <li>
              Counts measure <em>records supplied</em>, not trees on the
              ground: coverage varies hugely by organisation (Croydon
              supplied ~1,200 records, Enfield ~110,000), and where no
              update was supplied the GLA carries older records forward.
              Never compare boroughs by their totals here.
            </li>
            <li>
              The 2090 score is the GLA&rsquo;s composite assessment of
              each <em>species</em> against projected 2090 London
              conditions — not an assessment of the individual tree. About
              one tree in ten has no assessment.
            </li>
            <li>
              Sizes and ages are as published: a mix of exact values,
              supplier-specific bands and &ldquo;not recorded&rdquo;. The
              tooltip shows them verbatim.
            </li>
            <li>
              At London-wide zoom the dots overlap heavily — the map reads
              as density, and the colour balance shifts with the draw
              order. Zoom in for individual trees.
            </li>
          </ul>
          <p>
            Data: <a href={hfRepoUrl(FAMILY)}>{FAMILY} on Hugging Face</a> ·
            collated by GiGL for the{" "}
            <a href="https://data.london.gov.uk/dataset/local-authority-maintained-trees/">
              Greater London Authority
            </a>{" "}
            (November 2025 edition, occasional updates) under OGL v3.0. The
            GLA publishes its own map of this data.
          </p>
        </div>
      </aside>

      <div className="map-stage">
        <TreesMap
          points={bundle?.points ?? null}
          dicts={dicts}
          mode={mode}
          mask={page?.mask ?? null}
          focusBounds={isDefault ? null : (page?.extent ?? null)}
        />
        {bundle === null && error === null && (
          <p className="stage-note">
            Loading 1.1&nbsp;million trees — about 27&nbsp;MB, fetched and
            indexed in your browser. The first visit takes a few seconds.
          </p>
        )}
      </div>
    </>
  );
}
