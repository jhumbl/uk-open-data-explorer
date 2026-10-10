import { useEffect, useState } from "react";
import { loadTable, query } from "../../lib/duckdb";
import { hfFileUrl, hfRepoUrl } from "../../lib/catalog";
import {
  buildWhere,
  sqlString,
  useCrossFilter,
  type FilterState,
} from "../../lib/crossfilter";
import {
  fmtCompact,
  fmtDec1,
  fmtInt,
  fmtPct,
  fmtSignedInt,
  fmtSignedPct,
} from "../../lib/format";
import { StatRow, StatTile } from "../../components/charts/StatTile";
import LoadingPanel from "../../components/charts/LoadingPanel";
import Segmented from "../../components/charts/Segmented";
import Select from "../../components/charts/Select";
import CategoryBars, { type CategoryBar } from "../../components/charts/CategoryBars";
import RankedBars, { type RankedBar } from "../../components/charts/RankedBars";
import LineChart, { type Point } from "../../components/charts/LineChart";

/**
 * Electric vehicle uptake — the second adopter of the cross-filter kit
 * (charts skill · Dashboard philosophy; pilot: food-hygiene-london).
 *
 * Design spec (2026-07-17, anchored against the live parquets that day):
 *   - One question: how fast is the switch to electric happening — and
 *     where, in what form, and kept by whom?
 *   - The data is a STOCK: ULEVs licensed at each quarter's end (UK
 *     2025 Q4: 2,843,872 ULEVs, 65.8% battery electric, 6.73% of a
 *     42,283,514-vehicle fleet). "Net change" is additions minus
 *     deregistrations, never new registrations.
 *   - Dimensions: fuel (4), keepership (2), and a place hierarchy
 *     (UK → 12 regions → ~400 local authorities; the audience is LAs,
 *     who want their own patch). All filterable from the bar; fuel and
 *     region also by clicking their charts. Picking an LA auto-sets its
 *     parent region so the Select narrows, the regions chart highlight
 *     and the peers table stay coherent; changing region clears the LA.
 *
 * The VEH tables are a margins cube — the site's single biggest
 * correctness trap. NEVER sum across the cube: every filter maps to a
 * publisher cube coordinate (fuel/keepership 'Total', geography
 * K02000001 by default) and every query reads the publisher's own
 * aggregate rows. The 12 region rows partition the UK exactly; the LA
 * partition regex scopes the table card. Rates divide by VEH0105's
 * all-vehicle rows (body_type and fuel at 'Total'; count_thousands is
 * in THOUSANDS). See CLAUDE.md · Query discipline.
 *
 * Query budget: two parquet fetches at load (~7.1 MB projected down to
 * the columns used), then ~8 in-memory queries per interaction — zero
 * network per click.
 */

const FAMILY = "dft-vehicle-licensing";
const F_ULEV = "dft_veh0132_ulev_by_la.parquet";
const F_FLEET = "dft_veh0105_licensed_by_la.parquet";

const T_ULEV = "veh0132_ulev";
const T_FLEET = "veh0105_fleet";
const T_GEO = "veh_geo_regions";

const LOAD_ULEV = `
  SELECT ons_code, ons_geography, ons_sort, fuel, keepership, quarter, count
  FROM read_parquet('${hfFileUrl(FAMILY, F_ULEV)}')
`;
// Denominators only: every licensed vehicle, publisher margins pinned.
const LOAD_FLEET = `
  SELECT ons_code, keepership, quarter, count_thousands * 1000 AS total
  FROM read_parquet('${hfFileUrl(FAMILY, F_FLEET)}')
  WHERE body_type = 'Total' AND fuel = 'Total'
`;

const REGION_RE = "^(E12|W92|S92|N92)";
/** The non-overlapping local-authority partition of the UK. */
const LA_RE = "^(E06|E07|E08|E09|W06|S12|N09)";

