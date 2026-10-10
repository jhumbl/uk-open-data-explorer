import { useEffect, useState } from "react";
import { loadTable, query } from "../../lib/duckdb";
import { hfFileUrl, hfRepoUrl } from "../../lib/catalog";
import {
  buildWhere,
  eq,
  sqlString,
  useCrossFilter,
  type FilterState,
} from "../../lib/crossfilter";
import { fmtInt, fmtPct, fmtPct0 } from "../../lib/format";
import { StatRow, StatTile } from "../../components/charts/StatTile";
import LoadingPanel from "../../components/charts/LoadingPanel";
import Segmented from "../../components/charts/Segmented";
import Select from "../../components/charts/Select";
import CategoryBars, { type CategoryBar } from "../../components/charts/CategoryBars";
import RankedBars, { type RankedBar } from "../../components/charts/RankedBars";
import Legend from "../../components/charts/Legend";
import HygieneMap, {
  BAND_LEGEND,
  MAP_HEIGHT,
  type MapPoint,
} from "./HygieneMap";

/**
 * Food hygiene in London — the cross-filter pilot (charts skill ·
 * Dashboard philosophy).
 *
 * Design spec (2026-07-17, anchored against the live parquet that day):
 *   - One question: where in London — and in what kinds of places — are
 *     good and bad hygiene ratings concentrated?
 *   - The data is a STOCK: the FSA's currently published rating per
 *     establishment (80,877 listed; 70,902 rated; 68.3% rated 5; 5.5%
 *     rated 0–2), each from its most recent inspection (median ≈ 1.1
 *     years old). No archive, so no trends.
 *   - Dimensions: rating (0–5), borough (33), business type (14). All
 *     three are filterable from the bar AND by clicking the matching
 *     chart; the bar is the single display of filter state.
 *   - Overview cards exclude their own dimension (selection = highlight
 *     + narrow); tiles and the detail card ("how old are these
 *     ratings?") apply every filter.
 *   - The rankings' measure ("share rated r") would be annihilated by a
 *     rating filter applied as WHERE, so the rating filter scopes their
 *     NUMERATOR instead: filter to rating 1 and they re-rank by "share
 *     rated 1", denominators still each row's full rated count. Stated
 *     in the card subtitles and the caveats.
 *   - The map (added 2026-07-17) is row-level detail under the approved
 *     map rule: one dot per geocoded establishment, re-derived under
 *     EVERY active filter, tooltip-only — dots never click-filter.
 *     Anchors that day: 60,639 of 70,902 rated places geocoded (85.5%);
 *     of those, 40,189 rated 5, 16,743 rated 3–4, 3,707 rated 0–2.
 *   - Query budget: one 5.1 MB CREATE TABLE at load (8 columns), then 7
 *     in-memory queries per interaction — zero network per click.
 */

const FAMILY = "fsa-food-hygiene-london";
const FILENAME = "fsa_fhrs_london_food_hygiene.parquet";
const TABLE = "fhrs_london";

// Only what the dashboard reads — the parquet's score columns and
// remaining address lines stay out of memory. lat/lon are VARCHAR at
// source (and sometimes empty or junk), hence the TRY_CASTs.
const LOAD_SQL = `
  SELECT local_authority AS borough,
         business_type AS type,
         rating_value AS rating,
         TRY_CAST(rating_date AS DATE) AS rating_date,
         business_name AS name,
         concat_ws(', ', nullif(address_line_1, ''), nullif(post_code, '')) AS addr,
         TRY_CAST(longitude AS DOUBLE) AS lon,
         TRY_CAST(latitude AS DOUBLE) AS lat
  FROM read_parquet('${hfFileUrl(FAMILY, FILENAME)}')
`;

const RATINGS = ["0", "1", "2", "3", "4", "5"] as const;
/** Numeric FHRS ratings; 'Exempt'/'Awaiting…' rows fail this and are
    excluded from every chart (counted in the first tile's small print). */
const RATED = `rating IN ('0','1','2','3','4','5')`;

const AGE_BANDS = [
  "under 1 year",
  "1–2 years",
  "2–3 years",
  "3–5 years",
  "over 5 years",
] as const;

