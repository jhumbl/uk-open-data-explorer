import { useEffect, useMemo, useState } from "react";
import { loadTable, query } from "../../lib/duckdb";
import { hfFileUrl, hfRepoUrl } from "../../lib/catalog";
import { sqlString, useCrossFilter } from "../../lib/crossfilter";
import { fmtCompact, fmtDate, fmtInt, fmtPct, fmtPct0 } from "../../lib/format";
import { StatRow, StatTile } from "../../components/charts/StatTile";
import LoadingPanel from "../../components/charts/LoadingPanel";
import Select from "../../components/charts/Select";
import RankedBars, { type RankedBar } from "../../components/charts/RankedBars";
import CategoryBars, { type CategoryBar } from "../../components/charts/CategoryBars";
import MultiLineChart from "../../components/charts/MultiLineChart";

/**
 * Which London stations are back to 2019 levels — and which aren't?
 *
 * Design spec (2026-11-10, anchored against the live parquets that day):
 *   - TfL station footfall: entry + exit taps at TfL gatelines per
 *     station label per day, 1 Jan 2019 → latest (31 Oct 2026 today).
 *     A FLOW, and a COUNT of taps — not journeys, not passengers.
 *   - Recovery = average taps a day in the latest 365 days ÷ average a
 *     day in calendar 2019, both over days with a published count.
 *   - COMPARABLE labels only: a count on ≥ 300 days of 2019 AND ≥ 180 of
 *     the latest year (419 of 438 labels). This is the load-bearing
 *     rule: TfL adds labels mid-series ('Paddington EL' from Feb 2021,
 *     the Reading branch from Oct 2020, Battersea from 2021), and summing
 *     a station group across them would inflate the Elizabeth line
 *     stations against a 2019 that had no such gates.
 *   - Anchors (comparable labels): all stations 87.2% of 2019 (8.72M →
 *     7.60M taps a day); weekdays 83.6%, weekends 101.9%; 110 of 419
 *     labels at or above 2019; Tottenham Court Road 162%, Woolwich
 *     Arsenal DLR 38%.
 *   - Dimensions: line (TfL's 19 rail lines, from the pipeline's
 *     StopPoint crosswalk — current lines, not historical) and station
 *     (a footfall label). Line is a filter AND a clickable ranking;
 *     stations click from the rises/falls rankings. A station can sit on
 *     several lines, so picking one does not pin a line; changing line
 *     drops a station not on it.
 *
 * Query budget: the 6 MB footfall parquet (2 row groups — unprunable,
 * load whole) and the 438-row crosswalk, once; every derived table is
 * built in memory at load; one in-memory query per interaction (the
 * monthly series). Rankings, tiles and the table are computed in JS from
 * the 419-row per-station table.
 */

const FAMILY = "tfl-network-demand";
const FOOTFALL = "tfl_station_footfall.parquet";
const XWALK = "tfl_stoppoint_footfall_crosswalk.parquet";

const T_FF = "tfl_footfall_days";
const T_X = "tfl_footfall_xwalk";
const T_LAB = "tfl_footfall_comparable";
const T_LINE = "tfl_footfall_station_lines";
const T_MONTH = "tfl_footfall_months";

const BASE_YEAR = 2019;
const MIN_BASE_DAYS = 300;
const MIN_LATEST_DAYS = 180;

const LOAD_FF = `
  SELECT CAST(travel_date AS DATE) AS d, station,
         day_of_week IN ('Saturday', 'Sunday') AS we,
         entry_tap_count + exit_tap_count AS taps
  FROM read_parquet('${hfFileUrl(FAMILY, FOOTFALL)}')
  WHERE station <> 'Unknown'
`;
const LOAD_X = `
  SELECT station, lines, match
  FROM read_parquet('${hfFileUrl(FAMILY, XWALK)}')
`;
// Per-label averages over days with a count, kept only where the label
// is comparable (see the spec above).
const LOAD_LAB = `
  WITH w AS (SELECT max(d) - INTERVAL 365 DAY AS since FROM ${T_FF})
  SELECT station,
    avg(taps) FILTER (WHERE year(d) = ${BASE_YEAR}) AS a19,
    avg(taps) FILTER (WHERE d > since) AS al,
    avg(taps) FILTER (WHERE year(d) = ${BASE_YEAR} AND NOT we) AS a19wd,
    avg(taps) FILTER (WHERE d > since AND NOT we) AS alwd,
    avg(taps) FILTER (WHERE year(d) = ${BASE_YEAR} AND we) AS a19we,
    avg(taps) FILTER (WHERE d > since AND we) AS alwe
  FROM ${T_FF}, w
  GROUP BY station
  HAVING count(*) FILTER (WHERE year(d) = ${BASE_YEAR}) >= ${MIN_BASE_DAYS}
     AND count(*) FILTER (WHERE d > since) >= ${MIN_LATEST_DAYS}
`;

