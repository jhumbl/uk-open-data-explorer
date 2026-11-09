import { useEffect, useState } from "react";
import { loadTable, query } from "../../lib/duckdb";
import { hfRepoUrl, hfFileUrl } from "../../lib/catalog";
import { fmtCompact, fmtDate, fmtPct, fmtPct0 } from "../../lib/format";
import { StatRow, StatTile } from "../../components/charts/StatTile";
import LoadingPanel from "../../components/charts/LoadingPanel";
import Segmented from "../../components/charts/Segmented";
import CategoryBars, { type CategoryBar } from "../../components/charts/CategoryBars";
import RankedBars, { type RankedBar } from "../../components/charts/RankedBars";
import MultiLineChart, { type Series } from "../../components/charts/MultiLineChart";

/**
 * Has London's public transport come back since Covid — on which modes,
 * and on which days?
 *
 * Design spec (2026-11-09, anchored against the live parquets that day):
 *   - Two tiny files, each loaded once into DuckDB memory (13 KB +
 *     45 KB); every view toggle is pure JS over the loaded results — zero
 *     network after load.
 *   - The mode series is per 4-weekly TfL period, and periods vary from
 *     26 to 32 days, so every figure is journeys PER DAY (journeys ÷
 *     days_in_period). Recovery compares a window's per-day average with
 *     FY 2018-19's, the last full pre-Covid year.
 *   - Anchors: last 13 periods to 17 Oct 2026 vs 2018-19 — all modes
 *     87.6% (9.61M vs 10.96M a day), Bus 79.3%, Underground 86.9%,
 *     Overground 100.1%, DLR 73.2%, Tram 69.7%. Daily file, last 364
 *     days vs 2019: Tube Saturday 97.6%, Sunday 97.5%, Friday 77.7%.
 *   - The Elizabeth line is charted but never ranked: its 2018-19 figure
 *     is TfL Rail, a different service (4.4× on that baseline).
 *   - Bus counts in the two files do not reconcile (FY 2018-19 2,220M
 *     boardings vs calendar 2019 1,935M journeys), so the day-of-week
 *     card's percentages are never mixed with the mode card's.
 */

const F_MODES = { family: "tfl-journeys-by-mode", file: "tfl_journeys_by_mode.parquet" };
const F_DAILY = { family: "tfl-network-demand", file: "tfl_network_daily_journeys.parquet" };

const T_MODES = "tfl_modes";
const T_DAILY = "tfl_daily";

const LOAD_MODES = `
  SELECT financial_year, period, period_start, period_end, days_in_period,
         mode, journeys_millions
  FROM read_parquet('${hfFileUrl(F_MODES.family, F_MODES.file)}')
`;
const LOAD_DAILY = `
  SELECT travel_date::DATE AS d, day_of_week,
         tube_journey_count AS tube, bus_journey_count AS bus
  FROM read_parquet('${hfFileUrl(F_DAILY.family, F_DAILY.file)}')
`;

const BASE_FY = "2018-19";
const BASE_YEAR = 2019;

/** The line chart's four series — colour follows the mode, fixed slots. */
const OTHER_MODES = ["DLR", "Overground", "Tram", "London Cable Car"];

/** Modes ranked for recovery: every mode whose service existed in the
    baseline year. The Elizabeth line is excluded (TfL Rail in 2018-19). */
const RANKED = [
  { mode: "Bus", label: "Bus" },
  { mode: "Underground", label: "Underground" },
  { mode: "Overground", label: "Overground" },
  { mode: "DLR", label: "DLR" },
  { mode: "Tram", label: "Tram" },
  { mode: "London Cable Car", label: "Cable car" },
];

const DAYS = [
  ["Monday", "Mon"],
  ["Tuesday", "Tue"],
  ["Wednesday", "Wed"],
  ["Thursday", "Thu"],
  ["Friday", "Fri"],
  ["Saturday", "Sat"],
  ["Sunday", "Sun"],
] as const;

// Two-up cards must meet (charts skill rule 9): ranking rows × pitch +
// RankedBars' 52px of margins equals the day chart's height.
const RANK_ROW = 34;
const HALF_HEIGHT = RANKED.length * RANK_ROW + 52;
const LINE_HEIGHT = 300;