// Bands mirror the anchor script exactly (calendar intervals, not day
// counts). Rated rows all carry a parseable date (verified 2026-07-17).
const AGE_BAND_SQL = `CASE
  WHEN rating_date > current_date - INTERVAL 1 YEAR THEN 'under 1 year'
  WHEN rating_date > current_date - INTERVAL 2 YEAR THEN '1–2 years'
  WHEN rating_date > current_date - INTERVAL 3 YEAR THEN '2–3 years'
  WHEN rating_date > current_date - INTERVAL 5 YEAR THEN '3–5 years'
  ELSE 'over 5 years' END`;

/** FSA's business-type labels, shortened for chart rows, selects and
    prose. Keys are the raw data values (the filter state stores those). */
const TYPE_LABELS: Record<string, string> = {
  "Restaurant/Cafe/Canteen": "Restaurants & cafés",
  "Takeaway/sandwich shop": "Takeaways & sandwich shops",
  "Retailers - other": "Other retailers",
  "Retailers - supermarkets/hypermarkets": "Supermarkets",
  "Other catering premises": "Other catering",
  "Hospitals/Childcare/Caring Premises": "Hospitals & care premises",
  "School/college/university": "Schools & colleges",
  "Pub/bar/nightclub": "Pubs, bars & nightclubs",
  "Mobile caterer": "Mobile caterers",
  "Manufacturers/packers": "Manufacturers & packers",
  "Hotel/bed & breakfast/guest house": "Hotels & B&Bs",
  "Distributors/Transporters": "Distributors & transporters",
  "Importers/Exporters": "Importers & exporters",
  "Farmers/growers": "Farmers & growers",
};
const typeLabel = (raw: string) => TYPE_LABELS[raw] ?? raw;
/** Same label mid-sentence: lowercase the first letter only, so
    "Hotels & B&Bs" survives. */
const typeNoun = (raw: string) => {
  const l = typeLabel(raw);
  return l.charAt(0).toLowerCase() + l.slice(1);
};

const DIMS = ["rating", "borough", "type"] as const;
type Dim = (typeof DIMS)[number];

/** The rankings' fixed 0–100% axis, ticked at quarters. */
const SHARE_TICKS = [0.25, 0.5, 0.75, 1];

// Dense two-up layout (registry `wide` + .dash-grid): shorter vertical
// charts and a tighter ranking pitch than the chart defaults, so the
// three clickable facets share a screen. The borough pitch is looser
// than the type pitch so the tall card fills its two-row track.
const CHART_HEIGHT = 220;
const BOROUGH_ROW = 17;
const TYPE_ROW = 15;
// Row counts are fixed properties of the data (33 authorities, 14 FSA
// types) — used for loading-panel heights before the domains arrive.
const N_BOROUGHS = 33;
const N_TYPES = 14;

/** The scope phrase for subtitles and tile small print — built from the
    active filters, minus a card's own dimension. */
function scopePhrase(
  f: FilterState<Dim>,
  exclude: Partial<Record<Dim, boolean>> = {},
): string {
  const head = !exclude.type && f.type ? typeNoun(f.type) : "all establishments";
  const rating = !exclude.rating && f.rating ? `rated ${f.rating}` : null;
  const place = !exclude.borough && f.borough ? `in ${f.borough}` : "across London";
  return [head, rating, place].filter(Boolean).join(" ");
}

interface Tiles {
  listed: number;
  rated: number;
  r5: number;
  r012: number;
}
interface RankRow {
  /** Raw data value (borough name / FSA type label). */
  value: string;
  rated: number;
  pct: number;
}
interface RawRank {
  value: string;
  rated: number;
  hit: number;
}
interface Data {
  tiles: Tiles;
  dist: CategoryBar[];
  boroughs: RawRank[];
  types: RawRank[];
  points: MapPoint[];
  ages: CategoryBar[];
  medianYears: number | null;
}

/** Fixed-geometry ranking rows: every domain member always present
    (members with nothing in scope get a zero-length bar rather than
    vanishing — the card must not change size under a filter), sorted
    best-first. */
