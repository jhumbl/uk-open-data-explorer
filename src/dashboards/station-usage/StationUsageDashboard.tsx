import { useEffect, useState } from "react";
import { loadTable, query } from "../../lib/duckdb";
import { hfFileUrl, hfRepoUrl } from "../../lib/catalog";
import {
  buildWhere,
  sqlString,
  useCrossFilter,
  type FilterState,
} from "../../lib/crossfilter";
import { fmtCompact, fmtInt, fmtSignedInt, fmtSignedPct } from "../../lib/format";
import { StatRow, StatTile } from "../../components/charts/StatTile";
import LoadingPanel from "../../components/charts/LoadingPanel";
import Select from "../../components/charts/Select";
import RankedBars, { type RankedBar } from "../../components/charts/RankedBars";
import MultiLineChart from "../../components/charts/MultiLineChart";
import StationMap, { STATION_MAP_HEIGHT, type StationPoint } from "./StationMap";

/**
 * Which stations carry Britain's rail passengers — and how has that
 * changed since 1997?
 *
 * Design spec (2026-11-09, anchored against the live parquet that day):
 *   - ORR Table 1415: estimated entries + exits (and interchanges) per
 *     GB mainline station per financial year, 1997-98 → latest. A FLOW
 *     (passengers through the gates in a year), and an ESTIMATE from
 *     ticket sales, not a count.
 *   - Anchors: GB 2024-25 3,064.6M entries+exits (2023-24 2,853.7M);
 *     London 1,646.9M of it; busiest London Liverpool Street 98.02M
 *     (94.50M the year before). 2,589 stations with figures in 2024-25.
 *   - Dimensions: a place hierarchy, region (11, ITL1) → station
 *     (~2,600). Both filterable from the bar and by clicking their
 *     rankings. Picking a station pins its region; changing region drops
 *     a station outside it (the ULEV area-hierarchy pattern).
 *   - Year-on-year figures compare the latest two years only. That pair
 *     sits after ORR's 2022-23 series break; comparisons across the
 *     break (e.g. against pre-Covid) are deliberately not headlined.
 *   - 2003-04 has no rows at all (no data collected); the time axis
 *     re-inserts it as an explicit gap rather than silently joining
 *     2002-03 to 2004-05.
 *
 * Query budget: one 1 MB parquet loaded into DuckDB memory, then ~7
 * in-memory queries per interaction — zero network per click.
 */

const FAMILY = "orr-station-usage";
const FILE = "orr_1415_station_usage.parquet";
const T = "orr_station_usage";

const LOAD = `
  SELECT financial_year, station_name, tlc, region, entries_exits, interchanges
  FROM read_parquet('${hfFileUrl(FAMILY, FILE)}')
`;

// Station locations (the map card): DfT NaPTAN rail
// stations, joined on ORR's TLC = NaPTAN's CRS. One row per NaPTAN
// record, so dedupe to one active point per CRS (the pipeline's
// documented rule, uk-open-data#1).
const NAPTAN = { family: "dft-naptan", file: "dft_naptan_rail_stations.parquet" };
const T_NAPTAN = "naptan_rail_points";
const LOAD_NAPTAN = `
  SELECT DISTINCT ON (crs) crs, lat, lon
  FROM read_parquet('${hfFileUrl(NAPTAN.family, NAPTAN.file)}')
  WHERE status = 'active' AND crs IS NOT NULL AND lat IS NOT NULL
  ORDER BY crs, atco_code
`;

const DIMS = ["region", "station"] as const;
type Dim = (typeof DIMS)[number];

const N_REGIONS = 11;
const STATION_ROWS = N_REGIONS; // both halves share a pitch, so they meet
const ROW = 30;
const RANK_HEIGHT = N_REGIONS * ROW + 52;
const LINE_HEIGHT = 280;
const TABLE_ROWS = 10;
const TABLE_MIN_HEIGHT = 404;