// The contract has no region column for local authorities, so membership
// is derived from DfT's own presentation order: a carry-forward of the
// last region heading over the hierarchically sorted latest-quarter
// slice (verified 2026-07-17: 447 rows, unique ons_sort). The proper fix
// is a region_code column upstream in the pipeline.
const LOAD_GEO = `
  WITH slice AS (
    SELECT ons_code, ons_geography,
           last_value(CASE WHEN regexp_matches(ons_code, '${REGION_RE}') THEN ons_code END IGNORE NULLS)
             OVER (ORDER BY ons_sort ROWS UNBOUNDED PRECEDING) AS region_code
    FROM ${T_ULEV}
    WHERE quarter = (SELECT max(quarter) FROM ${T_ULEV})
      AND fuel = 'Total' AND keepership = 'Total'
  )
  SELECT ons_code, ons_geography AS la_name, region_code
  FROM slice
  WHERE regexp_matches(ons_code, '${LA_RE}')
`;

/** DfT's fuel categories: raw value → chart/filter label → prose noun. */
const FUELS = [
  { value: "Battery electric", label: "Battery electric", noun: "battery-electric ULEVs" },
  { value: "Plug-in hybrid electric (petrol)", label: "PHEV petrol", noun: "petrol plug-in hybrids" },
  { value: "Plug-in hybrid electric (diesel)", label: "PHEV diesel", noun: "diesel plug-in hybrids" },
  { value: "Other fuel types", label: "Other", noun: "other-fuel ULEVs" },
] as const;
const fuelLabel = (raw: string) => FUELS.find((x) => x.value === raw)?.label ?? raw;
const fuelNoun = (raw: string) => FUELS.find((x) => x.value === raw)?.noun ?? raw;

const KEEPS = [
  { value: "Private", label: "Private", noun: "privately kept" },
  { value: "Company", label: "Company", noun: "company kept" },
] as const;
const keepNoun = (raw: string) =>
  KEEPS.find((k) => k.value === raw)?.noun ?? raw;

const DIMS = ["fuel", "keepership", "region", "la"] as const;
type Dim = (typeof DIMS)[number];

// Dense two-up layout (registry `wide` + .dash-grid) in a deliberately
// narrow working width (960px container — user, 2026-07-17). The
// regions card spans two rows, and 12 rows are all the UK has — so its
// pitch is loose (rule 9: a tall card's pitch is tuned so the chart
// meets the neighbouring column's height), giving thicker bars, in
// keeping with "bars fill their band" for few categories.
const CHART_HEIGHT = 200;
const LINE_HEIGHT = 260;
const REGION_ROW = 33;
const N_REGIONS = 12;
const REGIONS_HEIGHT = N_REGIONS * REGION_ROW + 52;
const NET_QUARTERS = 20;
const LA_ROWS = 10;
// header row + 10 body rows at the table's natural pitch.
const TABLE_MIN_HEIGHT = 404;

/** Every filter is a cube coordinate: the publisher margin when off.
    Geography is a hierarchy — the finest active level wins. */
function pins(f: FilterState<Dim>) {
  return {
    fuel: f.fuel ?? "Total",
    keep: f.keepership ?? "Total",
    geo: f.la ?? f.region ?? "K02000001",
  };
}

/** "2025 Q4" → "2024 Q4" (lexicographic order equals temporal order). */
function yearBefore(q: string): string {
  return `${Number(q.slice(0, 4)) - 1}${q.slice(4)}`;
}

interface RegionOption {
  code: string;
  name: string;
}
interface LaOption {
  code: string;
  name: string;
  region: string | null;
}
interface RegionStat {
  code: string;
  name: string;
  n: number;
  total: number;
}
interface LaRow {
  code: string;
  name: string;
  region: string | null;
  n: number;
  rate: number;
}
interface Data {
  q: string;
  yq: string;
  n: number | null;
  yr: number | null;
  fleet: number | null;
  fleetYr: number | null;
  fuelMix: CategoryBar[];
  regionsRaw: RegionStat[];
  ukRef: { n: number; total: number } | null;
  net: CategoryBar[];
  series: { quarter: string; n: number; total: number }[];
  las: LaRow[];
  /** Selected LA's rank among the LAs in scope, by rate; null unless
      an LA filter is set. */
  laRank: number | null;
  laTotal: number;
}

