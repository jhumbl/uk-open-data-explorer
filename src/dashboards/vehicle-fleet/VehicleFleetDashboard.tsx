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
  fmtInt,
  fmtPct,
  fmtPct0,
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
 * The vehicle fleet — the whole-fleet companion to ulev-uptake, on the
 * same cross-filter kit (charts skill · Dashboard philosophy).
 *
 * Design spec (2026-07-17, anchored against the live parquet that day):
 *   - One question: how many vehicles are on UK roads — of what kind,
 *     running on what, kept by whom, and where?
 *   - The data is a STOCK: vehicles licensed at each quarter's end (UK
 *     2025 Q4: 42,283,514 vehicles; 34,485,453 cars = 81.6%; petrol
 *     20,408,323 / diesel 16,021,280; +619,084 on 2024 Q4; +13.2% on
 *     2015 Q4). Battery electrics and plug-in hybrids live inside the
 *     publisher's "Other fuel types" — the electric story is
 *     ulev-uptake's job, cross-linked in the caveats.
 *   - Dimensions: body type (6), fuel (4), keepership (2), and the
 *     place hierarchy (UK → 12 regions → 361 LAs). Body, fuel and
 *     region also filter by clicking their charts.
 *
 * VEH0105 is the margins cube itself — every cell of body × fuel ×
 * keepership × geography × quarter, including publisher 'Total' rows
 * and aggregate geographies. NEVER sum across it: every filter maps to
 * a cube coordinate and every query reads the publisher's own rows.
 * count_thousands is in THOUSANDS (×1000 on load, once). Known
 * non-reconciliations, measured 2026-07-17: regions sum to 41,547,027
 * vs the UK's 42,283,514 (vehicles "under disposal" / region unknown
 * carry the rest); private + company = 41,540,771 (keepership has an
 * unpublished remainder). See CLAUDE.md · Query discipline.
 *
 * Query budget: one parquet fetch at load (~6.5 MB, projected to the
 * columns used, aggregate/'[z]' geographies dropped), then ~10
 * in-memory queries per interaction — zero network per click.
 */

const FAMILY = "dft-vehicle-licensing";
const F_FLEET = "dft_veh0105_licensed_by_la.parquet";

const T_FLEET = "veh0105_all";
const T_GEO = "veh0105_geo_regions";

const REGION_RE = "^(E12|W92|S92|N92)";
/** The non-overlapping local-authority partition of the UK (361 codes). */
const LA_RE = "^(E06|E07|E08|E09|W06|S12|N09)";

// Only the geographies the page can ever show: the UK row, the 12
// regions and the LA partition. GB/England, county aggregates and the
// '[z]' unknown/under-disposal rows never render — dropping them keeps
// the in-memory table lean (~2.2M rows).
const LOAD_FLEET = `
  SELECT ons_code, ons_geography, ons_sort, body_type, fuel, keepership,
         quarter, count_thousands * 1000 AS n
  FROM read_parquet('${hfFileUrl(FAMILY, F_FLEET)}')
  WHERE regexp_matches(ons_code, '^(K02|E12|W92|S92|N92|E06|E07|E08|E09|W06|S12|N09)')
`;

// The contract has no region column for local authorities, so membership
// is derived from DfT's own presentation order: a carry-forward of the
// last region heading over the hierarchically sorted latest-quarter
// slice (verified 2026-07-17 on VEH0105: ons_sort unique in the slice;
// 361 LAs, each with one of 12 regions). The proper fix is a
// region_code column upstream in the pipeline.
const LOAD_GEO = `
  WITH slice AS (
    SELECT ons_code, ons_geography,
           last_value(CASE WHEN regexp_matches(ons_code, '${REGION_RE}') THEN ons_code END IGNORE NULLS)
             OVER (ORDER BY ons_sort ROWS UNBOUNDED PRECEDING) AS region_code
    FROM ${T_FLEET}
    WHERE quarter = (SELECT max(quarter) FROM ${T_FLEET})
      AND body_type = 'Total' AND fuel = 'Total' AND keepership = 'Total'
  )
  SELECT ons_code, ons_geography AS la_name, region_code
  FROM slice
  WHERE regexp_matches(ons_code, '${LA_RE}')
`;

/** DfT's body types: raw value → chart/filter label → prose noun.
    Fixed bin order = UK size order, largest first. */