/** TfL's rail lines, in the crosswalk's ids, with display names. The
    crosswalk's `lines` also carries bus routes and National Rail
    operators; only these are offered. Curated, so a line TfL adds or
    renames is missing here until it is added. */
const LINES: readonly { id: string; name: string }[] = [
  { id: "bakerloo", name: "Bakerloo" },
  { id: "central", name: "Central" },
  { id: "circle", name: "Circle" },
  { id: "district", name: "District" },
  { id: "hammersmith-city", name: "Hammersmith & City" },
  { id: "jubilee", name: "Jubilee" },
  { id: "metropolitan", name: "Metropolitan" },
  { id: "northern", name: "Northern" },
  { id: "piccadilly", name: "Piccadilly" },
  { id: "victoria", name: "Victoria" },
  { id: "waterloo-city", name: "Waterloo & City" },
  { id: "dlr", name: "DLR" },
  { id: "elizabeth", name: "Elizabeth line" },
  { id: "liberty", name: "Liberty" },
  { id: "lioness", name: "Lioness" },
  { id: "mildmay", name: "Mildmay" },
  { id: "suffragette", name: "Suffragette" },
  { id: "weaver", name: "Weaver" },
  { id: "windrush", name: "Windrush" },
];
const LINE_NAME = new Map(LINES.map((l) => [l.id, l.name]));
const LINE_ID = new Map(LINES.map((l) => [l.name, l.id]));

const LOAD_LINE = `
  SELECT x.station, u.line
  FROM ${T_X} x, unnest(x.lines) AS u(line)
  WHERE u.line IN (${LINES.map((l) => sqlString(l.id)).join(", ")})
`;
const LOAD_MONTH = `
  SELECT station, date_trunc('month', d) AS m, we, avg(taps) AS a
  FROM ${T_FF}
  WHERE station IN (SELECT station FROM ${T_LAB})
  GROUP BY ALL
`;

/** Histogram bins on the share of 2019: under 60%, 10-point steps, 150%+. */
const BIN_EDGES = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5];
const binOf = (r: number) => {
  let i = 0;
  while (i < BIN_EDGES.length && r >= BIN_EDGES[i]) i++;
  return i;
};
const binLabel = (i: number) =>
  i === 0 ? "<60%" : i === BIN_EDGES.length ? "150%+" : fmtPct0(BIN_EDGES[i - 1]);
const binRange = (i: number) =>
  i === 0
    ? "under 60% of 2019"
    : i === BIN_EDGES.length
      ? "150% of 2019 or more"
      : `${fmtPct0(BIN_EDGES[i - 1])}–${fmtPct0(BIN_EDGES[i])} of 2019`;

const DIMS = ["line", "station"] as const;

const LINE_ROW = 19;
const LINE_RANK_HEIGHT = LINES.length * LINE_ROW + 52;
const MOVER_ROWS = 10;
const MOVER_ROW = 22;
const MOVER_HEIGHT = MOVER_ROWS * MOVER_ROW + 52;
const SERIES_HEIGHT = 300;
const TABLE_ROWS = 10;
const TABLE_MIN_HEIGHT = 404;

interface Lab {
  station: string;
  a19: number;
  al: number;
  a19wd: number;
  alwd: number;
  a19we: number;
  alwe: number;
}
interface Base {
  labs: Lab[];
  /** Station label → TfL line ids serving it today. */
  linesOf: Map<string, string[]>;
  dataFrom: string;
  dataTo: string;
  windowFrom: string;
  totalLabels: number;
  unmatched: number;
}
interface MonthRow {
  m: string;
  we: boolean;
  r: number | null;
}