interface PeriodRow {
  period_start: string;
  period_end: string;
  financial_year: string;
  period: number;
  bus: number | null;
  tube: number | null;
  el: number | null;
  other: number | null;
}
interface ModeRate {
  mode: string;
  now: number | null;
  base: number | null;
}
interface RecoveryWindow {
  /** Segmented key. */
  key: "last13" | "fy";
  /** Control label. */
  label: string;
  /** Prose phrase, e.g. "the 13 periods to 17 Oct 2026". */
  phrase: string;
  rates: ModeRate[];
}
interface DayRow {
  day: string;
  tube_now: number;
  tube_base: number;
  bus_now: number;
  bus_base: number;
}
interface Data {
  periods: PeriodRow[];
  windows: RecoveryWindow[];
  days: DayRow[];
  dayFrom: string;
  dayTo: string;
}

/** Per-day journeys for one mode over a set of periods, plus the same
    for the baseline year. Days count only periods with a figure. */
function ratesSql(windowWhere: string): string {
  const perDay = (where: string) => `
    SELECT mode,
           sum(journeys_millions) * 1e6
             / nullif(sum(days_in_period) FILTER (WHERE journeys_millions IS NOT NULL), 0) AS d
    FROM ${T_MODES} WHERE ${where} GROUP BY mode`;
  return `
    WITH cur AS (${perDay(windowWhere)}), base AS (${perDay(`financial_year = '${BASE_FY}'`)})
    SELECT cur.mode, cur.d AS now, base.d AS base
    FROM cur LEFT JOIN base USING (mode)
  `;
}

async function runQueries(): Promise<Data> {
  // The series starts where TfL's reliable Overground figures do
  // (October 2010), so the "Other rail" sum never jumps on a missing mode.
  const periods = await query<PeriodRow>(`
    WITH start AS (
      SELECT min(period_start) AS s FROM ${T_MODES}
      WHERE mode = 'Overground' AND journeys_millions IS NOT NULL
    )
    SELECT period_start, any_value(period_end) AS period_end,
           any_value(financial_year) AS financial_year,
           any_value(period) AS period,
           sum(journeys_millions) FILTER (WHERE mode = 'Bus') * 1e6 / any_value(days_in_period) AS bus,
           sum(journeys_millions) FILTER (WHERE mode = 'Underground') * 1e6 / any_value(days_in_period) AS tube,
           nullif(sum(journeys_millions) FILTER (WHERE mode = 'Elizabeth line'), 0) * 1e6 / any_value(days_in_period) AS el,
           sum(coalesce(journeys_millions, 0)) FILTER (WHERE mode IN (${OTHER_MODES.map((m) => `'${m}'`).join(", ")})) * 1e6 / any_value(days_in_period) AS other
    FROM ${T_MODES}, start
    WHERE period_start >= start.s
    GROUP BY period_start
    ORDER BY period_start
  `);

  const last13 = `period_start IN (SELECT DISTINCT period_start FROM ${T_MODES} ORDER BY period_start DESC LIMIT 13)`;
  const [{ fy }] = await query<{ fy: string }>(`
    SELECT max(financial_year) AS fy FROM (
      SELECT financial_year FROM ${T_MODES}
      GROUP BY financial_year HAVING count(DISTINCT period) = 13
    )
  `);
  const rates13 = await query<ModeRate>(ratesSql(last13));
  const ratesFy = await query<ModeRate>(ratesSql(`financial_year = '${fy}'`));

  const lastEnd = periods[periods.length - 1]?.period_end ?? "";
  const windows: RecoveryWindow[] = [
    {
      key: "last13",
      label: "Latest 13 periods",
      phrase: `the 13 periods to ${lastEnd ? fmtDate(lastEnd) : "—"}`,
      rates: rates13,
    },
    { key: "fy", label: fy, phrase: `financial year ${fy}`, rates: ratesFy },
  ];

  // Same weekday mix on both sides: the latest 52 whole weeks against
  // calendar 2019, averaged per weekday.
  const days = await query<DayRow>(`
    WITH lim AS (SELECT max(d) AS mx FROM ${T_DAILY}),
    cur AS (
      SELECT day_of_week, avg(tube) AS tube, avg(bus) AS bus
      FROM ${T_DAILY}, lim WHERE d > mx - 364 GROUP BY 1
    ),
    base AS (
      SELECT day_of_week, avg(tube) AS tube, avg(bus) AS bus
      FROM ${T_DAILY} WHERE year(d) = ${BASE_YEAR} GROUP BY 1
    )
    SELECT c.day_of_week AS day, c.tube AS tube_now, b.tube AS tube_base,
           c.bus AS bus_now, b.bus AS bus_base
    FROM cur c JOIN base b USING (day_of_week)
  `);
  const [range] = await query<{ dayFrom: string; dayTo: string }>(`
    SELECT strftime(max(d) - 363, '%Y-%m-%d') AS dayFrom,
           strftime(max(d), '%Y-%m-%d') AS dayTo
    FROM ${T_DAILY}
  `);

  return { periods, windows, days, dayFrom: range.dayFrom, dayTo: range.dayTo };
}