const BODIES = [
  { value: "Cars", label: "Cars", noun: "cars" },
  { value: "Light goods vehicles", label: "LGVs", noun: "light goods vehicles" },
  { value: "Motorcycles", label: "Motorcycles", noun: "motorcycles" },
  { value: "Other vehicles", label: "Other", noun: "other vehicles" },
  { value: "Heavy goods vehicles", label: "HGVs", noun: "heavy goods vehicles" },
  { value: "Buses and coaches", label: "Buses", noun: "buses and coaches" },
] as const;
const bodyLabel = (raw: string) => BODIES.find((x) => x.value === raw)?.label ?? raw;
const bodyNoun = (raw: string) => BODIES.find((x) => x.value === raw)?.noun ?? raw;

/** DfT's fuel categories for this table. Plug-ins are NOT a category:
    battery electrics and plug-in hybrids sit inside 'Other fuel types'. */
const FUELS = [
  { value: "Petrol", label: "Petrol", adj: "petrol" },
  { value: "Diesel", label: "Diesel", adj: "diesel" },
  { value: "Other fuel types", label: "Other fuels", adj: "other-fuel" },
  { value: "Hybrid electric (petrol)", label: "Hybrid (petrol)", adj: "petrol-hybrid" },
] as const;
const fuelLabel = (raw: string) => FUELS.find((x) => x.value === raw)?.label ?? raw;
const fuelAdj = (raw: string) => FUELS.find((x) => x.value === raw)?.adj ?? raw;

const KEEPS = [
  { value: "Private", label: "Private", noun: "privately kept" },
  { value: "Company", label: "Company", noun: "company kept" },
] as const;
const keepNoun = (raw: string) =>
  KEEPS.find((k) => k.value === raw)?.noun ?? raw;

const DIMS = ["body", "fuel", "keepership", "region", "la"] as const;
type Dim = (typeof DIMS)[number];

// Same dense two-up geometry as ulev-uptake (registry `wide` +
// .dash-grid): the regions card spans two rows at a loose 33px pitch so
// its 12 bars meet the stacked body/fuel cards beside it.
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
    body: f.body ?? "Total",
    fuel: f.fuel ?? "Total",
    keep: f.keepership ?? "Total",
    geo: f.la ?? f.region ?? "K02000001",
  };
}

/** "2025 Q4" → "2024 Q4" (lexicographic order equals temporal order). */
function yearsBefore(q: string, years: number): string {
  return `${Number(q.slice(0, 4)) - years}${q.slice(4)}`;
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
}
interface Data {
  q: string;
  yq: string;
  dq: string;
  n: number | null;
  yr: number | null;
  decade: number | null;
  bodyMix: CategoryBar[];
  fuelMix: CategoryBar[];
  regionsRaw: RegionStat[];
  ukRef: { n: number; total: number } | null;
  net: CategoryBar[];
  series: { quarter: string; n: number; total: number }[];
  /** The publisher's own cell for the area above the LA table (the
      region filter's area, or the UK) under the same pins — the share
      column's denominator. */
  areaN: number | null;
  las: LaRow[];
  /** Selected LA's rank among the LAs in scope, by count; null unless
      an LA filter is set. */
  laRank: number | null;
  laTotal: number;
}

/** Join clause pinning the second copy of the cube to the same
    geography/quarter/keepership but the all-body, all-fuel margin —
    the whole-fleet denominator for shares. */
const DENOM_JOIN = (u: string, f: string) => `
  JOIN ${T_FLEET} ${f}
    ON ${f}.ons_code = ${u}.ons_code AND ${f}.quarter = ${u}.quarter
   AND ${f}.keepership = ${u}.keepership
   AND ${f}.body_type = 'Total' AND ${f}.fuel = 'Total'
`;