function rankRows(
  domain: string[],
  raw: { value: string; rated: number; hit: number }[],
): { rows: RankRow[]; avg: number } {
  const byValue = new Map(raw.map((r) => [r.value, r]));
  const rows = domain
    .map((value) => {
      const r = byValue.get(value);
      return {
        value,
        rated: r?.rated ?? 0,
        pct: r && r.rated > 0 ? r.hit / r.rated : 0,
      };
    })
    .sort((a, b) => b.pct - a.pct || a.value.localeCompare(b.value));
  const rated = raw.reduce((s, r) => s + r.rated, 0);
  const hit = raw.reduce((s, r) => s + r.hit, 0);
  return { rows, avg: rated > 0 ? hit / rated : 0 };
}

async function runQueries(f: FilterState<Dim>): Promise<Data> {
  // The rankings' share measure: "rated r" where r follows the rating
  // filter, defaulting to 5 (the headline measure).
  const r = f.rating ?? "5";

  const [tiles] = await query<Tiles>(`
    SELECT count(*) AS listed,
           count(*) FILTER (${RATED}) AS rated,
           count(*) FILTER (rating = '5') AS r5,
           count(*) FILTER (rating IN ('0','1','2')) AS r012
    FROM ${TABLE}
    ${buildWhere([eq("rating", f.rating), eq("borough", f.borough), eq("type", f.type)])}
  `);

  // Rating distribution — excludes its own dimension (the rating filter).
  const distRaw = await query<{ rating: string; n: number }>(`
    SELECT rating, count(*) AS n
    FROM ${TABLE}
    ${buildWhere([RATED, eq("borough", f.borough), eq("type", f.type)])}
    GROUP BY rating
  `);
  const distTotal = distRaw.reduce((s, d) => s + d.n, 0);
  // All six bins always render (zero-height allowed) so the selection
  // surface never shifts under a click.
  const dist: CategoryBar[] = RATINGS.map((label) => {
    const n = distRaw.find((d) => d.rating === label)?.n ?? 0;
    return { label, value: n, share: distTotal > 0 ? n / distTotal : 0 };
  });

  // Borough ranking — excludes the borough filter; rating scopes the
  // numerator only (see the header comment). Missing group members are
  // restored from the dimension domain in rankRows.
  const boroughs = await query<RawRank>(`
    SELECT borough AS value,
           count(*) FILTER (${RATED}) AS rated,
           count(*) FILTER (rating = ${sqlString(r)}) AS hit
    FROM ${TABLE}
    ${buildWhere([eq("type", f.type)])}
    GROUP BY borough
  `);

  // Business-type ranking — excludes the type filter.
  const types = await query<RawRank>(`
    SELECT type AS value,
           count(*) FILTER (${RATED}) AS rated,
           count(*) FILTER (rating = ${sqlString(r)}) AS hit
    FROM ${TABLE}
    ${buildWhere([eq("borough", f.borough)])}
    GROUP BY type
  `);

  // The map — row-level detail, so it applies every filter. Draw order
  // by severity: the rated-5 wash underneath, problems on top. The
  // tooltip's business-type label is shortened here, once per row.
  const pointsRaw = await query<MapPoint>(`
    SELECT name, addr, type, rating,
           coalesce(strftime(rating_date, '%b %Y'), '') AS inspected,
           lon, lat
    FROM ${TABLE}
    ${buildWhere([
      RATED,
      "lon IS NOT NULL",
      "lat IS NOT NULL",
      eq("rating", f.rating),
      eq("borough", f.borough),
      eq("type", f.type),
    ])}
    ORDER BY CASE WHEN rating = '5' THEN 0
                  WHEN rating IN ('3','4') THEN 1
                  ELSE 2 END
  `);
  const points = pointsRaw.map((p) => ({ ...p, type: typeLabel(p.type) }));

  // Detail card — applies every filter.
  const detailWhere = buildWhere([
    RATED,
    "rating_date IS NOT NULL",
    eq("rating", f.rating),
    eq("borough", f.borough),
    eq("type", f.type),
  ]);
  const agesRaw = await query<{ band: string; n: number }>(`
    SELECT ${AGE_BAND_SQL} AS band, count(*) AS n
    FROM ${TABLE} ${detailWhere}
    GROUP BY band
  `);
  const agesTotal = agesRaw.reduce((s, a) => s + a.n, 0);
  const ages: CategoryBar[] = AGE_BANDS.map((label) => {
    const n = agesRaw.find((a) => a.band === label)?.n ?? 0;
    return { label, value: n, share: agesTotal > 0 ? n / agesTotal : 0 };
  });
  const [med] = await query<{ days: number | null }>(`
    SELECT median(date_diff('day', rating_date, current_date)) AS days
    FROM ${TABLE} ${detailWhere}
  `);
  const medianYears = med.days === null ? null : med.days / 365.25;

  return { tiles, dist, boroughs, types, points, ages, medianYears };
}