/** Recovery ratio of a set of modes (or one), null-safe. */
function ratio(rates: ModeRate[], modes?: string[]) {
  const pick = modes ? rates.filter((r) => modes.includes(r.mode)) : rates;
  const now = pick.reduce((s, r) => s + (r.now ?? 0), 0);
  const base = pick.reduce((s, r) => s + (r.base ?? 0), 0);
  return { now, base, r: base > 0 ? now / base : null };
}

export default function TransportRecoveryDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowKey, setWindowKey] = useState<RecoveryWindow["key"]>("last13");
  const [dayMode, setDayMode] = useState<"tube" | "bus">("tube");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadTable(T_MODES, LOAD_MODES);
      await loadTable(T_DAILY, LOAD_DAILY);
      const d = await runQueries();
      if (!cancelled) setData(d);
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const pending = data === null && error === null;

  // ---- tiles: always the latest 13 periods (the most current year) ----
  const w13 = data?.windows.find((w) => w.key === "last13");
  const all = w13 ? ratio(w13.rates) : null;
  const bus = w13 ? ratio(w13.rates, ["Bus"]) : null;
  const tube = w13 ? ratio(w13.rates, ["Underground"]) : null;
  const daySum = (names: string[], k: "tube_now" | "tube_base") =>
    (data?.days ?? [])
      .filter((r) => names.includes(r.day))
      .reduce((s, r) => s + r[k], 0);
  const WEEKEND = ["Saturday", "Sunday"];
  const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const weekendR = data
    ? daySum(WEEKEND, "tube_now") / daySum(WEEKEND, "tube_base")
    : null;
  const weekdayR = data
    ? daySum(WEEKDAYS, "tube_now") / daySum(WEEKDAYS, "tube_base")
    : null;

  // ---- line chart ----
  const periods = data?.periods ?? [];
  const labels = periods.map((p) => p.period_start);
  const series: Series[] = [
    { name: "Bus", color: "var(--series-1)", values: periods.map((p) => p.bus) },
    { name: "Underground", color: "var(--series-2)", values: periods.map((p) => p.tube) },
    { name: "Elizabeth line", color: "var(--series-3)", values: periods.map((p) => p.el) },
    {
      name: "DLR, Overground, tram & cable car",
      color: "var(--series-4)",
      values: periods.map((p) => p.other),
    },
  ];
  // A tick at the first period of every other financial year.
  const xTicks = periods
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.period === 1 && Number(p.financial_year.slice(0, 4)) % 2 === 0)
    .map(({ i }) => i);
  const byStart = new Map(periods.map((p) => [p.period_start, p]));
  const covidFrom = periods.find((p) => p.period_start >= "2020-03-01")?.period_start;
  const covidTo = [...periods].reverse().find((p) => p.financial_year === "2021-22")?.period_start;

  // ---- ranking ----
  const win = data?.windows.find((w) => w.key === windowKey);
  const rateByMode = new Map((win?.rates ?? []).map((r) => [r.mode, r]));
  const rankRows: RankedBar[] = RANKED.map(({ mode, label }) => {
    const r = rateByMode.get(mode);
    return {
      label,
      value: r?.now != null && r.base ? r.now / r.base : 0,
      count: r?.now ?? 0,
    };
  }).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const baseByLabel = new Map(
    RANKED.map(({ mode, label }) => [label, rateByMode.get(mode)?.base ?? null]),
  );
  const winAll = win ? ratio(win.rates) : null;

  // ---- day of week ----
  const dayByName = new Map((data?.days ?? []).map((r) => [r.day, r]));
  const dayBars: CategoryBar[] = DAYS.map(([full, short]) => {
    const r = dayByName.get(full);
    const now = r ? (dayMode === "tube" ? r.tube_now : r.bus_now) : 0;
    const base = r ? (dayMode === "tube" ? r.tube_base : r.bus_base) : 0;
    return { label: short, value: base > 0 ? now / base : 0 };
  });
  const dayDetail = (short: string) => {
    const full = DAYS.find(([, s]) => s === short)?.[0] ?? short;
    const r = dayByName.get(full);
    if (!r) return full;
    const now = dayMode === "tube" ? r.tube_now : r.bus_now;
    const base = dayMode === "tube" ? r.tube_base : r.bus_base;
    return `${full} · ${fmtCompact(now)} a day vs ${fmtCompact(base)} in ${BASE_YEAR}`;
  };

  const pctOf = (r: number | null) => (r !== null ? fmtPct(r) : "—");

  return (
    <>
      <h2 className="dash-title">Journeys on London&rsquo;s transport</h2>
      <p className="dash-sub">
        Journeys on TfL&rsquo;s buses, Underground, Elizabeth line, DLR,
        Overground, trams and cable car since 2010, per day, set against
        the last full year before Covid. TfL&rsquo;s four-weekly
        journeys-by-mode series, with its daily Underground and bus totals
        for the day-of-week view.
      </p>

      {error && (
        <div className="notice" role="alert">
          <strong>The query failed.</strong> {error}
          <br />
          The datasets themselves are at{" "}
          <a href={hfRepoUrl(F_MODES.family)}>{F_MODES.family}</a> and{" "}
          <a href={hfRepoUrl(F_DAILY.family)}>{F_DAILY.family}</a> on Hugging
          Face.
        </div>
      )}

      <StatRow>
        <StatTile
          label="All journeys vs 2018-19"
          loading={pending}
          value={pctOf(all?.r ?? null)}
          delta={
            all ? `${fmtCompact(all.now)} a day, latest 13 periods, vs ${fmtCompact(all.base)}` : undefined
          }
        />
        <StatTile
          label="Bus vs 2018-19"
          loading={pending}
          value={pctOf(bus?.r ?? null)}
          delta={
            bus ? `${fmtCompact(bus.now)} a day, latest 13 periods, vs ${fmtCompact(bus.base)}` : undefined
          }
        />
        <StatTile
          label="Underground vs 2018-19"
          loading={pending}
          value={pctOf(tube?.r ?? null)}
          delta={
            tube ? `${fmtCompact(tube.now)} a day, latest 13 periods, vs ${fmtCompact(tube.base)}` : undefined
          }
        />
        <StatTile
          label="Tube at weekends vs 2019"
          loading={pending}
          value={pctOf(weekendR)}
          delta={
            weekdayR !== null
              ? `against ${fmtPct(weekdayR)} on weekdays — latest 52 weeks, daily series`
              : undefined
          }
        />
      </StatRow>

      <div className="dash-grid">
        <div className="chart-card full">
          <h3>Journeys per day, by mode</h3>
          <p className="chart-sub">
            Average journeys a day in each four-week TfL period
            {periods.length > 0
              ? `, ${fmtDate(periods[0].period_start)} → ${fmtDate(periods[periods.length - 1].period_end)}`
              : ""}
            . Bus counts boardings. The Elizabeth line series is TfL Rail
            until May 2022.
          </p>
          {data && periods.length > 0 ? (
            <MultiLineChart
              labels={labels}
              series={series}
              height={LINE_HEIGHT}
              formatTick={fmtCompact}
              formatValue={fmtCompact}
              xTicks={xTicks}
              formatXTick={(l) => l.slice(0, 4)}
              tipHeader={(l) => {
                const p = byStart.get(l);
                return p
                  ? `${p.financial_year} P${p.period} · ${fmtDate(p.period_start)} – ${fmtDate(p.period_end)}`
                  : l;
              }}
              band={
                covidFrom && covidTo
                  ? { from: covidFrom, to: covidTo, label: "Covid years" }
                  : undefined
              }
              ariaLabel="Average journeys per day by mode for every four-week TfL period since October 2010. Use arrow keys to step through periods; the tooltip lists every mode."
            />
          ) : (
            pending && <LoadingPanel height={LINE_HEIGHT + 30} />
          )}
        </div>

        <div className="chart-card">
          <h3>Recovery by mode</h3>
          <p className="chart-sub">
            Journeys a day in {win ? win.phrase : "the latest year"} as a
            share of {BASE_FY}
            {winAll?.r != null ? ` (all modes: ${fmtPct(winAll.r)})` : ""}.
            The Elizabeth line is left out: in {BASE_FY} it was TfL Rail.
          </p>
          <Segmented
            label="Recovery window"
            options={(data?.windows ?? [{ key: "last13", label: "Latest 13 periods" }]).map(
              (w) => ({ value: w.key, label: w.label }),
            )}
            value={windowKey}
            onChange={setWindowKey}
          />
          {data ? (
            <RankedBars
              rows={rankRows}
              rowHeight={RANK_ROW}
              labelWidth={96}
              refValue={1}
              refLabel={BASE_FY}
              ticks={[0.25, 0.5, 0.75, 1]}
              formatTick={fmtPct0}
              formatValue={fmtPct0}
              tipValue={(row) => `${fmtPct(row.value)} of ${BASE_FY}`}
              tipLabel={(row) => {
                const base = baseByLabel.get(row.label);
                return `${row.label} · ${fmtCompact(row.count)} a day vs ${base != null ? fmtCompact(base) : "—"}`;
              }}
              ariaLabel={`Journeys per day by mode as a share of ${BASE_FY}. Use arrow keys to step through the modes.`}
            />
          ) : (
            pending && <LoadingPanel height={HALF_HEIGHT} />
          )}
        </div>

        <div className="chart-card">
          <h3>Recovery by day of the week</h3>
          <p className="chart-sub">
            Average journeys on each weekday over the 52 weeks
            {data ? ` ${fmtDate(data.dayFrom)} – ${fmtDate(data.dayTo)}` : ""},
            as a share of the same weekday in {BASE_YEAR}. TfL&rsquo;s daily
            series, which counts differently from the mode series.
          </p>
          <Segmented
            label="Day-of-week mode"
            options={[
              { value: "tube", label: "Underground" },
              { value: "bus", label: "Bus" },
            ]}
            value={dayMode}
            onChange={setDayMode}
          />
          {data ? (
            <CategoryBars
              bars={dayBars}
              height={HALF_HEIGHT}
              formatTick={fmtPct0}
              formatValue={fmtPct}
              tipLabel={(b) => dayDetail(b.label)}
              ariaLabel={`${dayMode === "tube" ? "Underground" : "Bus"} journeys by day of the week as a share of ${BASE_YEAR}. Use arrow keys to step through the days.`}
            />
          ) : (
            pending && <LoadingPanel height={HALF_HEIGHT} />
          )}
        </div>
      </div>

      <div className="caveats">
        <h4>How to read this</h4>
        <ul>
          <li>
            Every figure is <strong>journeys per day</strong>. TfL reports in
            four-week periods, but the first and last of each financial year
            run from 1 April and to 31 March, so periods last 26 to 32 days;
            dividing by each period&rsquo;s length makes them comparable.
          </li>
          <li>
            The baseline is <strong>{BASE_FY}</strong>, the last full
            financial year before Covid. 2019-20 (from March 2020), 2020-21
            and 2021-22 reflect restrictions and recovery, and are shaded on
            the chart.
          </li>
          <li>
            Modes are counted differently: bus figures are boardings, DLR
            uses automatic counts at stations, Overground and tram on-train
            counts. TfL rounds each period to 0.1 million journeys (0.01
            million for the cable car).
          </li>
          <li>
            The <strong>Elizabeth line</strong> series is TfL&rsquo;s
            &ldquo;TfL Rail&rdquo; column: TfL Rail services from May 2015,
            the Elizabeth line from May 2022. TfL gives figures from April
            2014 without saying what they cover. Its {BASE_FY} figure is for
            a different service, so it has no recovery percentage.
          </li>
          <li>
            The chart starts in October 2010, when TfL&rsquo;s reliable
            Overground figures begin. The cable car opened in June 2012;
            periods with no cable car figure count as zero in the combined
            line.
          </li>
          <li>
            The <strong>day-of-week</strong> card uses TfL&rsquo;s separate
            daily Underground and bus totals (rounded to the nearest
            thousand), compared with calendar {BASE_YEAR}. They don&rsquo;t
            reconcile with the mode series, especially for buses, so its
            percentages aren&rsquo;t interchangeable with the mode
            card&rsquo;s.
          </li>
          <li>
            The latest periods and days are revised slightly in later TfL
            uploads.
          </li>
        </ul>
        <p>
          Data:{" "}
          <a href={hfRepoUrl(F_MODES.family)}>{F_MODES.family}</a> and{" "}
          <a href={hfRepoUrl(F_DAILY.family)}>{F_DAILY.family}</a> on Hugging
          Face · published by{" "}
          <a href="https://data.london.gov.uk/dataset/public-transport-journeys-by-type-of-transport-ep8ow">
            Transport for London via the London Datastore
          </a>{" "}
          under OGL v2.0, and by{" "}
          <a href="https://crowding.data.tfl.gov.uk/">TfL&rsquo;s Network Demand data</a>{" "}
          under the TfL Transport Data Service licence. Powered by TfL Open
          Data.
        </p>
      </div>
    </>
  );
}