async function runQueries(f: FilterState<Dim>): Promise<Data> {
  const p = pins(f);
  const [{ q }] = await query<{ q: string }>(
    `SELECT max(quarter) AS q FROM ${T_ULEV}`,
  );
  const yq = yearBefore(q);
  // A facet omits its own dimension; everything else is pinned to its
  // cube coordinate (never a bare WHERE — that would sum the cube).
  const pin: Record<Dim, string> = {
    fuel: p.fuel,
    keepership: p.keep,
    region: p.geo,
    la: p.geo,
  };
  const cube = (dim: Dim, column: string) =>
    `${column} = ${sqlString(pin[dim])}`;

  // Tiles — every filter applied.
  const [ulevNow] = await query<{ n: number | null; yr: number | null }>(`
    SELECT max(CASE WHEN quarter = ${sqlString(q)} THEN count END) AS n,
           max(CASE WHEN quarter = ${sqlString(yq)} THEN count END) AS yr
    FROM ${T_ULEV}
    ${buildWhere([cube("fuel", "fuel"), cube("keepership", "keepership"), cube("region", "ons_code")])}
  `);
  const [fleetNow] = await query<{ n: number | null; yr: number | null }>(`
    SELECT max(CASE WHEN quarter = ${sqlString(q)} THEN total END) AS n,
           max(CASE WHEN quarter = ${sqlString(yq)} THEN total END) AS yr
    FROM ${T_FLEET}
    ${buildWhere([cube("keepership", "keepership"), cube("region", "ons_code")])}
  `);

  // Fuel mix — excludes the fuel filter; fixed four bins, zero-filled.
  const fuelRaw = await query<{ fuel: string; n: number | null }>(`
    SELECT fuel, count AS n
    FROM ${T_ULEV}
    ${buildWhere([
      `quarter = ${sqlString(q)}`,
      `fuel != 'Total'`,
      cube("keepership", "keepership"),
      cube("region", "ons_code"),
    ])}
  `);
  const fuelTotal = fuelRaw.reduce((s, r) => s + (r.n ?? 0), 0);
  const fuelMix: CategoryBar[] = FUELS.map((x) => {
    const n = fuelRaw.find((r) => r.fuel === x.value)?.n ?? 0;
    return { label: x.label, value: n, share: fuelTotal > 0 ? n / fuelTotal : 0 };
  });

  // Regions — excludes the region filter. The fuel filter scopes the
  // numerator; the denominator stays each region's whole fleet
  // (keepership scopes both). Zero-filled against the domain at render.
  const regionsRaw = await query<RegionStat>(`
    SELECT u.ons_code AS code, u.ons_geography AS name,
           coalesce(u.count, 0) AS n, f.total
    FROM ${T_ULEV} u
    JOIN ${T_FLEET} f USING (ons_code, quarter, keepership)
    ${buildWhere([
      `u.quarter = ${sqlString(q)}`,
      `regexp_matches(u.ons_code, '${REGION_RE}')`,
      cube("fuel", "u.fuel"),
      cube("keepership", "u.keepership"),
    ])}
  `);
  const ukRefRows = await query<{ n: number | null; total: number }>(`
    SELECT u.count AS n, f.total
    FROM ${T_ULEV} u
    JOIN ${T_FLEET} f USING (ons_code, quarter, keepership)
    ${buildWhere([
      `u.quarter = ${sqlString(q)}`,
      `u.ons_code = 'K02000001'`,
      cube("fuel", "u.fuel"),
      cube("keepership", "u.keepership"),
    ])}
  `);
  const ukRef =
    ukRefRows.length > 0 && ukRefRows[0].n !== null
      ? { n: ukRefRows[0].n, total: ukRefRows[0].total }
      : null;

  // Net change per quarter — every filter applied; fixed 20-bin window.
  const netRaw = await query<{ quarter: string; net: number | null }>(`
    SELECT quarter, count - lag(count) OVER (ORDER BY quarter) AS net
    FROM ${T_ULEV}
    ${buildWhere([
      cube("fuel", "fuel"),
      cube("keepership", "keepership"),
      cube("region", "ons_code"),
      "count IS NOT NULL",
    ])}
    ORDER BY quarter
  `);
  const net: CategoryBar[] = netRaw
    .filter((r): r is { quarter: string; net: number } => r.net !== null)
    .slice(-NET_QUARTERS)
    .map((r) => ({ label: r.quarter, value: r.net }));

  // The full time series — every filter applied.
  const series = await query<{ quarter: string; n: number; total: number }>(`
    SELECT u.quarter, u.count AS n, f.total
    FROM ${T_ULEV} u
    JOIN ${T_FLEET} f USING (ons_code, quarter, keepership)
    ${buildWhere([
      cube("fuel", "u.fuel"),
      cube("keepership", "u.keepership"),
      cube("region", "u.ons_code"),
      "u.count IS NOT NULL",
    ])}
    ORDER BY u.quarter
  `);

  // LA table — the fuel/keepership filters and the REGION scope apply;
  // the LA filter does not narrow it (an LA's peers are the point) but
  // is answered by rank + highlight. Fetch the whole scope (≤ ~400
  // rows, in memory) so the selected LA's rank is exact even when it
  // sits outside the visible top ten.
  const lasAll = await query<LaRow>(`
    SELECT g.ons_code AS code, g.la_name AS name, g.region_code AS region,
           u.count AS n, u.count / f.total * 1000 AS rate
    FROM ${T_ULEV} u
    JOIN ${T_GEO} g USING (ons_code)
    JOIN ${T_FLEET} f USING (ons_code, quarter, keepership)
    ${buildWhere([
      `u.quarter = ${sqlString(q)}`,
      cube("fuel", "u.fuel"),
      cube("keepership", "u.keepership"),
      f.region ? `g.region_code = ${sqlString(f.region)}` : null,
      "u.count IS NOT NULL",
      "f.total > 0",
    ])}
    ORDER BY rate DESC, name
  `);
  const laIdx = f.la ? lasAll.findIndex((r) => r.code === f.la) : -1;

  return {
    q,
    yq,
    n: ulevNow.n,
    yr: ulevNow.yr,
    fleet: fleetNow.n,
    fleetYr: fleetNow.yr,
    fuelMix,
    regionsRaw,
    ukRef,
    net,
    series,
    las: lasAll.slice(0, LA_ROWS),
    laRank: laIdx >= 0 ? laIdx + 1 : null,
    laTotal: lasAll.length,
  };
}