export default function FoodHygieneDashboard() {
  const { filters: f, set, toggle, reset, isDefault } = useCrossFilter(DIMS);
  const [boroughOptions, setBoroughOptions] = useState<string[]>([]);
  const [typeOptions, setTypeOptions] = useState<string[]>([]);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Dimension domains, once the table is in memory — the selects render
  // immediately with just "All" and gain their options without moving.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadTable(TABLE, LOAD_SQL);
      const boroughs = await query<{ borough: string }>(
        `SELECT DISTINCT borough FROM ${TABLE} ORDER BY borough`,
      );
      const types = await query<{ type: string }>(
        `SELECT DISTINCT type FROM ${TABLE} ORDER BY type`,
      );
      if (cancelled) return;
      setBoroughOptions(boroughs.map((b) => b.borough));
      setTypeOptions(
        types
          .map((t) => t.type)
          .sort((a, b) => typeLabel(a).localeCompare(typeLabel(b))),
      );
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  // Every filter change re-runs the page's queries against the
  // in-memory table. Previous data stays on screen until the new rows
  // land (milliseconds), then everything snaps — no transitions.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadTable(TABLE, LOAD_SQL);
      const d = await runQueries(f);
      if (!cancelled) setData(d);
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [f]);

  const pending = data === null && error === null;
  const r = f.rating ?? "5";

  const tiles = data?.tiles ?? null;
  const unrated = tiles ? tiles.listed - tiles.rated : 0;

  // The domains can lag the first data query by a beat; fall back to the
  // queried members so the first paint is still complete.
  const boroughDomain =
    boroughOptions.length > 0
      ? boroughOptions
      : (data?.boroughs ?? []).map((b) => b.value);
  const typeDomain =
    typeOptions.length > 0
      ? typeOptions
      : (data?.types ?? []).map((t) => t.value);

  const { rows: boroughRanked, avg: boroughAvg } = rankRows(
    boroughDomain,
    data?.boroughs ?? [],
  );
  const { rows: typeRanked, avg: typeAvg } = rankRows(
    typeDomain,
    data?.types ?? [],
  );

  const boroughRows: RankedBar[] = boroughRanked.map((b) => ({
    label: b.value,
    value: b.pct,
    count: b.rated,
  }));
  const typeRows: RankedBar[] = typeRanked.map((t) => ({
    label: typeLabel(t.value),
    value: t.pct,
    count: t.rated,
  }));
  const rawTypeByLabel = new Map(
    typeRanked.map((t) => [typeLabel(t.value), t.value]),
  );

  const boroughRank = f.borough
    ? boroughRanked.findIndex((b) => b.value === f.borough)
    : -1;
  const typeRank = f.type
    ? typeRanked.findIndex((t) => t.value === f.type)
    : -1;

  const boroughsHeight = (boroughDomain.length || N_BOROUGHS) * BOROUGH_ROW + 52;
  const typesHeight = (typeDomain.length || N_TYPES) * TYPE_ROW + 52;

  return (
    <>
      <h2 className="dash-title">Food hygiene in London</h2>
      <p className="dash-sub">
        Every food establishment listed by London&rsquo;s 33 local
        authorities, with the Food Standards Agency&rsquo;s currently
        published hygiene rating — each rating is from the most recent
        inspection, so this is today&rsquo;s snapshot, not a history. Click
        any chart, or use the filters, to slice the whole page.
      </p>

      <div className="filter-bar">
        <span className="filter-group">
          <span className="filter-label">Rating</span>
          <Segmented
            label="Filter by rating"
            options={[
              { value: "", label: "All" },
              ...RATINGS.map((v) => ({ value: v as string, label: v as string })),
            ]}
            value={f.rating ?? ""}
            onChange={(v) => set("rating", v === "" ? null : v)}
          />
        </span>
        <span className="filter-group">
          <span className="filter-label">Borough</span>
          <Select
            label="Filter by borough"
            options={[
              { value: "", label: "All boroughs" },
              ...boroughOptions.map((b) => ({ value: b, label: b })),
            ]}
            value={f.borough ?? ""}
            onChange={(v) => set("borough", v === "" ? null : v)}
          />
        </span>
        <span className="filter-group">
          <span className="filter-label">Business type</span>
          <Select
            label="Filter by business type"
            options={[
              { value: "", label: "All types" },
              ...typeOptions.map((t) => ({ value: t, label: typeLabel(t) })),
            ]}
            value={f.type ?? ""}
            onChange={(v) => set("type", v === "" ? null : v)}
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
          label="Rated establishments"
          loading={pending}
          value={tiles ? fmtInt(tiles.rated) : "—"}
          delta={
            tiles
              ? `plus ${fmtInt(unrated)} exempt or awaiting inspection`
              : undefined
          }
        />
        <StatTile
          label="Rated 5 — “very good”"
          loading={pending}
          value={tiles && tiles.rated > 0 ? fmtPct(tiles.r5 / tiles.rated) : "—"}
          delta="of rated establishments in scope"
        />
        <StatTile
          label="Rated 0–2"
          loading={pending}
          value={tiles && tiles.rated > 0 ? fmtPct(tiles.r012 / tiles.rated) : "—"}
          delta="“improvement necessary” or worse"
        />
        <StatTile
          label="Median rating age"
          loading={pending}
          value={
            data?.medianYears != null
              ? `${data.medianYears.toFixed(1)} years`
              : "—"
          }
          delta="time since the last inspection"
        />
      </StatRow>

      <div className="dash-grid">
      <div className="chart-card">
        <h3>Ratings, 0 to 5</h3>
        <p className="chart-sub">
          How current ratings distribute for {scopePhrase(f, { rating: true })}.
          Click a bar to filter the page to that rating.
        </p>
        {data ? (
          <CategoryBars
            bars={data.dist}
            height={CHART_HEIGHT}
            selected={f.rating}
            onSelect={(label) => toggle("rating", label)}
            formatTick={fmtInt}
            formatValue={fmtInt}
            tipLabel={(b) =>
              `rated ${b.label} · ${fmtPct(b.share ?? 0)} of rated`
            }
            ariaLabel="Establishments by food hygiene rating, 0 to 5. Use arrow keys to step through the bars; Enter filters the page to that rating."
          />
        ) : (
          pending && <LoadingPanel height={CHART_HEIGHT} />
        )}
      </div>

      <div className="chart-card tall">
        <h3>Boroughs, ranked</h3>
        <p className="chart-sub">
          Of each borough&rsquo;s rated{" "}
          {f.type ? typeNoun(f.type) : "establishments"}, the share rated{" "}
          {r}. Click a row to focus that borough.
          {boroughRank >= 0 ? (
            <>
              {" "}
              <strong>{f.borough}</strong> ranks {boroughRank + 1} of{" "}
              {boroughRanked.length}.
            </>
          ) : null}
        </p>
        {data ? (
          <RankedBars
            rows={boroughRows}
            rowHeight={BOROUGH_ROW}
            domainMax={1}
            ticks={SHARE_TICKS}
            refValue={boroughAvg}
            refLabel="London"
            formatTick={fmtPct0}
            formatValue={fmtPct}
            tipValue={(row) => `${fmtPct(row.value)} rated ${r}`}
            tipLabel={(row) => `${row.label} · ${fmtInt(row.count)} rated places`}
            selected={f.borough}
            onSelect={(label) => toggle("borough", label)}
            ariaLabel={`Boroughs ranked by the share of rated establishments rated ${r}. Use arrow keys to step through the rows; Enter filters the page to that borough.`}
          />
        ) : (
          pending && <LoadingPanel height={boroughsHeight} />
        )}
      </div>

      <div className="chart-card">
        <h3>Business types, ranked</h3>
        <p className="chart-sub">
          Of each type&rsquo;s rated establishments{" "}
          {f.borough ? `in ${f.borough}` : "across London"}, the share rated{" "}
          {r}. Click a row to focus that type.
          {typeRank >= 0 && f.type ? (
            <>
              {" "}
              <strong>{typeLabel(f.type)}</strong> ranks {typeRank + 1} of{" "}
              {typeRanked.length}.
            </>
          ) : null}
        </p>
        {data ? (
          <RankedBars
            rows={typeRows}
            rowHeight={TYPE_ROW}
            domainMax={1}
            ticks={SHARE_TICKS}
            refValue={typeAvg}
            refLabel={f.borough ?? "London"}
            formatTick={fmtPct0}
            formatValue={fmtPct}
            tipValue={(row) => `${fmtPct(row.value)} rated ${r}`}
            tipLabel={(row) => `${row.label} · ${fmtInt(row.count)} rated places`}
            selected={f.type ? typeLabel(f.type) : null}
            onSelect={(label) => {
              const raw = rawTypeByLabel.get(label);
              if (raw) toggle("type", raw);
            }}
            ariaLabel={`Business types ranked by the share of rated establishments rated ${r}. Use arrow keys to step through the rows; Enter filters the page to that type.`}
          />
        ) : (
          pending && <LoadingPanel height={typesHeight} />
        )}
      </div>

      {/* The map: row-level detail under the approved map rule — dots
          re-derive under every filter, carry tooltips, and never
          click-filter (one establishment isn't a filter-bar state). */}
      <div className="chart-card full">
        <h3>On the map</h3>
        <p className="chart-sub">
          One dot per geocoded establishment for {scopePhrase(f)}, coloured
          by its current rating. Hover a dot for the establishment&rsquo;s
          details; about one rated place in seven has no published geocode
          and can&rsquo;t appear here.
        </p>
        <Legend items={BAND_LEGEND} />
        <div className="map-bleed">
          {data ? (
            <HygieneMap points={data.points} scoped={!isDefault} />
          ) : (
            pending && <LoadingPanel height={MAP_HEIGHT} />
          )}
        </div>
      </div>

      {/* The detail card: follows every filter, never replaces a ranking,
          and is not itself clickable (v1 — no nested drills). */}
      <div className="chart-card full">
        <h3>How old are these ratings?</h3>
        <p className="chart-sub">
          Time since the last inspection for {scopePhrase(f)}. A rating
          stays published until the next inspection.
        </p>
        {data ? (
          <CategoryBars
            bars={data.ages}
            height={CHART_HEIGHT}
            formatTick={fmtInt}
            formatValue={fmtInt}
            tipLabel={(b) =>
              `inspected ${b.label} ago · ${fmtPct(b.share ?? 0)} of these`
            }
            ariaLabel="Establishments by time since their last inspection. Use arrow keys to step through the bars."
          />
        ) : (
          pending && <LoadingPanel height={CHART_HEIGHT} />
        )}
      </div>
      </div>

      <div className="caveats">
        <h4>How to read this</h4>
        <ul>
          <li>
            A rating reflects the establishment&rsquo;s most recent
            inspection — the median rating here is about a year old and the
            tail runs to decades (last chart). The FSA publishes only the
            current state, so nothing on this page is a trend.
          </li>
          <li>
            Establishments that are exempt or awaiting inspection (about
            12% of the London list) are excluded from every chart and
            share; the first tile counts them.
          </li>
          <li>
            With a rating filter set, the two rankings re-rank by the share
            holding <em>that</em> rating — each row&rsquo;s denominator
            stays its full count of rated establishments.
          </li>
          <li>
            Inspection frequency varies with an establishment&rsquo;s risk
            and with each authority&rsquo;s capacity, so rating age varies
            by borough — comparisons between boroughs carry that caveat.
          </li>
          <li>
            The map shows only establishments the FSA publishes usable
            coordinates for — about six rated places in seven (roughly
            10,000 have none), and a handful of published geocodes are
            simply wrong, plotting far outside London. The tiles and
            charts count every rated establishment, mapped or not.
          </li>
        </ul>
        <p>
          Data: <a href={hfRepoUrl(FAMILY)}>{FAMILY} on Hugging Face</a> ·
          published by the{" "}
          <a href="https://ratings.food.gov.uk/open-data">
            Food Standards Agency
          </a>{" "}
          under OGL v3.0.
        </p>
      </div>
    </>
  );
}