const ratio = (num: number, den: number) => (den > 0 ? num / den : null);
const monthLabel = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

async function loadBase(): Promise<Base> {
  await loadTable(T_FF, LOAD_FF);
  await loadTable(T_X, LOAD_X);
  await loadTable(T_LAB, LOAD_LAB);
  await loadTable(T_LINE, LOAD_LINE);
  await loadTable(T_MONTH, LOAD_MONTH);
  const labs = await query<Lab>(`SELECT * FROM ${T_LAB} ORDER BY station`);
  const lineRows = await query<{ station: string; line: string }>(
    `SELECT station, line FROM ${T_LINE}`,
  );
  const linesOf = new Map<string, string[]>();
  for (const r of lineRows) {
    const ls = linesOf.get(r.station) ?? [];
    ls.push(r.line);
    linesOf.set(r.station, ls);
  }
  const order = new Map(LINES.map((l, i) => [l.id, i]));
  for (const ls of linesOf.values()) ls.sort((a, b) => order.get(a)! - order.get(b)!);
  const [meta] = await query<{
    dataFrom: string;
    dataTo: string;
    windowFrom: string;
    totalLabels: number;
  }>(`
    SELECT strftime(min(d), '%Y-%m-%d') AS dataFrom,
           strftime(max(d), '%Y-%m-%d') AS dataTo,
           strftime(max(d) - INTERVAL 364 DAY, '%Y-%m-%d') AS windowFrom,
           count(DISTINCT station) AS totalLabels
    FROM ${T_FF}
  `);
  // The crosswalk is compiled upstream; an unmatched label only loses its
  // lines (it still counts under "All lines"), so count it for the caveat.
  const [{ unmatched }] = await query<{ unmatched: number }>(
    `SELECT count(*) AS unmatched FROM ${T_X} WHERE match = 'unmatched'`,
  );
  if (unmatched > 0)
    console.warn(`[station-recovery] ${unmatched} footfall label(s) unmatched in the crosswalk`);
  return { labs, linesOf, ...meta, unmatched };
}

async function loadSeries(stations: string[] | null): Promise<MonthRow[]> {
  const scope =
    stations === null
      ? ""
      : `WHERE station IN (${stations.length ? stations.map(sqlString).join(", ") : "NULL"})`;
  return query<MonthRow>(`
    WITH s AS (SELECT * FROM ${T_MONTH} ${scope})
    SELECT strftime(s.m, '%Y-%m') AS m, s.we, sum(s.a) / sum(b.a) AS r
    FROM s JOIN s AS b
      ON b.station = s.station AND b.we = s.we
     AND year(b.m) = ${BASE_YEAR} AND month(b.m) = month(s.m)
    GROUP BY 1, 2
    ORDER BY 1
  `);
}