async function runQueries(f: FilterState<Dim>): Promise<Data> {
  const p = pins(f);
  const [{ q }] = await query<{ q: string }>(
    `SELECT max(quarter) AS q FROM ${T_FLEET}`,
  );
  const yq = yearsBefore(q, 1);
  const dq = yearsBefore(q, 10);
  // A facet omits its own dimension; everything else is pinned to its
  // cube coordinate (never a bare WHERE — that would sum the cube).
  const pin: Record<Dim, string> = {
    body: p.body,
    fuel: p.fuel,
    keepership: p.keep,
    region: p.geo,
    la: p.geo,
  };
  const cube = (dim: Dim, column: string) =>
    `${column} = ${sqlString(pin[dim])}`;

  // Tiles — every filter applied; three time anchors in one pass.
  const [now] = await query<{
    n: number | null;
    yr: number | null;
    decade: number | null;
  }>(`
    SELECT max(CASE WHEN quarter = ${sqlString(q)} THEN n END) AS n,
           max(CASE WHEN quarter = ${sqlString(yq)} THEN n END) AS yr,
           max(CASE WHEN quarter = ${sqlString(dq)} THEN n END) AS decade
    FROM ${T_FLEET}
    ${buildWhere([
      cube("body", "body_type"),
      cube("fuel", "fuel"),
      cube("keepership", "keepership"),
      cube("region", "ons_code"),
    ])}
  `);

  // Body mix — excludes the body filter; fixed six bins, zero-filled.
  const bodyRaw = await query<{ k: string; n: number | null }>(`
    SELECT body_type AS k, n
    FROM ${T_FLEET}
    ${buildWhere([
      `quarter = ${sqlString(q)}`,
      `body_type != 'Total'`,
      cube("fuel", "fuel"),
      cube("keepership", "keepership"),
      cube("region", "ons_code"),
    ])}
  `);
  const bodyTotal = bodyRaw.reduce((s, r) => s + (r.n ?? 0), 0);
  const bodyMix: CategoryBar[] = BODIES.map((x) => {
    const n = bodyRaw.find((r) => r.k === x.value)?.n ?? 0;
    return { label: x.label, value: n, share: bodyTotal > 0 ? n / bodyTotal : 0 };
  });

  // Fuel mix — excludes the fuel filter; fixed four bins, zero-filled.
  const fuelRaw = await query<{ k: string; n: number | null }>(`
    SELECT fuel AS k, n
    FROM ${T_FLEET}
    ${buildWhere([
      `quarter = ${sqlString(q)}`,
      `fuel != 'Total'`,
      cube("body", "body_type"),
      cube("keepership", "keepership"),
      cube("region", "ons_code"),
    ])}
  `);
  const fuelTotal = fuelRaw.reduce((s, r) => s + (r.n ?? 0), 0);
  const fuelMix: CategoryBar[] = FUELS.map((x) => {
    const n = fuelRaw.find((r) => r.k === x.value)?.n ?? 0;
    return { label: x.label, value: n, share: fuelTotal > 0 ? n / fuelTotal : 0 };
  });

  // Regions — excludes the region filter. The body/fuel filters scope
  // the numerator; the denominator is each region's whole fleet
  // (keepership scopes both). Zero-filled against the domain at render.
  const regionsRaw = await query<RegionStat>(`
    SELECT u.ons_code AS code, u.ons_geography AS name,
           coalesce(u.n, 0) AS n, f.n AS total
    FROM ${T_FLEET} u
    ${DENOM_JOIN("u", "f")}
    ${buildWhere([
      `u.quarter = ${sqlString(q)}`,
      `regexp_matches(u.ons_code, '${REGION_RE}')`,
      cube("body", "u.body_type"),
      cube("fuel", "u.fuel"),
      cube("keepership", "u.keepership"),
    ])}
  `);
  const ukRefRows = await query<{ n: number | null; total: number }>(`
    SELECT u.n, f.n AS total
    FROM ${T_FLEET} u
    ${DENOM_JOIN("u", "f")}
    ${buildWhere([
      `u.quarter = ${sqlString(q)}`,
      `u.ons_code = 'K02000001'`,
      cube("body", "u.body_type"),
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
    SELECT quarter, n - lag(n) OVER (ORDER BY quarter) AS net
    FROM ${T_FLEET}
    ${buildWhere([
      cube("body", "body_type"),
      cube("fuel", "fuel"),
      cube("keepership", "keepership"),
      cube("region", "ons_code"),
      "n IS NOT NULL",
    ])}
    ORDER BY quarter
  `);
  const net: CategoryBar[] = netRaw
    .filter((r): r is { quarter: string; net: number } => r.net !== null)
    .slice(-NET_QUARTERS)
    .map((r) => ({ label: r.quarter, value: r.net }));

  // The full time series — every filter applied, with the whole-fleet
  // denominator for the share view.
  const series = await query<{ quarter: string; n: number; total: number }>(`
    SELECT u.quarter, u.n, f.n AS total
    FROM ${T_FLEET} u
    ${DENOM_JOIN("u", "f")}
    ${buildWhere([
      cube("body", "u.body_type"),
      cube("fuel", "u.fuel"),
      cube("keepership", "u.keepership"),
      cube("region", "u.ons_code"),
      "u.n IS NOT NULL",
    ])}
    ORDER BY u.quarter
  `);

  // The LA table's share denominator: the publisher's own cell for the
  // area the table ranks within (region filter or UK) under the same
  // body/fuel/keepership pins — never a sum of LA rows.
  const areaCode = f.region ?? "K02000001";
  const areaRows = await query<{ n: number | null }>(`
    SELECT n FROM ${T_FLEET}
    ${buildWhere([
      `quarter = ${sqlString(q)}`,
      `ons_code = ${sqlString(areaCode)}`,
      cube("body", "body_type"),
      cube("fuel", "fuel"),
      cube("keepership", "keepership"),
    ])}
  `);
  const areaN = areaRows.length > 0 ? areaRows[0].n : null;

  // LA table — the body/fuel/keepership filters and the REGION scope
  // apply; the LA filter does not narrow it (an LA's peers are the
  // point) but is answered by rank + highlight. Fetch the whole scope
  // (≤ 361 rows, in memory) so the selected LA's rank is exact even
  // when it sits outside the visible top ten.
  const lasAll = await query<LaRow>(`
    SELECT g.ons_code AS code, g.la_name AS name, g.region_code AS region,
           u.n AS n
    FROM ${T_FLEET} u
    JOIN ${T_GEO} g USING (ons_code)
    ${buildWhere([
      `u.quarter = ${sqlString(q)}`,
      cube("body", "u.body_type"),
      cube("fuel", "u.fuel"),
      cube("keepership", "u.keepership"),
      f.region ? `g.region_code = ${sqlString(f.region)}` : null,
      "u.n IS NOT NULL",
    ])}
    ORDER BY u.n DESC, name
  `);
  const laIdx = f.la ? lasAll.findIndex((r) => r.code === f.la) : -1;

  return {
    q,
    yq,
    dq,
    n: now.n,
    yr: now.yr,
    decade: now.decade,
    bodyMix,
    fuelMix,
    regionsRaw,
    ukRef,
    net,
    series,
    areaN,
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
  const fuel = !exclude.fuel && f.fuel ? fuelAdj(f.fuel) : null;
  const body = !exclude.body && f.body ? bodyNoun(f.body) : null;
  const head =
    fuel && body
      ? `${fuel} ${body}`
      : fuel
        ? `${fuel} vehicles`
        : (body ?? "all licensed vehicles");
  const keep =
    !exclude.keepership && f.keepership ? keepNoun(f.keepership) : null;
  const place =
    !exclude.region && placeLabel ? `in ${placeLabel}` : "across the UK";
  return `${head}${keep ? `, ${keep},` : ""} ${place}`;
}

export default function VehicleFleetDashboard() {
  const { filters: f, set, toggle, reset, isDefault } = useCrossFilter(DIMS);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [las, setLas] = useState<LaOption[]>([]);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regionMode, setRegionMode] = useState<"count" | "share">("count");
  const [lineMode, setLineMode] = useState<"count" | "share">("count");

  // Geography is a hierarchy, so the two levels stay coherent: picking
  // an LA also pins its parent region; changing region — from the
  // Select OR a chart click — drops any LA outside it.
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

  // Load the parquet and the derived region lookup once, then fetch the
  // area domains — the Select renders immediately with just "All" and
  // gains its options without moving.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadTable(T_FLEET, LOAD_FLEET);
      await loadTable(T_GEO, LOAD_GEO);
      const rows = await query<RegionOption>(`
        SELECT ons_code AS code, ons_geography AS name
        FROM ${T_FLEET}
        WHERE quarter = (SELECT max(quarter) FROM ${T_FLEET})
          AND body_type = 'Total' AND fuel = 'Total' AND keepership = 'Total'
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
      return { ...r, n, total, share: total > 0 ? n / total : 0 };
    })
    .sort((a, b) =>
      regionMode === "share"
        ? b.share - a.share || a.name.localeCompare(b.name)
        : b.n - a.n || a.name.localeCompare(b.name),
    );
  const regionRows: RankedBar[] = regionStats.map((r) => ({
    label: r.name,
    value: regionMode === "share" ? r.share : r.n,
    count: r.n,
  }));
  const statByName = new Map(regionStats.map((r) => [r.name, r]));
  const regionRank = f.region
    ? regionStats.findIndex((r) => r.code === f.region)
    : -1;
  const ukShare =
    data?.ukRef && data.ukRef.total > 0
      ? data.ukRef.n / data.ukRef.total
      : null;

  const yoy = data?.n != null && data.yr ? (data.n - data.yr) / data.yr : null;
  const added = data?.n != null && data.yr != null ? data.n - data.yr : null;
  const tenYear =
    data?.n != null && data.decade ? (data.n - data.decade) / data.decade : null;

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
  const areaLabel = f.region ? regionName(f.region) : "the UK";

  // The mix cards' shared subject line: the scope minus their own
  // dimension, capitalised for the start of a sentence.
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

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
      <h2 className="dash-title">Licensed vehicles</h2>
      <p className="dash-sub">
        Every licensed vehicle in the United Kingdom at the end of each
        quarter — a stock of what is on the road, not a flow of new
        registrations — by body type, fuel, keepership and area. DfT table
        VEH0105, built from DVLA data. Click any chart, or use the
        filters, to slice the whole page.
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
          <span className="filter-label">Body type</span>
          <Select
            label="Filter by body type"
            options={[
              { value: "", label: "All body types" },
              ...BODIES.map((x) => ({ value: x.value as string, label: x.value as string })),
            ]}
            value={f.body ?? ""}
            onChange={(v) => set("body", v === "" ? null : v)}
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
          label="Licensed vehicles"
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
          label="Growth over ten years"
          loading={pending}
          value={tenYear !== null ? fmtSignedPct(tenYear) : "—"}
          delta={data ? `in the stock since ${data.dq}` : undefined}
        />
        <StatTile
          label="Latest quarter"
          loading={pending}
          value={data ? data.q : "—"}
          delta="DfT publishes quarterly"
        />
      </StatRow>

      <div className="dash-grid">
        {/* The headline chart leads. Detail card — follows every filter,
            not itself clickable (v1). */}
        <div className="chart-card full">
          <h3>Licensed vehicles over time</h3>
          <p className="chart-sub">
            End-of-quarter stock of {scope()}
            {data && data.series.length > 0
              ? `, ${data.series[0].quarter} → ${data.q}`
              : ""}
            . The share view divides by every licensed vehicle in the same
            area.
          </p>
          <Segmented
            label="Time series measure"
            options={[
              { value: "count", label: "Count" },
              { value: "share", label: "Share of the fleet" },
            ]}
            value={lineMode}
            onChange={setLineMode}
          />
          {data && points.length > 0 ? (
            <LineChart
              points={points}
              height={LINE_HEIGHT}
              formatTick={lineMode === "share" ? fmtPct0 : fmtCompact}
              formatValue={lineMode === "share" ? fmtPct : fmtInt}
              ariaLabel="Licensed vehicles by quarter under the active filters. Use arrow keys to step through values."
            />
          ) : (
            pending && <LoadingPanel height={LINE_HEIGHT} />
          )}
        </div>

        <div className="chart-card">
          <h3>Body types</h3>
          <p className="chart-sub">
            {cap(scope({ body: true }))}
            {data ? `, ${data.q}` : ""}, by body type. Click a bar to
            filter the page to that body type.
          </p>
          {data ? (
            <CategoryBars
              bars={data.bodyMix}
              height={CHART_HEIGHT}
              selected={f.body ? bodyLabel(f.body) : null}
              onSelect={(label) => {
                const raw = BODIES.find((x) => x.label === label)?.value;
                if (raw) toggle("body", raw);
              }}
              formatTick={fmtCompact}
              formatValue={fmtInt}
              tipLabel={(b) =>
                `${b.label} · ${fmtPct(b.share ?? 0)} of vehicles in scope`
              }
              ariaLabel="Licensed vehicles by body type. Use arrow keys to step through the bars; Enter filters the page to that body type."
            />
          ) : (
            pending && <LoadingPanel height={CHART_HEIGHT} />
          )}
        </div>

        <div className="chart-card tall">
          <h3>Regions, ranked</h3>
          <p className="chart-sub">
            {cap(scope({ region: true })).replace(" across the UK", "")}{" "}
            in each region{data ? `, ${data.q}` : ""}
            {regionMode === "share"
              ? ", as a share of the region's whole fleet"
              : ""}
            . Click a row to focus that region.
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
              { value: "count", label: "Count" },
              { value: "share", label: "Share of fleet" },
            ]}
            value={regionMode}
            onChange={setRegionMode}
          />
          {data ? (
            <RankedBars
              rows={regionRows}
              rowHeight={REGION_ROW}
              refValue={
                regionMode === "share" && ukShare !== null ? ukShare : undefined
              }
              refLabel="UK"
              formatTick={regionMode === "share" ? fmtPct0 : fmtCompact}
              formatValue={regionMode === "share" ? fmtPct : fmtCompact}
              tipValue={(row) =>
                regionMode === "share"
                  ? `${fmtPct(row.value)} of the region's fleet`
                  : `${fmtInt(row.value)} vehicles`
              }
              tipLabel={(row) => {
                const s = statByName.get(row.label);
                return regionMode === "share"
                  ? `${row.label} · ${fmtInt(row.count)} vehicles`
                  : `${row.label} · ${s ? fmtPct(s.share) : "—"} of its fleet`;
              }}
              selected={f.region ? regionName(f.region) : null}
              onSelect={(label) => {
                const code = regionDomain.find((r) => r.name === label)?.code;
                if (code) setRegion(f.region === code ? null : code);
              }}
              ariaLabel="Regions ranked by licensed vehicles. Use arrow keys to step through the rows; Enter filters the page to that region."
            />
          ) : (
            pending && <LoadingPanel height={REGIONS_HEIGHT} />
          )}
        </div>

        <div className="chart-card">
          <h3>Fuel</h3>
          <p className="chart-sub">
            {cap(scope({ fuel: true }))}
            {data ? `, ${data.q}` : ""}, by fuel. Battery electrics and
            plug-in hybrids sit inside &ldquo;Other fuels&rdquo;. Click a
            bar to filter the page.
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
                `${b.label} · ${fmtPct(b.share ?? 0)} of vehicles in scope`
              }
              ariaLabel="Licensed vehicles by fuel type. Use arrow keys to step through the bars; Enter filters the page to that fuel."
            />
          ) : (
            pending && <LoadingPanel height={CHART_HEIGHT} />
          )}
        </div>

        {/* Detail: follows every filter, not itself clickable (v1). */}
        <div className="chart-card full">
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
              ariaLabel="Net change in licensed vehicles per quarter. Use arrow keys to step through the bars."
            />
          ) : (
            pending && <LoadingPanel height={CHART_HEIGHT} />
          )}
        </div>

        {/* Detail: an open table — exact values are this card's point. */}
        <div className="chart-card full">
          <h3>Local authorities</h3>
          <p className="chart-sub">
            The ten local authorities keeping the most{" "}
            {scope({ region: true }).replace(" across the UK", "")}
            {f.region ? ` in ${regionName(f.region)}` : ""}
            {data ? `, ${data.q}` : ""}, with each one&rsquo;s share of{" "}
            {areaLabel}&rsquo;s vehicles in scope. Vehicles sit at the
            keeper&rsquo;s postcode — head-office fleets swell areas like
            Wiltshire and Windsor and Maidenhead.
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
                    <th className="num">Vehicles</th>
                    <th className="num">Share of area</th>
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
                        <td className="num">
                          {data.areaN ? fmtPct(row.n / data.areaN) : "—"}
                        </td>
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
            2014 Q3, when Northern Ireland enters the data; regions and
            local authorities run back to 2009 Q4.
          </li>
          <li>
            Vehicles are counted at the registered keeper&rsquo;s postcode,
            not where they are used. Leasing and fleet head offices put
            places like Wiltshire and Windsor and Maidenhead among the
            largest &ldquo;fleets&rdquo; in the country. The keepership
            filter separates private keepers from company ones.
          </li>
          <li>
            Fuel categories are the publisher&rsquo;s for this table:
            battery electric and plug-in hybrid vehicles are counted under
            &ldquo;Other fuels&rdquo;, while &ldquo;Hybrid (petrol)&rdquo;
            is conventional petrol hybrids. For the electric slice of the
            fleet, see the{" "}
            <a href="#/d/ulev-uptake">Electric vehicle uptake</a> dashboard.
          </li>
          <li>
            The publisher&rsquo;s own aggregate rows are read directly —
            never summed from parts — and DfT-suppressed cells are
            excluded. Breakdowns still don&rsquo;t fully reconcile to the
            UK total: vehicles mid-disposal or with unknown addresses
            (~740,000 in 2025 Q4) belong to no region, and keepership has a
            small unpublished remainder.
          </li>
          <li>
            Region membership for local authorities is derived from
            DfT&rsquo;s published presentation order.
          </li>
        </ul>
        <p>
          Data: <a href={hfRepoUrl(FAMILY)}>{FAMILY} on Hugging Face</a>{" "}
          (table VEH0105) · published by the{" "}
          <a href="https://www.gov.uk/government/statistical-data-sets/vehicle-licensing-statistics-data-tables">
            Department for Transport
          </a>{" "}
          under OGL v3.0.
        </p>
      </div>
    </>
  );
}