/** The scope phrase for subtitles — built from the active filters,
    minus a card's own dimension. `placeLabel` is the finest active
    geography's display name (LA over region), or null at UK scope. */
function scopePhrase(
  f: FilterState<Dim>,
  placeLabel: string | null,
  exclude: Partial<Record<Dim, boolean>> = {},
): string {
  const head = !exclude.fuel && f.fuel ? fuelNoun(f.fuel) : "all ULEVs";
  const keep =
    !exclude.keepership && f.keepership ? keepNoun(f.keepership) : null;
  const place =
    !exclude.region && placeLabel ? `in ${placeLabel}` : "across the UK";
  return `${head}${keep ? `, ${keep},` : ""} ${place}`;
}

export default function UlevUptakeDashboard() {
  const { filters: f, set, toggle, reset, isDefault } = useCrossFilter(DIMS);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [las, setLas] = useState<LaOption[]>([]);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regionMode, setRegionMode] = useState<"rate" | "count">("rate");
  const [lineMode, setLineMode] = useState<"count" | "share">("count");

  // Geography is a hierarchy, so the two controls stay coherent:
  // picking an LA also pins its parent region (the LA Select narrows,
  // the regions chart highlights the parent); changing region — from
  // the Select OR a chart click — drops any LA outside it.
  const laByCode = new Map(las.map((l) => [l.code, l]));
  const setLa = (code: string | null) => {
    set("la", code);
    if (code) {
      const parent = laByCode.get(code)?.region ?? null;
      if (parent) set("region", parent);
    }
  };
  const setRegion = (code: string | null) => {
    set("region", code);
    if (f.la && laByCode.get(f.la)?.region !== code) set("la", null);
  };

  // Load both parquets and the derived region lookup once, then fetch
  // the region domain — the Select renders immediately with just "All"
  // and gains its options without moving.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadTable(T_ULEV, LOAD_ULEV);
      await loadTable(T_FLEET, LOAD_FLEET);
      await loadTable(T_GEO, LOAD_GEO);
      const rows = await query<RegionOption>(`
        SELECT ons_code AS code, ons_geography AS name
        FROM ${T_ULEV}
        WHERE quarter = (SELECT max(quarter) FROM ${T_ULEV})
          AND fuel = 'Total' AND keepership = 'Total'
          AND regexp_matches(ons_code, '${REGION_RE}')
        ORDER BY ons_sort
      `);
      const laRows = await query<LaOption>(`
        SELECT ons_code AS code, la_name AS name, region_code AS region
        FROM ${T_GEO}
        ORDER BY la_name
      `);
      if (cancelled) return;
      setRegions(rows);
      setLas(laRows);
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  // Every filter change re-runs the page's queries against the
  // in-memory tables. Previous data stays on screen until the new rows
  // land (milliseconds), then everything snaps — no transitions.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadTable(T_ULEV, LOAD_ULEV);
      await loadTable(T_FLEET, LOAD_FLEET);
      await loadTable(T_GEO, LOAD_GEO);
      const d = await runQueries(f);
      if (!cancelled) setData(d);
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [f]);

  const pending = data === null && error === null;

  // Region names: the domain when it's landed, the queried rows as the
  // first-paint fallback.
  const regionDomain: RegionOption[] =
    regions.length > 0
      ? regions
      : (data?.regionsRaw ?? []).map((r) => ({ code: r.code, name: r.name }));
  const regionName = (code: string) =>
    regionDomain.find((r) => r.code === code)?.name ?? code;

  // Fixed-geometry ranking rows: every region always present (a region
  // with nothing in scope keeps a zero-length bar), sorted best-first
  // on the active measure.
  const statByCode = new Map((data?.regionsRaw ?? []).map((r) => [r.code, r]));
  const regionStats = regionDomain
    .map((r) => {
      const s = statByCode.get(r.code);
      const n = s?.n ?? 0;
      const total = s?.total ?? 0;
      return { ...r, n, total, rate: total > 0 ? (n / total) * 1000 : 0 };
    })
    .sort((a, b) =>
      regionMode === "rate"
        ? b.rate - a.rate || a.name.localeCompare(b.name)
        : b.n - a.n || a.name.localeCompare(b.name),
    );
  const regionRows: RankedBar[] = regionStats.map((r) => ({
    label: r.name,
    value: regionMode === "rate" ? r.rate : r.n,
    count: r.n,
  }));
  const statByName = new Map(regionStats.map((r) => [r.name, r]));
  const regionRank = f.region
    ? regionStats.findIndex((r) => r.code === f.region)
    : -1;
  const ukRate =
    data?.ukRef && data.ukRef.total > 0
      ? (data.ukRef.n / data.ukRef.total) * 1000
      : null;

  const share =
    data?.n != null && data.fleet ? data.n / data.fleet : null;
  const shareYr =
    data?.yr != null && data.fleetYr ? data.yr / data.fleetYr : null;
  const sharePp =
    share !== null && shareYr !== null ? (share - shareYr) * 100 : null;
  const yoy =
    data?.n != null && data.yr ? (data.n - data.yr) / data.yr : null;
  const added = data?.n != null && data.yr != null ? data.n - data.yr : null;

  const points: Point[] = (data?.series ?? []).map((r) => ({
    label: r.quarter,
    value: lineMode === "share" ? (r.total > 0 ? r.n / r.total : 0) : r.n,
  }));

  const laName = (code: string) => laByCode.get(code)?.name ?? code;
  const placeLabel = f.la
    ? laName(f.la)
    : f.region
      ? regionName(f.region)
      : null;
  const scope = (exclude?: Partial<Record<Dim, boolean>>) =>
    scopePhrase(f, placeLabel, exclude);

  // One Area control for the whole geography hierarchy: a flat "All",
  // then Regions and Local authorities as labelled sections. The value
  // shown is the finest active level.
  const regionCodes = new Set(regions.map((r) => r.code));
  const setArea = (v: string | null) => {
    if (v === null) {
      set("region", null);
      set("la", null);
    } else if (regionCodes.has(v)) {
      setRegion(v);
    } else {
      setLa(v);
    }
  };

  // Always LA_ROWS table rows — the card must not change size when a
  // narrow filter state returns fewer.
  const tableRows: (LaRow | null)[] = Array.from(
    { length: LA_ROWS },
    (_, i) => data?.las[i] ?? null,
  );

  return (
    <>
      <h2 className="dash-title">Ultra low emission vehicles</h2>
      <p className="dash-sub">
        Ultra low emission vehicles (ULEVs) licensed in the United Kingdom
        at the end of each quarter — a stock of vehicles on the road, not a
        flow of new registrations. DfT tables VEH0132 and VEH0105, built
        from DVLA data. Click any chart, or use the filters, to slice the
        whole page.
      </p>

      <div className="filter-bar">
        <span className="filter-group">
          <span className="filter-label">Area</span>
          <Select
            label="Filter by area — regions and local authorities"
            options={[{ value: "", label: "All of the UK" }]}
            groups={[
              {
                label: "Regions",
                options: regions.map((r) => ({ value: r.code, label: r.name })),
              },
              {
                label: "Local authorities",
                options: las.map((l) => ({ value: l.code, label: l.name })),
              },
            ]}
            value={f.la ?? f.region ?? ""}
            onChange={(v) => setArea(v === "" ? null : v)}
          />
        </span>
        <span className="filter-group">
          <span className="filter-label">Fuel</span>
          <Select
            label="Filter by fuel"
            options={[
              { value: "", label: "All fuels" },
              ...FUELS.map((x) => ({ value: x.value as string, label: x.label })),
            ]}
            value={f.fuel ?? ""}
            onChange={(v) => set("fuel", v === "" ? null : v)}
          />
        </span>
        <span className="filter-group">
          <span className="filter-label">Keepership</span>
          <Segmented
            label="Filter by keepership"
            options={[
              { value: "", label: "All" },
              ...KEEPS.map((k) => ({ value: k.value as string, label: k.label })),
            ]}
            value={f.keepership ?? ""}
            onChange={(v) => set("keepership", v === "" ? null : v)}
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
          label="Licensed ULEVs"
          loading={pending}
          value={data?.n != null ? fmtCompact(data.n) : "—"}
          delta={
            yoy !== null && data ? (
              <>
                <span className={yoy >= 0 ? "dir-up" : "dir-down"}>
                  {fmtSignedPct(yoy)}
                </span>{" "}
                vs {data.yq}
              </>
            ) : undefined
          }
        />
        <StatTile
          label="Share of all licensed vehicles"
          loading={pending}
          value={share !== null ? fmtPct(share) : "—"}
          delta={
            sharePp !== null && data ? (
              <>
                <span className={sharePp >= 0 ? "dir-up" : "dir-down"}>
                  {sharePp >= 0 ? "+" : ""}
                  {sharePp.toFixed(1)} pp
                </span>{" "}
                vs {data.yq}
              </>
            ) : undefined
          }
        />
        <StatTile
          label="Added in the last year"
          loading={pending}
          value={
            added !== null
              ? `${added >= 0 ? "+" : ""}${fmtCompact(added)}`
              : "—"
          }
          delta="net change in the stock over four quarters"
        />
        <StatTile
          label="Latest quarter"
          loading={pending}
          value={data ? data.q : "—"}
          delta="DfT publishes quarterly"
        />
      </StatRow>

      <div className="dash-grid">
        {/* The headline chart leads (user, 2026-07-17): the uptake curve
            is the page's most important read. Detail card — follows
            every filter, not itself clickable (v1). */}
        <div className="chart-card full">
          <h3>Licensed ULEVs over time</h3>
          <p className="chart-sub">
            End-of-quarter stock of {scope()}
            {data && data.series.length > 0
              ? `, ${data.series[0].quarter} → ${data.q}`
              : ""}
            . The share view divides by all licensed vehicles in the same
            scope.
          </p>
          <Segmented
            label="Time series measure"
            options={[
              { value: "count", label: "Count" },
              { value: "share", label: "Share of all vehicles" },
            ]}
            value={lineMode}
            onChange={setLineMode}
          />
          {data && points.length > 0 ? (
            <LineChart
              points={points}
              height={LINE_HEIGHT}
              formatTick={lineMode === "share" ? fmtPct : fmtCompact}
              formatValue={lineMode === "share" ? fmtPct : fmtInt}
              ariaLabel="Licensed ULEVs by quarter under the active filters. Use arrow keys to step through values."
            />
          ) : (
            pending && <LoadingPanel height={LINE_HEIGHT} />
          )}
        </div>

        <div className="chart-card">
          <h3>Fuel mix</h3>
          <p className="chart-sub">
            The ULEV stock by fuel type, {scope({ fuel: true })}
            {data ? `, ${data.q}` : ""}. Click a bar to filter the page to
            that fuel.
          </p>
          {data ? (
            <CategoryBars
              bars={data.fuelMix}
              height={CHART_HEIGHT}
              selected={f.fuel ? fuelLabel(f.fuel) : null}
              onSelect={(label) => {
                const raw = FUELS.find((x) => x.label === label)?.value;
                if (raw) toggle("fuel", raw);
              }}
              formatTick={fmtCompact}
              formatValue={fmtInt}
              tipLabel={(b) =>
                `${b.label} · ${fmtPct(b.share ?? 0)} of ULEVs in scope`
              }
              ariaLabel="Licensed ULEVs by fuel type. Use arrow keys to step through the bars; Enter filters the page to that fuel."
            />
          ) : (
            pending && <LoadingPanel height={CHART_HEIGHT} />
          )}
        </div>

        <div className="chart-card tall">
          <h3>Regions, ranked</h3>
          <p className="chart-sub">
            {f.fuel ? `${fuelNoun(f.fuel)[0].toUpperCase()}${fuelNoun(f.fuel).slice(1)}` : "ULEVs"}
            {f.keepership ? `, ${keepNoun(f.keepership)},` : ""}{" "}
            {regionMode === "rate"
              ? `per 1,000 licensed vehicles${f.fuel ? " of any fuel" : ""}`
              : "licensed"}{" "}
            in each region{data ? `, ${data.q}` : ""}. Click a row to focus
            that region.
            {regionRank >= 0 && f.region ? (
              <>
                {" "}
                <strong>{regionName(f.region)}</strong> ranks{" "}
                {regionRank + 1} of {regionStats.length}.
              </>
            ) : null}
          </p>
          <Segmented
            label="Regions measure"
            options={[
              { value: "rate", label: "Per 1,000 vehicles" },
              { value: "count", label: "Count" },
            ]}
            value={regionMode}
            onChange={setRegionMode}
          />
          {data ? (
            <RankedBars
              rows={regionRows}
              rowHeight={REGION_ROW}
              refValue={
                regionMode === "rate" && ukRate !== null ? ukRate : undefined
              }
              refLabel="UK"
              formatTick={fmtCompact}
              formatValue={regionMode === "rate" ? fmtDec1 : fmtCompact}
              tipValue={(row) =>
                regionMode === "rate"
                  ? `${fmtDec1(row.value)} per 1,000 vehicles`
                  : `${fmtInt(row.value)} ULEVs`
              }
              tipLabel={(row) => {
                const s = statByName.get(row.label);
                return regionMode === "rate"
                  ? `${row.label} · ${fmtInt(row.count)} ULEVs`
                  : `${row.label} · ${s ? fmtDec1(s.rate) : "—"} per 1,000`;
              }}
              selected={f.region ? regionName(f.region) : null}
              onSelect={(label) => {
                const code = regionDomain.find((r) => r.name === label)?.code;
                if (code) setRegion(f.region === code ? null : code);
              }}
              ariaLabel="Regions ranked by licensed ULEVs. Use arrow keys to step through the rows; Enter filters the page to that region."
            />
          ) : (
            pending && <LoadingPanel height={REGIONS_HEIGHT} />
          )}
        </div>

        {/* Detail: follows every filter, not itself clickable (v1). */}
        <div className="chart-card">
          <h3>Net change per quarter</h3>
          <p className="chart-sub">
            Quarter-on-quarter change in the stock of {scope()} — additions
            minus deregistrations, not new registrations. Last five years.
          </p>
          {data ? (
            <CategoryBars
              bars={data.net}
              height={CHART_HEIGHT}
              formatTick={fmtCompact}
              formatValue={fmtSignedInt}
              tipLabel={(b) => `net change, ${b.label}`}
              ariaLabel="Net change in licensed ULEVs per quarter. Use arrow keys to step through the bars."
            />
          ) : (
            pending && <LoadingPanel height={CHART_HEIGHT} />
          )}
        </div>

        {/* Detail: an open table — exact values are this card's point. */}
        <div className="chart-card full">
          <h3>Local authorities</h3>
          <p className="chart-sub">
            The ten local authorities with the most{" "}
            {f.fuel ? fuelNoun(f.fuel) : "ULEVs"}
            {f.keepership ? `, ${keepNoun(f.keepership)},` : ""} per 1,000
            licensed vehicles
            {f.region ? ` in ${regionName(f.region)}` : ""}
            {data ? `, ${data.q}` : ""}. Vehicles sit at the keeper&rsquo;s
            postcode — company fleets swell head-office areas like
            Westminster.
            {f.la && data?.laRank ? (
              <>
                {" "}
                <strong>{laName(f.la)}</strong> ranks {data.laRank} of{" "}
                {data.laTotal}.
              </>
            ) : null}
          </p>
          {data ? (
            <div className="table-wrap" style={{ minHeight: TABLE_MIN_HEIGHT }}>
              <table>
                <thead>
                  <tr>
                    <th>Local authority</th>
                    <th>Region</th>
                    <th className="num">ULEVs</th>
                    <th className="num">Per 1,000 vehicles</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row, i) =>
                    row ? (
                      <tr key={row.name}>
                        <td>
                          {row.code === f.la ? (
                            <strong>{row.name}</strong>
                          ) : (
                            row.name
                          )}
                        </td>
                        <td>{row.region ? regionName(row.region) : "—"}</td>
                        <td className="num">{fmtInt(row.n)}</td>
                        <td className="num">{fmtDec1(row.rate)}</td>
                      </tr>
                    ) : (
                      <tr key={`empty-${i}`}>
                        <td>—</td>
                        <td />
                        <td className="num" />
                        <td className="num" />
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            pending && <LoadingPanel height={TABLE_MIN_HEIGHT} />
          )}
        </div>
      </div>

      <div className="caveats">
        <h4>How to read this</h4>
        <ul>
          <li>
            These are <strong>stocks</strong> — vehicles licensed at each
            quarter&rsquo;s end. &ldquo;Net change&rdquo; is additions minus
            deregistrations, not new registrations. UK-wide series start in
            2014 Q3, when Northern Ireland enters the data; regions run
            back to 2011 Q4.
          </li>
          <li>
            Vehicles are counted at the registered keeper&rsquo;s postcode,
            not where they are used. Company fleets registered to a head
            office swell that area&rsquo;s figures — Westminster&rsquo;s
            rate is a leasing-desk artefact, not half a borough of EVs. The
            keepership filter separates the two worlds.
          </li>
          <li>
            ULEV classification depends on reported CO₂ figures, whose test
            regime changed in April 2020 (NEDC → WLTP) — be careful
            comparing across that boundary.
          </li>
          <li>
            Rates divide by <em>all</em> licensed vehicles (VEH0105, every
            fuel and body type), so a fuel filter scopes the numerator
            only. Cells DfT suppressed are excluded, and the
            publisher&rsquo;s own aggregate rows are read directly — never
            summed with local-authority rows.
          </li>
          <li>
            Region membership for local authorities is derived from
            DfT&rsquo;s published presentation order.
          </li>
        </ul>
        <p>
          Data: <a href={hfRepoUrl(FAMILY)}>{FAMILY} on Hugging Face</a>{" "}
          (tables VEH0132 and VEH0105) · published by the{" "}
          <a href="https://www.gov.uk/government/statistical-data-sets/vehicle-licensing-statistics-data-tables">
            Department for Transport
          </a>{" "}
          under OGL v3.0.
        </p>
      </div>
    </>
  );
}