export default function StationRecoveryDashboard() {
  const { filters: f, set, reset, isDefault } = useCrossFilter(DIMS);
  const [base, setBase] = useState<Base | null>(null);
  const [series, setSeries] = useState<MonthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadBase()
      .then((b) => !cancelled && setBase(b))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const lineId = f.line ? (LINE_ID.get(f.line) ?? null) : null;
  const onLine = (s: string, id: string) => base?.linesOf.get(s)?.includes(id) ?? false;

  // Line scope (the rises/falls, the spread, the table and the station
  // picker) and the finest scope (tiles and the monthly series).
  const lineLabs = useMemo(
    () => (base ? (lineId ? base.labs.filter((l) => onLine(l.station, lineId)) : base.labs) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, lineId],
  );
  const scopeLabs = f.station ? lineLabs.filter((l) => l.station === f.station) : lineLabs;
  const scopeKey = f.station ?? f.line ?? "";

  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    const stations = f.station ? [f.station] : lineId ? lineLabs.map((l) => l.station) : null;
    loadSeries(stations)
      .then((s) => !cancelled && setSeries(s))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, scopeKey]);

  const setLine = (name: string | null) => {
    set("line", name);
    const id = name ? LINE_ID.get(name) : null;
    if (f.station && id && !onLine(f.station, id)) set("station", null);
  };
  const toggleStation = (name: string) => set("station", f.station === name ? null : name);

  const pending = base === null && error === null;
  const sum = (ls: Lab[], k: keyof Omit<Lab, "station">) => ls.reduce((s, l) => s + l[k], 0);

  const tot19 = sum(scopeLabs, "a19");
  const totL = sum(scopeLabs, "al");
  const rAll = ratio(totL, tot19);
  const rWd = ratio(sum(scopeLabs, "alwd"), sum(scopeLabs, "a19wd"));
  const rWe = ratio(sum(scopeLabs, "alwe"), sum(scopeLabs, "a19we"));

  const ranked = [...lineLabs]
    .map((l) => ({ ...l, r: l.al / l.a19 }))
    .sort((a, b) => b.r - a.r || a.station.localeCompare(b.station));
  const above = ranked.filter((l) => l.r >= 1).length;
  const stationRank = f.station ? ranked.findIndex((l) => l.station === f.station) + 1 : 0;
  const stationR = f.station ? (ranked.find((l) => l.station === f.station)?.r ?? null) : null;

  // Rises and falls never share a station: a short line splits in half.
  const nRise = Math.min(MOVER_ROWS, Math.ceil(ranked.length / 2));
  const nFall = Math.min(MOVER_ROWS, Math.floor(ranked.length / 2));
  const toBar = (l: (typeof ranked)[number]): RankedBar => ({ label: l.station, value: l.r, count: l.al });
  const riseRows = ranked.slice(0, nRise).map(toBar);
  const fallRows = ranked.slice(ranked.length - nFall).reverse().map(toBar);
  const base19 = new Map(ranked.map((l) => [l.station, l.a19]));
  const lineList = (s: string) =>
    (base?.linesOf.get(s) ?? []).map((id) => LINE_NAME.get(id)).join(", ") || "—";

  // Lines facet: every line always present; drops both filters (the line
  // is its own dimension, and a station's peers are the point).
  const lineRows: RankedBar[] = LINES.map((ln) => {
    const ls = base ? base.labs.filter((l) => onLine(l.station, ln.id)) : [];
    const a19 = sum(ls, "a19");
    return { label: ln.name, value: a19 > 0 ? sum(ls, "al") / a19 : 0, count: ls.length };
  }).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const lineRank = f.line ? lineRows.findIndex((r) => r.label === f.line) + 1 : 0;

  const binCounts = Array.from({ length: BIN_EDGES.length + 1 }, () => 0);
  for (const l of ranked) binCounts[binOf(l.r)]++;
  const bins: CategoryBar[] = binCounts.map((n, i) => ({
    label: binLabel(i),
    value: n,
    share: ranked.length ? n / ranked.length : 0,
  }));
  const selectedBin = stationR !== null ? binLabel(binOf(stationR)) : null;

  const busiest: (Lab | null)[] = Array.from(
    { length: TABLE_ROWS },
    (_, i) => [...lineLabs].sort((a, b) => b.a19 - a.a19)[i] ?? null,
  );

  const months = useMemo(() => {
    if (!series) return null;
    const labels = [...new Set(series.map((r) => r.m))];
    const at = (we: boolean) => {
      const by = new Map(series.filter((r) => r.we === we).map((r) => [r.m, r.r]));
      return labels.map((m) => by.get(m) ?? null);
    };
    return { labels, wd: at(false), we: at(true) };
  }, [series]);

  const onTheLine = f.line
    ? ` on the ${f.line}${f.line.endsWith("line") || f.line === "DLR" ? "" : " line"}`
    : "";
  const nStations = (n: number) => (n === 1 ? "station" : `${fmtInt(n)} comparable stations`);
  const scopeIn = f.station
    ? `at ${f.station}`
    : f.line
      ? `at stations${onTheLine}`
      : "across every comparable station";
  const windowPhrase = base
    ? `${fmtDate(base.windowFrom)} – ${fmtDate(base.dataTo)}`
    : "the latest 12 months";

  return (
    <>
      <h2 className="dash-title">London station recovery</h2>
      <p className="dash-sub">
        Entry and exit taps at TfL&rsquo;s station gatelines — Underground,
        DLR, Overground and Elizabeth line — counted every day since 1
        January 2019. Each station&rsquo;s latest 12 months against its 2019.
        Click a line or station, or use the filters, to focus the page.
      </p>

      <div className="filter-bar">
        <span className="filter-group">
          <span className="filter-label">Line</span>
          <Select
            label="Filter by line"
            options={[
              { value: "", label: "All lines" },
              ...LINES.map((l) => ({ value: l.name, label: l.name })),
            ]}
            value={f.line ?? ""}
            onChange={(v) => setLine(v === "" ? null : v)}
          />
        </span>
        <span className="filter-group">
          <span className="filter-label">Station</span>
          <Select
            label="Filter by station"
            options={[
              { value: "", label: "All stations" },
              ...lineLabs.map((l) => ({ value: l.station, label: l.station })),
            ]}
            value={f.station ?? ""}
            onChange={(v) => set("station", v === "" ? null : v)}
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
          label="Gate taps vs 2019"
          loading={pending}
          value={rAll !== null ? fmtPct(rAll) : "—"}
          delta={
            base && rAll !== null
              ? `${fmtCompact(totL)} a day, against ${fmtCompact(tot19)} in ${BASE_YEAR}`
              : undefined
          }
        />
        <StatTile
          label="Weekdays vs 2019"
          loading={pending}
          value={rWd !== null ? fmtPct(rWd) : "—"}
          delta={rWe !== null ? `weekends ${fmtPct(rWe)} — same 12 months` : undefined}
        />
        {f.station ? (
          <StatTile
            label="Rank by recovery"
            loading={pending}
            value={stationRank > 0 ? fmtInt(stationRank) : "—"}
            delta={`of ${fmtInt(ranked.length)} ${f.line ? "on this line" : "comparable stations"}`}
          />
        ) : (
          <StatTile
            label="Stations back to 2019"
            loading={pending}
            value={base ? `${fmtInt(above)} of ${fmtInt(ranked.length)}` : "—"}
            delta={base ? `stations${f.line ? " on this line" : ""} at or above their 2019 level` : undefined}
          />
        )}
        <StatTile
          label="Latest data"
          loading={pending}
          value={base ? fmtDate(base.dataTo) : "—"}
          delta={base ? `daily counts since ${fmtDate(base.dataFrom)}` : undefined}
        />
      </StatRow>

      <div className="dash-grid">
        {/* Detail: follows every filter, not itself clickable (v1). */}
        <div className="chart-card full">
          <h3>Month by month, against 2019</h3>
          <p className="chart-sub">
            Average taps a day each month {scopeIn}, as a share of the same
            month in {BASE_YEAR} — weekdays and weekends apart, since they
            recovered differently.
          </p>
          {months ? (
            <MultiLineChart
              labels={months.labels}
              series={[
                { name: "Weekdays", color: "var(--series-1)", values: months.wd },
                { name: "Weekends", color: "var(--series-2)", values: months.we },
              ]}
              height={SERIES_HEIGHT}
              formatTick={fmtPct0}
              formatValue={fmtPct}
              xTicks={months.labels
                .map((m, i) => ({ m, i }))
                .filter(({ m }) => m.endsWith("-01"))
                .map(({ i }) => i)}
              formatXTick={(m) => m.slice(0, 4)}
              tipHeader={monthLabel}
              band={{ from: "2020-03", to: "2022-02", label: "Covid restrictions" }}
              ariaLabel="Average gate taps a day each month as a share of the same month in 2019, weekdays and weekends, under the active filters. Use arrow keys to step through the months; the tooltip gives both."
            />
          ) : (
            pending && <LoadingPanel height={SERIES_HEIGHT + 30} />
          )}
        </div>

        <div className="chart-card">
          <h3>Recovery by line</h3>
          <p className="chart-sub">
            Taps a day in the latest 12 months as a share of {BASE_YEAR}, at
            the stations each line serves today. Click a row to focus that
            line.
            {f.line && lineRank > 0 ? (
              <>
                {" "}
                <strong>{f.line}</strong> ranks {lineRank} of {LINES.length}.
              </>
            ) : f.station ? (
              <>
                {" "}
                <strong>{f.station}</strong>: {lineList(f.station)}.
              </>
            ) : null}
          </p>
          {base ? (
            <RankedBars
              rows={lineRows}
              rowHeight={LINE_ROW}
              labelWidth={140}
              refValue={1}
              refLabel={String(BASE_YEAR)}
              formatTick={fmtPct0}
              formatValue={fmtPct0}
              tipValue={(row) => `${fmtPct(row.value)} of ${BASE_YEAR}`}
              tipLabel={(row) => `${row.label} · ${row.count} comparable stations`}
              selected={f.line}
              onSelect={(label) => setLine(f.line === label ? null : label)}
              ariaLabel="TfL lines ranked by gate taps in the latest 12 months as a share of 2019. Use arrow keys to step through the lines; Enter filters the page to that line."
            />
          ) : (
            pending && <LoadingPanel height={LINE_RANK_HEIGHT} />
          )}
        </div>

        <div className="chart-card">
          <h3>How the stations spread</h3>
          <p className="chart-sub">
            Comparable stations{onTheLine} by their
            latest 12 months as a share of {BASE_YEAR}, in ten-point bands.
            {f.station && stationR !== null ? (
              <>
                {" "}
                <strong>{f.station}</strong> is at {fmtPct(stationR)}.
              </>
            ) : null}
          </p>
          {base ? (
            <CategoryBars
              bars={bins}
              height={LINE_RANK_HEIGHT}
              formatTick={(v) => fmtInt(v)}
              formatValue={(v) => fmtInt(v)}
              tipLabel={(b) => {
                const i = bins.indexOf(b);
                return `stations ${binRange(i)} · ${fmtPct0(b.share ?? 0)} of them`;
              }}
              selected={selectedBin}
              ariaLabel="Number of stations in each band of recovery against 2019. Use arrow keys to step through the bands."
            />
          ) : (
            pending && <LoadingPanel height={LINE_RANK_HEIGHT} />
          )}
        </div>

        {[
          {
            title: "Furthest above 2019",
            sub: `The ${nStations(nRise)}${onTheLine} that ${nRise === 1 ? "has" : "have"} grown most.`,
            rows: riseRows,
            domainMax: undefined,
          },
          {
            title: "Furthest below 2019",
            sub: `The ${nStations(nFall)}${onTheLine} furthest from ${nFall === 1 ? "its" : "their"} ${BASE_YEAR} level.`,
            rows: fallRows,
            domainMax: 1,
          },
        ].map((card) => (
          <div className="chart-card" key={card.title}>
            <h3>{card.title}</h3>
            <p className="chart-sub">
              {card.sub} Click a row to focus that station.
              {f.station && stationRank > 0 && card.rows.every((r) => r.label !== f.station) ? (
                <>
                  {" "}
                  <strong>{f.station}</strong> ranks {fmtInt(stationRank)} of {fmtInt(ranked.length)}.
                </>
              ) : null}
            </p>
            {base ? (
              <div style={{ minHeight: MOVER_HEIGHT }}>
                <RankedBars
                  rows={card.rows}
                  rowHeight={MOVER_ROW}
                  labelWidth={176}
                  refValue={1}
                  refLabel={String(BASE_YEAR)}
                  domainMax={card.domainMax}
                  formatTick={fmtPct0}
                  formatValue={fmtPct0}
                  tipValue={(row) => `${fmtPct(row.value)} of ${BASE_YEAR}`}
                  tipLabel={(row) =>
                    `${row.label} · ${fmtCompact(row.count)} a day vs ${fmtCompact(base19.get(row.label) ?? 0)}`
                  }
                  selected={f.station}
                  onSelect={toggleStation}
                  ariaLabel={`${card.title}: stations ranked by gate taps as a share of 2019. Use arrow keys to step through the rows; Enter filters the page to that station.`}
                />
              </div>
            ) : (
              pending && <LoadingPanel height={MOVER_HEIGHT} />
            )}
          </div>
        ))}

        {/* Detail: an open table — exact values are this card's point. */}
        <div className="chart-card full">
          <h3>The busiest stations of 2019, now</h3>
          <p className="chart-sub">
            The {nStations(Math.min(TABLE_ROWS, lineLabs.length))}{onTheLine} with
            the most taps a day in {BASE_YEAR}, against {windowPhrase}.
          </p>
          {base ? (
            <div className="table-wrap" style={{ minHeight: TABLE_MIN_HEIGHT }}>
              <table>
                <thead>
                  <tr>
                    <th>Station</th>
                    <th className="num">{BASE_YEAR}, a day</th>
                    <th className="num">Latest year, a day</th>
                    <th className="num">Share of {BASE_YEAR}</th>
                    <th className="num">Weekdays</th>
                    <th className="num">Weekends</th>
                  </tr>
                </thead>
                <tbody>
                  {busiest.map((row, i) =>
                    row ? (
                      <tr key={row.station}>
                        <td>{row.station === f.station ? <strong>{row.station}</strong> : row.station}</td>
                        <td className="num">{fmtInt(Math.round(row.a19))}</td>
                        <td className="num">{fmtInt(Math.round(row.al))}</td>
                        <td className="num">{fmtPct(row.al / row.a19)}</td>
                        <td className="num">{fmtPct(row.alwd / row.a19wd)}</td>
                        <td className="num">{fmtPct(row.alwe / row.a19we)}</td>
                      </tr>
                    ) : (
                      <tr key={`empty-${i}`}>
                        <td>—</td>
                        <td className="num" />
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
            These are <strong>taps at TfL gatelines</strong>, entries plus
            exits: a journey between two TfL stations adds two, and a trip that
            changes lines inside the gates adds nothing. They are not journeys
            or passengers, and they leave out anyone using a station&rsquo;s
            National Rail gates where TfL doesn&rsquo;t run them.
          </li>
          <li>
            Each figure is an <strong>average a day</strong> over the days with
            a published count — {BASE_YEAR} against {windowPhrase}. Missing
            days (closures, data gaps) are left out rather than counted as zero.
          </li>
          <li>
            Only <strong>comparable stations</strong> are measured: a count on
            at least {MIN_BASE_DAYS} days of {BASE_YEAR} and {MIN_LATEST_DAYS} of
            the latest year
            {base ? ` — ${fmtInt(base.labs.length)} of TfL's ${fmtInt(base.totalLabels)} station names` : ""}.
            TfL adds names as gates open — &ldquo;Paddington EL&rdquo; from
            February 2021, the Reading branch from October 2020, Battersea Power
            Station and Nine Elms from 2021 — and those have no {BASE_YEAR} to
            compare with, so they are left out rather than flattering their
            stations.
          </li>
          <li>
            The <strong>Elizabeth line</strong> drives many of the extremes.
            Where its passengers use gates shared with the Underground
            (Tottenham Court Road, Farringdon, Whitechapel), they count at the
            Underground station, which is why those soar; where it took
            passengers away (Woolwich Arsenal DLR), stations fall.
          </li>
          <li>
            <strong>Lines are today&rsquo;s</strong>, applied to every date
            (the Overground&rsquo;s six names date from November 2024), and a
            station counts on every line that serves it. Linking TfL&rsquo;s
            station names to lines uses a crosswalk compiled by the uk-open-data
            pipeline, not published by TfL
            {base && base.unmatched > 0
              ? `; ${base.unmatched} name(s) are currently unmatched and appear only under All lines`
              : ""}
            .
          </li>
          <li>
            March 2020 to February 2022 (shaded) were shaped by Covid
            restrictions. {BASE_YEAR} is the baseline because it is the last
            full year before them.
          </li>
        </ul>
        <p>
          Data: <a href={hfRepoUrl(FAMILY)}>{FAMILY} on Hugging Face</a> ·{" "}
          <a href="https://crowding.data.tfl.gov.uk/">TfL&rsquo;s Network Demand data</a>{" "}
          under the TfL Transport Data Service licence. Powered by TfL Open
          Data. Station crosswalk compiled by uk-open-data from TfL StopPoint
          identifiers.
        </p>
      </div>
    </>
  );
}