/** "1997-98" for start year 1997. */
const fyLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, "0")}`;

interface StationOption {
  name: string;
  region: string | null;
}
interface YearPoint {
  fy: string;
  ee: number | null;
}
interface Ranked {
  name: string;
  region: string | null;
  ee: number;
}
interface Mover {
  name: string;
  region: string | null;
  now: number;
  prev: number;
  ic: number | null;
}
interface Data {
  fy: string;
  prevFy: string;
  ee: number | null;
  eePrev: number | null;
  ic: number | null;
  busiest: Ranked | null;
  /** Selected station's rank in Britain by entries+exits; null unless a
      station filter is set. */
  rank: number | null;
  rankOf: number;
  series: YearPoint[];
  regions: { name: string; ee: number }[];
  stations: Ranked[];
  /** Selected station's rank within the stations card's scope. */
  stationRank: number | null;
  stationTotal: number;
  movers: Mover[];
}

async function runQueries(f: FilterState<Dim>): Promise<Data> {
  const [{ fy, minFy }] = await query<{ fy: string; minFy: string }>(
    `SELECT max(financial_year) AS fy, min(financial_year) AS minFy FROM ${T}`,
  );
  const prevFy = fyLabel(Number(fy.slice(0, 4)) - 1);

  // The finest active level of the place hierarchy scopes tiles and the
  // detail cards; facets drop their own level (crossfilter convention).
  const scope = f.station
    ? `station_name = ${sqlString(f.station)}`
    : f.region
      ? `region = ${sqlString(f.region)}`
      : null;
  const regionScope = f.region ? `region = ${sqlString(f.region)}` : null;

  const [tiles] = await query<{ ee: number | null; eePrev: number | null; ic: number | null }>(`
    SELECT sum(entries_exits) FILTER (WHERE financial_year = ${sqlString(fy)}) AS ee,
           sum(entries_exits) FILTER (WHERE financial_year = ${sqlString(prevFy)}) AS eePrev,
           sum(interchanges) FILTER (WHERE financial_year = ${sqlString(fy)}) AS ic
    FROM ${T} ${buildWhere([scope])}
  `);

  const busiestRows = await query<Ranked>(`
    SELECT station_name AS name, region, entries_exits AS ee
    FROM ${T}
    ${buildWhere([`financial_year = ${sqlString(fy)}`, "entries_exits IS NOT NULL", regionScope])}
    ORDER BY entries_exits DESC, station_name LIMIT 1
  `);

  let rank: number | null = null;
  const [{ n: rankOf }] = await query<{ n: number }>(`
    SELECT count(*) AS n FROM ${T}
    WHERE financial_year = ${sqlString(fy)} AND entries_exits IS NOT NULL
  `);
  if (f.station) {
    const [r] = await query<{ rank: number | null }>(`
      SELECT CASE WHEN s.entries_exits IS NULL THEN NULL ELSE
        (SELECT count(*) FROM ${T} o WHERE o.financial_year = ${sqlString(fy)}
           AND o.entries_exits > s.entries_exits) + 1 END AS rank
      FROM ${T} s
      WHERE s.financial_year = ${sqlString(fy)} AND s.station_name = ${sqlString(f.station)}
    `);
    rank = r?.rank ?? null;
  }

  // The full time series under every filter. NULL (not 0) where no
  // station in scope has a figure, so the line breaks.
  const seriesRaw = await query<{ fy: string; ee: number | null }>(`
    SELECT financial_year AS fy, sum(entries_exits) AS ee
    FROM ${T} ${buildWhere([scope])}
    GROUP BY 1
  `);
  const byFy = new Map(seriesRaw.map((r) => [r.fy, r.ee]));
  const series: YearPoint[] = [];
  for (let y = Number(minFy.slice(0, 4)); y <= Number(fy.slice(0, 4)); y++) {
    const label = fyLabel(y);
    series.push({ fy: label, ee: byFy.get(label) ?? null });
  }

  // Regions — excludes the whole place hierarchy (its own dimension).
  const regions = await query<{ name: string; ee: number }>(`
    SELECT region AS name, coalesce(sum(entries_exits), 0) AS ee
    FROM ${T}
    WHERE financial_year = ${sqlString(fy)} AND region IS NOT NULL
    GROUP BY 1
  `);

  // Stations — the region filter scopes it; the station filter does not
  // (a station's peers are the point) but is answered by highlight +
  // rank. Fetch the whole scope so that rank is exact.
  const stationsAll = await query<Ranked>(`
    SELECT station_name AS name, region, entries_exits AS ee
    FROM ${T}
    ${buildWhere([`financial_year = ${sqlString(fy)}`, "entries_exits IS NOT NULL", regionScope])}
    ORDER BY entries_exits DESC, station_name
  `);
  const sIdx = f.station ? stationsAll.findIndex((s) => s.name === f.station) : -1;

  // Movers — the biggest absolute changes on the year within the region
  // scope; both years sit after the 2022-23 break.
  const movers = await query<Mover>(`
    SELECT a.station_name AS name, a.region, a.entries_exits AS now,
           b.entries_exits AS prev, a.interchanges AS ic
    FROM ${T} a
    JOIN ${T} b ON b.station_name = a.station_name AND b.financial_year = ${sqlString(prevFy)}
    ${buildWhere([
      `a.financial_year = ${sqlString(fy)}`,
      "a.entries_exits IS NOT NULL",
      "b.entries_exits IS NOT NULL",
      regionScope ? `a.${regionScope}` : null,
    ])}
    ORDER BY abs(a.entries_exits - b.entries_exits) DESC, a.station_name
    LIMIT ${TABLE_ROWS}
  `);

  return {
    fy,
    prevFy,
    ee: tiles.ee,
    eePrev: tiles.eePrev,
    ic: tiles.ic,
    busiest: busiestRows[0] ?? null,
    rank,
    rankOf,
    series,
    regions,
    stations: stationsAll.slice(0, STATION_ROWS),
    stationRank: sIdx >= 0 ? sIdx + 1 : null,
    stationTotal: stationsAll.length,
    movers,
  };
}

export default function StationUsageDashboard() {
  const { filters: f, set, reset, isDefault } = useCrossFilter(DIMS);
  const [regionNames, setRegionNames] = useState<string[]>([]);
  const [stationOpts, setStationOpts] = useState<StationOption[]>([]);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapPoints, setMapPoints] = useState<StationPoint[] | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  // The hierarchy stays coherent: a station pins its region; changing
  // region (bar or click) drops a station outside it.
  const stationByName = new Map(stationOpts.map((s) => [s.name, s]));
  const setStation = (name: string | null) => {
    set("station", name);
    if (name) {
      const parent = stationByName.get(name)?.region ?? null;
      if (parent) set("region", parent);
    }
  };
  const setRegion = (name: string | null) => {
    set("region", name);
    if (f.station && stationByName.get(f.station)?.region !== name) set("station", null);
  };

  // Domains once: regions (fixed 11 rows) and every station with a
  // figure in the latest year (the Select's options).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadTable(T, LOAD);
      const regs = await query<{ name: string }>(`
        SELECT DISTINCT region AS name FROM ${T} WHERE region IS NOT NULL ORDER BY 1
      `);
      const sts = await query<StationOption>(`
        SELECT station_name AS name, region FROM ${T}
        WHERE financial_year = (SELECT max(financial_year) FROM ${T})
          AND entries_exits IS NOT NULL
        ORDER BY station_name
      `);
      if (cancelled) return;
      setRegionNames(regs.map((r) => r.name));
      setStationOpts(sts);
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  // Map points once: every station with a latest-year figure and a
  // NaPTAN location, largest first (the draw order). A NaPTAN failure
  // degrades only the map card, never the rest of the page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadTable(T, LOAD);
      await loadTable(T_NAPTAN, LOAD_NAPTAN);
      const pts = await query<StationPoint>(`
        SELECT o.station_name AS name, o.region, p.crs, p.lon, p.lat,
               o.entries_exits AS ee
        FROM ${T} o JOIN ${T_NAPTAN} p ON p.crs = o.tlc
        WHERE o.financial_year = (SELECT max(financial_year) FROM ${T})
          AND o.entries_exits > 0
        ORDER BY o.entries_exits DESC
      `);
      if (!cancelled) setMapPoints(pts);
    })().catch((e: Error) => !cancelled && setMapError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadTable(T, LOAD);
      const d = await runQueries(f);
      if (!cancelled) setData(d);
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [f]);

  const pending = data === null && error === null;
  const placeLabel = f.station ?? f.region ?? null;
  const scopeIn = placeLabel ? `at ${f.station ? "" : "stations in "}${placeLabel}` : "across Great Britain";

  const yoy =
    data?.ee != null && data.eePrev ? (data.ee - data.eePrev) / data.eePrev : null;

  // Fixed-geometry region rows: every region always present.
  const regionEe = new Map((data?.regions ?? []).map((r) => [r.name, r.ee]));
  const regionRows: RankedBar[] = (regionNames.length > 0 ? regionNames : [...regionEe.keys()])
    .map((name) => ({ label: name, value: regionEe.get(name) ?? 0, count: regionEe.get(name) ?? 0 }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const gbTotal = regionRows.reduce((s, r) => s + r.value, 0);
  const regionRank = f.region ? regionRows.findIndex((r) => r.label === f.region) + 1 : 0;

  const stationRows: RankedBar[] = (data?.stations ?? []).map((s) => ({
    label: s.name,
    value: s.ee,
    count: s.ee,
  }));
  const stationRegion = new Map((data?.stations ?? []).map((s) => [s.name, s.region]));

  const tableRows: (Mover | null)[] = Array.from(
    { length: TABLE_ROWS },
    (_, i) => data?.movers[i] ?? null,
  );

  const stationChoices = f.region
    ? stationOpts.filter((s) => s.region === f.region)
    : stationOpts;

  return (
    <>
      <h2 className="dash-title">Rail station usage</h2>
      <p className="dash-sub">
        Estimated passenger entries and exits at every mainline station in
        Great Britain, each financial year since 1997-98 — a flow of
        passengers through the station, estimated from ticket sales by the
        Office of Rail and Road. Click a region or station, or use the
        filters, to focus the page.
      </p>

      <div className="filter-bar">
        <span className="filter-group">
          <span className="filter-label">Region</span>
          <Select
            label="Filter by region"
            options={[
              { value: "", label: "All of Great Britain" },
              ...regionNames.map((r) => ({ value: r, label: r })),
            ]}
            value={f.region ?? ""}
            onChange={(v) => setRegion(v === "" ? null : v)}
          />
        </span>
        <span className="filter-group">
          <span className="filter-label">Station</span>
          <Select
            label="Filter by station"
            options={[
              { value: "", label: "All stations" },
              ...stationChoices.map((s) => ({ value: s.name, label: s.name })),
            ]}
            value={f.station ?? ""}
            onChange={(v) => setStation(v === "" ? null : v)}
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
          label="Entries and exits"
          loading={pending}
          value={data?.ee != null ? fmtCompact(data.ee) : "—"}
          delta={
            yoy !== null && data ? (
              <>
                {data.fy} ·{" "}
                <span className={yoy >= 0 ? "dir-up" : "dir-down"}>{fmtSignedPct(yoy)}</span>{" "}
                on {data.prevFy}
              </>
            ) : data ? (
              `${data.fy} · no figure for the year before`
            ) : undefined
          }
        />
        {f.station ? (
          <StatTile
            label="Rank in Great Britain"
            loading={pending}
            value={data?.rank != null ? fmtInt(data.rank) : "—"}
            delta={data ? `of ${fmtInt(data.rankOf)} stations with figures in ${data.fy}` : undefined}
          />
        ) : (
          <StatTile
            label={`Busiest station${f.region ? `, ${f.region}` : ""}`}
            loading={pending}
            value={data?.busiest ? fmtCompact(data.busiest.ee) : "—"}
            delta={data?.busiest ? data.busiest.name : undefined}
          />
        )}
        <StatTile
          label="Interchanges"
          loading={pending}
          value={data?.ic != null ? fmtCompact(data.ic) : "—"}
          delta={
            data
              ? data.ic != null
                ? `${data.fy} · passengers changing trains here`
                : `${data.fy} · ORR publishes no estimate here`
              : undefined
          }
        />
        <StatTile
          label="Latest year"
          loading={pending}
          value={data ? data.fy : "—"}
          delta="ORR publishes each year, in November or December"
        />
      </StatRow>

      <div className="dash-grid">
        {/* Detail: follows every filter, not itself clickable (v1). */}
        <div className="chart-card full">
          <h3>Entries and exits over time</h3>
          <p className="chart-sub">
            Estimated entries plus exits each financial year {scopeIn}
            {data ? `, 1997-98 → ${data.fy}` : ""}. No data was collected in
            2003-04; 2022-23 is a break in ORR&rsquo;s series.
          </p>
          {data ? (
            <MultiLineChart
              labels={data.series.map((p) => p.fy)}
              series={[
                {
                  name: "Entries and exits",
                  color: "var(--series-1)",
                  values: data.series.map((p) => p.ee),
                },
              ]}
              height={LINE_HEIGHT}
              formatTick={fmtCompact}
              formatValue={fmtInt}
              xTicks={data.series
                .map((p, i) => ({ p, i }))
                .filter(({ p }) => Number(p.fy.slice(0, 4)) % 4 === 1)
                .map(({ i }) => i)}
              tipHeader={(fy) =>
                fy === "2003-04"
                  ? "2003-04 · no data collected"
                  : fy === "2022-23"
                    ? "2022-23 · series break"
                    : fy
              }
              band={{ from: "2020-21", to: "2021-22", label: "Covid years" }}
              ariaLabel="Estimated entries and exits per financial year under the active filters. Use arrow keys to step through the years."
            />
          ) : (
            pending && <LoadingPanel height={LINE_HEIGHT} />
          )}
        </div>

        {/* Map card (accepted 2026-11-10; charts skill · Maps).
            Circles are station-dimension members, so they click-filter
            (approved map rule); keyboard path = Station control + the
            rankings. */}
        <div className="chart-card full">
          <h3>On the map</h3>
          <p className="chart-sub">
            Every station with a figure in {data ? data.fy : "the latest year"},
            its circle&rsquo;s area proportional to entries and exits. Hover
            a circle for its figure; click one to focus the page on that
            station.
          </p>
          <div className="map-bleed">
            {mapPoints ? (
              <StationMap
                points={mapPoints}
                region={f.region}
                station={f.station}
                onSelectStation={(name) => {
                  if (f.station === name) set("station", null);
                  else setStation(name);
                }}
              />
            ) : mapError ? (
              <div className="notice" role="alert" style={{ margin: 20 }}>
                <strong>Station locations failed to load.</strong> {mapError}
              </div>
            ) : (
              <LoadingPanel height={STATION_MAP_HEIGHT} />
            )}
          </div>
        </div>

        <div className="chart-card">
          <h3>Regions, ranked</h3>
          <p className="chart-sub">
            Entries and exits in each region{data ? `, ${data.fy}` : ""}.
            Click a row to focus that region.
            {f.region && regionRank > 0 ? (
              <>
                {" "}
                <strong>{f.region}</strong> ranks {regionRank} of {regionRows.length},
                with {gbTotal > 0 ? `${Math.round(((regionEe.get(f.region) ?? 0) / gbTotal) * 100)}%` : "—"} of Britain&rsquo;s total.
              </>
            ) : null}
          </p>
          {data ? (
            <RankedBars
              rows={regionRows}
              rowHeight={ROW}
              labelWidth={150}
              formatTick={fmtCompact}
              formatValue={fmtCompact}
              tipValue={(row) => `${fmtInt(row.value)} entries and exits`}
              tipLabel={(row) =>
                `${row.label} · ${gbTotal > 0 ? Math.round((row.value / gbTotal) * 100) : 0}% of Great Britain`
              }
              selected={f.region}
              onSelect={(label) => setRegion(f.region === label ? null : label)}
              ariaLabel="Regions ranked by entries and exits. Use arrow keys to step through the rows; Enter filters the page to that region."
            />
          ) : (
            pending && <LoadingPanel height={RANK_HEIGHT} />
          )}
        </div>

        <div className="chart-card">
          <h3>Busiest stations</h3>
          <p className="chart-sub">
            The {STATION_ROWS} stations with the most entries and exits
            {f.region ? ` in ${f.region}` : " in Great Britain"}
            {data ? `, ${data.fy}` : ""}. Click a row to focus that station.
            {f.station && data?.stationRank ? (
              <>
                {" "}
                <strong>{f.station}</strong> ranks {fmtInt(data.stationRank)} of{" "}
                {fmtInt(data.stationTotal)}.
              </>
            ) : null}
          </p>
          {data ? (
            <RankedBars
              rows={stationRows}
              rowHeight={ROW}
              formatTick={fmtCompact}
              formatValue={fmtCompact}
              tipValue={(row) => `${fmtInt(row.value)} entries and exits`}
              tipLabel={(row) => `${row.label} · ${stationRegion.get(row.label) ?? "—"}`}
              selected={f.station}
              onSelect={(label) => {
                if (f.station === label) set("station", null);
                else setStation(label);
              }}
              ariaLabel="The busiest stations ranked by entries and exits. Use arrow keys to step through the rows; Enter filters the page to that station."
            />
          ) : (
            pending && <LoadingPanel height={RANK_HEIGHT} />
          )}
        </div>

        {/* Detail: an open table — exact values are this card's point. */}
        <div className="chart-card full">
          <h3>Biggest changes on the year</h3>
          <p className="chart-sub">
            The {TABLE_ROWS} stations whose entries and exits changed most
            {data ? ` between ${data.prevFy} and ${data.fy}` : ""}
            {f.region ? ` in ${f.region}` : " in Great Britain"}, up or down.
            Both years follow ORR&rsquo;s 2022-23 series break.
          </p>
          {data ? (
            <div className="table-wrap" style={{ minHeight: TABLE_MIN_HEIGHT }}>
              <table>
                <thead>
                  <tr>
                    <th>Station</th>
                    <th>Region</th>
                    <th className="num">{data.prevFy}</th>
                    <th className="num">{data.fy}</th>
                    <th className="num">Change</th>
                    <th className="num">Interchanges</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row, i) =>
                    row ? (
                      <tr key={row.name}>
                        <td>{row.name === f.station ? <strong>{row.name}</strong> : row.name}</td>
                        <td>{row.region ?? "—"}</td>
                        <td className="num">{fmtInt(row.prev)}</td>
                        <td className="num">{fmtInt(row.now)}</td>
                        <td className="num">
                          {fmtSignedInt(row.now - row.prev)} ({fmtSignedPct((row.now - row.prev) / row.prev)})
                        </td>
                        <td className="num">{row.ic != null ? fmtInt(row.ic) : "—"}</td>
                      </tr>
                    ) : (
                      <tr key={`empty-${i}`}>
                        <td>—</td>
                        <td />
                        <td className="num" />
                        <td className="num" />
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
            These are <strong>estimates, not counts</strong>. ORR derives them
            mainly from ticket sales, allocating Travelcards, London zonal
            fares and similar tickets to stations by model — so figures can be
            fractional, and close comparisons between stations deserve care.
          </li>
          <li>
            <strong>Entries plus exits</strong> counts a passenger at each end:
            one journey between two stations adds two. Summed across stations
            it is roughly twice the number of journeys, not the number of
            passengers. Interchanges (changing trains) are counted separately.
          </li>
          <li>
            <strong>Break in series at 2022-23.</strong> From 2023-24 ORR adjusts
            for split tickets and allocates &ldquo;London Terminals&rdquo; tickets
            differently, which particularly moves the London termini. Compare
            across 2022-23 and 2023-24 with care; the year-on-year figures here
            only compare years after the break.
          </li>
          <li>
            No entries and exits were collected for any station in 2003-04 —
            the gap in the line. Interchange estimates are missing for some
            years and stations (none in 1997-98, 1998-99 or 2002-03; none for
            Liverpool Street or Paddington in 2023-24).
          </li>
          <li>
            The <strong>Elizabeth line</strong> is included at the stations it
            shares from 2022-23 (Paddington nearly trebled between 2021-22 and
            2022-23); Bond Street appears from 2022-23. 2020-21 and 2021-22
            (shaded) reflect Covid restrictions — not a baseline.
          </li>
          <li>
            <strong>TfL&rsquo;s gate counts are a check.</strong> At stations
            where TfL runs the gates and only Overground or Elizabeth line
            trains call, TfL&rsquo;s gate taps for 2024-25 count the same
            passengers by a different method, and usually land close to these
            estimates: within 10% at 73 of 110 such stations, and typically a
            little lower (West Ealing 2.55 million both; Hackney Central 5.49
            million taps against 5.32 million). Elsewhere the two measure
            different gates — the Underground&rsquo;s at interchanges, only the
            Elizabeth line&rsquo;s at Reading — so the gap between them means
            nothing. The{" "}
            <a href={hfRepoUrl("tfl-network-demand")}>TfL station crosswalk&rsquo;s documentation</a>{" "}
            sets out the same relationship.
          </li>
          <li>
            Station names, regions and local authorities are ORR&rsquo;s current
            edition applied to every year. The 71 closed stations have no
            region: they count in Britain&rsquo;s totals but not in any region,
            and only stations with a figure in the latest year can be picked.
          </li>
          <li>
            Station locations are DfT&rsquo;s NaPTAN records, matched on the
            three-letter station code. The map shows the stations with a
            figure in the latest year; closed stations, which have no code,
            are not mapped.
          </li>
        </ul>
        <p>
          Data: <a href={hfRepoUrl(FAMILY)}>{FAMILY} on Hugging Face</a> (ORR
          Table 1415) · published by the{" "}
          <a href="https://dataportal.orr.gov.uk/statistics/usage/estimates-of-station-usage">
            Office of Rail and Road
          </a>{" "}
          under OGL v3.0. Station locations:{" "}
          <a href={hfRepoUrl(NAPTAN.family)}>{NAPTAN.family} on Hugging Face</a>{" "}
          · DfT{" "}
          <a href="https://www.gov.uk/government/publications/national-public-transport-access-node-schema">
            NaPTAN
          </a>{" "}
          under OGL v3.0.
        </p>
      </div>
    </>
  );
}
