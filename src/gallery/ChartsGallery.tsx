import { useMemo, useState } from "react";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import LineChart, { type Point } from "../components/charts/LineChart";
import MapCanvas, { type MapTip } from "../components/map/MapCanvas";
import { tokenRgb } from "../components/map/basemapStyle";
import usePrefersDark from "../components/map/usePrefersDark";
import CategoryBars, { type CategoryBar } from "../components/charts/CategoryBars";
import RankedBars, { type RankedBar } from "../components/charts/RankedBars";
import MultiLineChart, { type Series } from "./MultiLineChart";
import SmallMultiples from "./SmallMultiples";
import { StatRow, StatTile } from "../components/charts/StatTile";
import Segmented from "../components/charts/Segmented";
import Select from "../components/charts/Select";
import { fmtCompact, fmtInt, fmtPct, fmtPct0, fmtSignedPct } from "../lib/format";

/**
 * The design-language proofing page (#/charts-template) — every chart
 * type and shared primitive on synthetic data, so the look can be
 * iterated without booting DuckDB or fetching real files. NOT a
 * dashboard: it has no registry entry and no catalogue card. The bar
 * charts were promoted to src/components/charts/ when ulev-uptake
 * became their second dashboard; the line chart is still imported from
 * its home dashboard deliberately — a preview is not the "second
 * dashboard" that triggers promotion.
 *
 * Data is deterministic by default so before/after screenshots stay
 * comparable while the design changes; "Shuffle" swaps in random data
 * to stress-test geometry. The per-chart toggles render the shared
 * Segmented primitive — the card anatomy's controls slot, proofed here
 * before dashboards grow real filters. They swap datasets — data
 * changes currently SNAP (transitions were tried and reverted; see the
 * charts skill · Transitions); the toggles stay as the test harness
 * for the next attempt. The fixed sets bake in the edge cases: a zero
 * bar, a bar shorter than its corner radius, a category name long
 * enough to fight the label margin, and multi-series lines that cross
 * and end nearly coincident (the end-label dodge).
 *
 * The cross-filtering section is the interaction draft for the coming
 * cross-filter kit (decided 2026-07-17): selected/dimmed mark states,
 * Enter-to-select keyboard parity and the unified filter bar — one
 * always-rendered control per dimension (Segmented / Select), which
 * chart clicks write into, so filter state has a single display and
 * nothing shifts when a filter lands (chips were tried and rejected
 * for exactly that shift). Wired to a synthetic city × rating dataset
 * (real city coordinates so the map facet sits on real geography; every
 * value fake) so the click-to-filter loop is real — in-memory slicing
 * stands in for the re-queries. The map participates under the approved
 * rule (2026-07-17): member marks (city bubbles) click-filter; row
 * marks (the dot cloud) only ever tooltip.
 *
 * Composition follows overview+detail (see the charts skill ·
 * Dashboard philosophy): cards are stable slots and interaction never
 * swaps one for another — a drill-swap was built 2026-07-17 and
 * rejected (the chart mutated under the click). Instead the breakdown
 * dimension (business type, as the real FHRS schema offers) has its
 * own permanent detail card, meaningful at every filter state: it
 * shows the whole scope by default and narrows to the selected area.
 * The ranking card stays as navigation, carrying a rank residue in its
 * subtitle when an area is picked. Detail cards are not themselves
 * click-filterable in v1.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface AreaRow {
  label: string;
  pct5: number;
  pct4plus: number;
  rated: number;
}

/** A multi-series dataset before colour assignment (colour is assigned
    by slot at render time so it follows the entity, never the rank). */
interface NamedValues {
  name: string;
  values: number[];
}

interface GalleryData {
  line: Point[];
  barsA: number[];
  barsB: number[];
  /** Net-change style values — negatives included, more bins than can
      all carry labels (proofs the below-baseline bars + label thinning). */
  barsNet: number[];
  areas: AreaRow[];
  multiLabels: string[];
  multi: NamedValues[];
  mapCities: MapCity[];
}

/** The cross-filter demo's area dimension, placed on the map: a real
    city with synthetic ratings (real coordinates because the basemap
    has to be real geography to proof the design; every value fake).
    Extends AreaRow so the city feeds ratingCounts/typeCounts exactly
    like the fictional areas used to. */
interface MapCity extends AreaRow {
  lon: number;
  lat: number;
}

const CITY_ANCHORS: { label: string; lon: number; lat: number }[] = [
  { label: "London", lon: -0.118, lat: 51.507 },
  { label: "Birmingham", lon: -1.898, lat: 52.489 },
  { label: "Manchester", lon: -2.244, lat: 53.483 },
  { label: "Leeds", lon: -1.548, lat: 53.801 },
  { label: "Liverpool", lon: -2.991, lat: 53.408 },
  { label: "Newcastle upon Tyne", lon: -1.617, lat: 54.978 },
  { label: "Glasgow", lon: -4.251, lat: 55.864 },
  { label: "Edinburgh", lon: -3.188, lat: 55.953 },
  { label: "Cardiff", lon: -3.179, lat: 51.481 },
  { label: "Bristol", lon: -2.587, lat: 51.454 },
  { label: "Belfast", lon: -5.93, lat: 54.597 },
  { label: "Norwich", lon: 1.297, lat: 52.63 },
];

/** The UK, [[west, south], [east, north]] — the map card's initial frame. */
const UK_BOUNDS: [[number, number], [number, number]] = [
  [-8.6, 49.9],
  [1.9, 58.8],
];

function makeMapData(rng: () => number): Pick<GalleryData, "mapCities"> {
  const mapCities = CITY_ANCHORS.map((c) => {
    const pct5 = 0.3 + rng() * 0.6;
    return {
      ...c,
      pct5,
      pct4plus: Math.min(0.99, pct5 + 0.05 + rng() * 0.15),
      rated: Math.round(400 + rng() ** 2 * 24000),
    };
  });
  return { mapCities };
}

/** The dot cloud is rows-in-scope, so it re-derives under the page
    filters (count ∝ each city's scoped total). Jitter is seeded per
    city AND filter state: deterministic for screenshots, and a filter
    change legitimately re-draws different rows. */
function makeMapDots(
  cities: MapCity[],
  scoped: Map<string, number>,
  scopeKey: string,
): { position: [number, number]; city: string }[] {
  const max = Math.max(...cities.map((c) => c.rated));
  const dots: { position: [number, number]; city: string }[] = [];
  for (const c of cities) {
    const rng = mulberry32(hashLabel(`${c.label}|${scopeKey}`));
    const n = Math.round((180 * scoped.get(c.label)!) / max);
    const spread = 0.09 + 0.28 * Math.sqrt(c.rated / max);
    // Sum of three uniforms ≈ gaussian — clustered centres, loose tails.
    const g = () => rng() + rng() + rng() - 1.5;
    for (let i = 0; i < n; i++) {
      dots.push({
        position: [c.lon + g() * spread * 1.6, c.lat + g() * spread],
        city: c.label,
      });
    }
  }
  return dots;
}

function quarterLabel(i: number): string {
  return `${2015 + Math.floor(i / 4)} Q${(i % 4) + 1}`;
}

function withShares(values: number[]): CategoryBar[] {
  const total = values.reduce((s, v) => s + v, 0);
  return values.map((value, i) => ({
    label: String(i),
    value,
    share: total > 0 ? value / total : 0,
  }));
}

const FIXED: GalleryData = {
  line: Array.from({ length: 44 }, (_, i) => ({
    label: quarterLabel(i),
    value: Math.round(4200 * Math.exp(i * 0.085) * (1 + 0.05 * Math.sin(i * 1.7))),
  })),
  // Edge cases on purpose: a zero and a bar shorter than the 4px radius.
  barsA: [0, 180, 1600, 5200, 12400, 46800],
  barsB: [1200, 3400, 9800, 18600, 14200, 4100],
  // Edge cases: negatives (incl. one shorter than the corner radius),
  // and 12 bins so the category labels must thin.
  barsNet: [4200, 5800, 3100, -1200, 6400, 7900, -300, 9200, 11800, 8600, -2400, 13400],
  areas: [
    { label: "Avonford", pct5: 0.881, pct4plus: 0.958, rated: 2140 },
    { label: "Royal Borough of Longhampton-upon-Deben", pct5: 0.874, pct4plus: 0.941, rated: 1683 },
    { label: "Casterbridge", pct5: 0.812, pct4plus: 0.93, rated: 1267 },
    { label: "Dunwich", pct5: 0.793, pct4plus: 0.882, rated: 2126 },
    { label: "Emberton", pct5: 0.781, pct4plus: 0.913, rated: 1847 },
    { label: "Fenwick Vale", pct5: 0.752, pct4plus: 0.861, rated: 2871 },
    { label: "Grimsdale", pct5: 0.731, pct4plus: 0.894, rated: 1409 },
    { label: "Hartlepool St Mary", pct5: 0.712, pct4plus: 0.845, rated: 3260 },
    { label: "Ilverton", pct5: 0.688, pct4plus: 0.837, rated: 954 },
    { label: "Jorvik Fields", pct5: 0.661, pct4plus: 0.852, rated: 2233 },
    { label: "Kelmscott", pct5: 0.634, pct4plus: 0.798, rated: 1512 },
    { label: "Lower Quenby", pct5: 0.607, pct4plus: 0.815, rated: 1878 },
    { label: "Millbrook", pct5: 0.581, pct4plus: 0.744, rated: 3049 },
    { label: "Nethermoor", pct5: 0.549, pct4plus: 0.761, rated: 1197 },
    { label: "Oxcombe", pct5: 0.509, pct4plus: 0.693, rated: 1864 },
    { label: "Pendlebury", pct5: 0.472, pct4plus: 0.671, rated: 2439 },
  ],
  multiLabels: Array.from({ length: 28 }, (_, i) => quarterLabel(i)),
  // Shapes chosen to stress the multi-series layer: two declining series
  // whose endpoints nearly coincide (the end-label dodge), one that
  // crosses everything, one strongly seasonal.
  multi: [
    {
      name: "Vehicle offences",
      values: Array.from({ length: 28 }, (_, i) =>
        Math.round(5200 - 95 * i + 260 * Math.sin(i * 1.3)),
      ),
    },
    {
      name: "Burglary",
      values: Array.from({ length: 28 }, (_, i) =>
        Math.round(4650 - 78 * i + 180 * Math.sin(i * 0.9 + 2)),
      ),
    },
    {
      name: "Shoplifting",
      values: Array.from({ length: 28 }, (_, i) =>
        Math.round(
          2600 - 40 * i + Math.max(0, i - 12) * 185 + 150 * Math.sin(i * 1.1),
        ),
      ),
    },
    {
      name: "Antisocial behaviour",
      values: Array.from({ length: 28 }, (_, i) =>
        Math.round(3300 + 8 * i + 900 * Math.sin((i * Math.PI) / 2)),
      ),
    },
  ],
  // Deterministic like the rest of the fixed set — a fixed seed keeps
  // the bubbles and dot cloud identical across reloads for screenshots.
  ...makeMapData(mulberry32(20260717)),
};

/** Fixed slot order — colour follows the entity (series i keeps slot i
    however many series are shown), never cycled or re-ranked. */
const SERIES_SLOTS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
];

const CATEGORY_POOL = [
  "Vehicle offences",
  "Burglary",
  "Shoplifting",
  "Antisocial behaviour",
  "Criminal damage",
  "Drug offences",
  "Public order",
  "Theft from the person",
];

const NAME_STARTS = ["Ash", "Bran", "Crow", "Dale", "Elm", "Fern", "Grey", "Hazel", "Iron", "Kings", "Lark", "Moss", "North", "Oak", "Pren", "Quarry", "Raven", "Stone", "Thorn", "Wren"];
const NAME_ENDS = ["bridge", "bury", "combe", "dale", "field", "ford", "ham", "hurst", "leigh", "mere", "stead", "ton", "wick", "worth"];
const NAME_SUFFIXES = ["", "", "", "", " Vale", " St Giles", "-upon-Thames", " and Netherfield"];

function makeRandom(seed: number): GalleryData {
  const rng = mulberry32(seed);

  const line: Point[] = [];
  let v = 2000 + rng() * 6000;
  const n = 24 + Math.floor(rng() * 24);
  for (let i = 0; i < n; i++) {
    line.push({ label: quarterLabel(i), value: Math.round(v) });
    v *= rng() < 0.15 ? 0.97 : 1.02 + rng() * 0.08;
  }

  const randomBars = () =>
    Array.from({ length: 6 }, () => Math.round(rng() ** 3 * 50000));
  const randomNet = () =>
    Array.from({ length: 12 }, () => Math.round((rng() - 0.25) * 16000));

  const count = 8 + Math.floor(rng() * 25);
  const used = new Set<string>();
  const areas: AreaRow[] = [];
  while (areas.length < count) {
    const name =
      NAME_STARTS[Math.floor(rng() * NAME_STARTS.length)] +
      NAME_ENDS[Math.floor(rng() * NAME_ENDS.length)] +
      NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)];
    if (used.has(name)) continue;
    used.add(name);
    const pct5 = 0.3 + rng() * 0.6;
    areas.push({
      label: name,
      pct5,
      pct4plus: Math.min(0.99, pct5 + 0.05 + rng() * 0.15),
      rated: 150 + Math.floor(rng() * 3000),
    });
  }

  const quarters = 16 + Math.floor(rng() * 24);
  const multiLabels = Array.from({ length: quarters }, (_, i) => quarterLabel(i));
  const names = [...CATEGORY_POOL];
  const multi: NamedValues[] = Array.from({ length: 4 }, () => {
    const name = names.splice(Math.floor(rng() * names.length), 1)[0];
    let v = 1500 + rng() * 4500;
    const drift = 0.94 + rng() * 0.12;
    const season = rng() * 0.25;
    const values = Array.from({ length: quarters }, (_, i) => {
      v *= drift + (rng() - 0.5) * 0.08;
      return Math.round(v * (1 + season * Math.sin((i * Math.PI) / 2)));
    });
    return { name, values };
  });

  return {
    line,
    barsA: randomBars(),
    barsB: randomBars(),
    barsNet: randomNet(),
    areas,
    multiLabels,
    multi,
    ...makeMapData(rng),
  };
}

/** Deterministic per-rating counts for each synthetic area — the joint
    area × rating dataset the cross-filter demo slices both ways. Derived
    from the area's headline shares; ratings 0–3 split the sub-4
    remainder on fixed weights (3 common, 0 rare). */
const SUB4_WEIGHTS = [0.02, 0.03, 0.1, 0.85];
const RATING_LABELS = ["0", "1", "2", "3", "4", "5"];

/** The drill dimension for a selected area — synthetic stand-in for the
    FHRS schema's business_type. */
const BUSINESS_TYPES = [
  "Restaurant or café",
  "Takeaway",
  "Pub or bar",
  "Hotel or B&B",
  "School or college",
  "Care home",
  "Supermarket",
  "Mobile caterer",
];

function hashLabel(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic business-type split of an area's per-rating counts.
    The type mix is seeded from the area's name so every area drills to
    a stable, distinct breakdown; a per-type skew makes some types rate
    better than others, so the drilled chart has an actual story. */
function typeCounts(
  area: AreaRow,
  ratings: number[],
): { type: string; counts: number[] }[] {
  const rng = mulberry32(hashLabel(area.label));
  const weights = BUSINESS_TYPES.map(() => 0.3 + rng());
  const skews = BUSINESS_TYPES.map(() => rng() * 2 - 1);
  return BUSINESS_TYPES.map((type, t) => ({
    type,
    counts: ratings.map((n, r) => {
      const wr = BUSINESS_TYPES.map(
        (_, u) => weights[u] * (1 + skews[u] * (r - 2.5) * 0.3),
      );
      return Math.round((n * wr[t]) / wr.reduce((s, v) => s + v, 0));
    }),
  }));
}
function ratingCounts(a: AreaRow): number[] {
  const r5 = a.pct5;
  const r4 = Math.max(0, a.pct4plus - a.pct5);
  const rest = Math.max(0, 1 - r5 - r4);
  const shares = [...SUB4_WEIGHTS.map((w) => w * rest), r4, r5];
  return shares.map((s) => Math.round(s * a.rated));
}

/** The share rankings' fixed 0–100% axis, ticked at quarters. */
const SHARE_TICKS = [0.25, 0.5, 0.75, 1];

const RANGE_SLICE = { all: Infinity, "5y": 20, "2y": 8 } as const;
type Range = keyof typeof RANGE_SLICE;
type Scenario = "a" | "b" | "net";
type Metric = "5" | "4plus";
type SeriesCount = "2" | "3" | "4";

export default function ChartsGallery() {
  const [seed, setSeed] = useState(0);
  const [range, setRange] = useState<Range>("all");
  const [scenario, setScenario] = useState<Scenario>("a");
  const [metric, setMetric] = useState<Metric>("5");
  const [seriesCount, setSeriesCount] = useState<SeriesCount>("4");
  // Cross-filter demo selections. Label-keyed, like the real kit's
  // filter state will be. Cleared on reseed — the values behind the
  // labels change under the new seed.
  const [selRating, setSelRating] = useState<string | null>(null);
  const [selCity, setSelCity] = useState<string | null>(null);

  const reseed = (s: number) => {
    setSeed(s);
    setSelRating(null);
    setSelCity(null);
  };

  const data = useMemo(
    () => (seed === 0 ? FIXED : makeRandom(seed)),
    [seed],
  );

  const line = data.line.slice(-RANGE_SLICE[range]);
  const bars: CategoryBar[] =
    scenario === "net"
      ? data.barsNet.map((value, i) => ({ label: quarterLabel(i), value }))
      : withShares(scenario === "a" ? data.barsA : data.barsB);
  const rows: RankedBar[] = data.areas
    .map((a) => ({
      label: a.label,
      value: metric === "5" ? a.pct5 : a.pct4plus,
      count: a.rated,
    }))
    .sort((a, b) => b.value - a.value);
  const rated = rows.reduce((s, r) => s + r.count, 0);
  const average =
    rated > 0 ? rows.reduce((s, r) => s + r.value * r.count, 0) / rated : 0;

  // ---- cross-filter demo derivations ----
  // In-memory slicing stands in for the kit's re-queries; the semantics
  // are the real ones. Each chart applies every filter EXCEPT its own
  // dimension (the crossfilter convention), the tiles apply all of them.
  // The area dimension is the 12 mapped cities, so the map can join the
  // linked facets (fictional data.areas still drives the standalone
  // ranked-bars card above, where variable row counts stress geometry).
  const countsByCity = useMemo(
    () => new Map(data.mapCities.map((a) => [a.label, ratingCounts(a)])),
    [data],
  );
  const toggleRating = (label: string) =>
    setSelRating((s) => (s === label ? null : label));
  const toggleCity = (label: string) =>
    setSelCity((s) => (s === label ? null : label));

  // Ratings facet: city filter applied, rating filter shown as selection.
  const xfCities = selCity
    ? data.mapCities.filter((a) => a.label === selCity)
    : data.mapCities;
  const xfTotals = [0, 0, 0, 0, 0, 0];
  for (const a of xfCities) {
    countsByCity.get(a.label)!.forEach((c, i) => (xfTotals[i] += c));
  }
  const xfBars = withShares(xfTotals);

  // Cities facet: the rating filter swaps the measure — share of each
  // city's establishments at the selected rating (5 until one is picked).
  const xfRating = selRating ?? "5";
  const xfRows: RankedBar[] = data.mapCities
    .map((a) => {
      const c = countsByCity.get(a.label)!;
      const total = c.reduce((s, v) => s + v, 0);
      return {
        label: a.label,
        value: total > 0 ? c[Number(xfRating)] / total : 0,
        count: total,
      };
    })
    .sort((a, b) => b.value - a.value);
  const xfTotalAll = xfRows.reduce((s, r) => s + r.count, 0);
  const xfAverage =
    xfTotalAll > 0
      ? xfRows.reduce((s, r) => s + r.value * r.count, 0) / xfTotalAll
      : 0;

  const inView = xfCities.reduce((s, a) => {
    const c = countsByCity.get(a.label)!;
    return (
      s + (selRating ? c[Number(selRating)] : c.reduce((x, v) => x + v, 0))
    );
  }, 0);

  // Business-type facet: the permanent detail card. It has no
  // selectable dimension of its own (v1), so it applies EVERY page
  // filter — showing the whole scope by default and narrowing to the
  // selected city. The overview cards never swap for it.
  const typeTotals = new Map<string, number[]>();
  for (const a of xfCities) {
    for (const { type, counts } of typeCounts(a, countsByCity.get(a.label)!)) {
      const acc = typeTotals.get(type) ?? [0, 0, 0, 0, 0, 0];
      counts.forEach((c, i) => (acc[i] += c));
      typeTotals.set(type, acc);
    }
  }
  const typeRows: RankedBar[] = [...typeTotals]
    .map(([label, c]) => {
      const total = c.reduce((s, v) => s + v, 0);
      return {
        label,
        value: total > 0 ? c[Number(xfRating)] / total : 0,
        count: total,
      };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => b.value - a.value);
  const typeScopeTotal = typeRows.reduce((s, r) => s + r.count, 0);
  const typeAverage =
    typeScopeTotal > 0
      ? typeRows.reduce((s, r) => s + r.value * r.count, 0) / typeScopeTotal
      : 0;

  // The ranking keeps a residue of the comparison when a city is
  // picked — in its subtitle, not by swapping the chart away.
  const cityRank =
    selCity !== null ? xfRows.findIndex((r) => r.label === selCity) + 1 : null;

  // Slot assignment happens once, on the full set, so slicing the count
  // never repaints a surviving series (colour follows the entity).
  const allSeries: Series[] = data.multi.map((s, i) => ({
    ...s,
    color: SERIES_SLOTS[i],
  }));
  const multiSeries = allSeries.slice(0, Number(seriesCount));

  // ---- the map facet ----
  // The map is a linked facet under the crossfilter convention: its own
  // dimension is city, so it applies the rating filter (bubbles re-size
  // to the scoped counts, against the fixed all-ratings max so the
  // change is visible) and shows the city filter as selection —
  // selected bubble full-strength, the rest receding, exactly
  // .mark-dimmed. Bubbles are dimension members, so they click-filter;
  // the dot cloud is rows, so it re-derives under every filter but is
  // never pickable (the approved rule).
  const scopedByCity = useMemo(
    () =>
      new Map(
        data.mapCities.map((c) => {
          const counts = countsByCity.get(c.label)!;
          return [
            c.label,
            selRating
              ? counts[Number(selRating)]
              : counts.reduce((s, v) => s + v, 0),
          ] as const;
        }),
      ),
    [data, countsByCity, selRating],
  );
  // deck.gl colours are RGB arrays built in JS, so unlike the SVG
  // charts (whose fills are live CSS vars) the layers must rebuild when
  // the theme flips.
  const prefersDark = usePrefersDark();
  const mapLayers = useMemo(() => {
    const c = tokenRgb("--series-1");
    const max = Math.max(...data.mapCities.map((d) => d.rated));
    const isFull = (city: string) => selCity === null || city === selCity;
    return [
      new ScatterplotLayer({
        id: "gallery-dots",
        data: makeMapDots(data.mapCities, scopedByCity, selRating ?? "all"),
        getPosition: (d: { position: [number, number] }) => d.position,
        radiusUnits: "pixels" as const,
        getRadius: 1.6,
        getFillColor: (d: { city: string }): [number, number, number, number] =>
          [...c, isFull(d.city) ? 60 : 18],
        pickable: false,
      }),
      new ScatterplotLayer<MapCity>({
        id: "gallery-cities",
        data: data.mapCities,
        getPosition: (d) => [d.lon, d.lat],
        radiusUnits: "pixels",
        getRadius: (d) => 4 + 20 * Math.sqrt(scopedByCity.get(d.label)! / max),
        getFillColor: (d): [number, number, number, number] =>
          [...c, isFull(d.label) ? 80 : 24],
        stroked: true,
        getLineColor: (d): [number, number, number, number] =>
          [...c, isFull(d.label) ? 230 : 70],
        lineWidthUnits: "pixels",
        getLineWidth: 1.5,
        pickable: true,
        // The bubbles' data array is stable across filter changes, so
        // deck needs telling when the accessors' inputs changed (it
        // deliberately ignores accessor identity).
        updateTriggers: {
          getRadius: [scopedByCity],
          getFillColor: [selCity, prefersDark],
          getLineColor: [selCity, prefersDark],
        },
      }),
    ];
  }, [data, scopedByCity, selCity, selRating, prefersDark]);
  const mapTip = (info: PickingInfo): MapTip | null => {
    const d = info.object as MapCity | undefined;
    if (!d) return null;
    return {
      value: fmtInt(scopedByCity.get(d.label) ?? 0),
      label: `${d.label} · ${selRating ? `rated ${selRating}` : "rated places"}`,
    };
  };
  const onMapClick = (info: PickingInfo) => {
    const d = info.object as MapCity | undefined;
    if (d) toggleCity(d.label);
  };

  const last = line[line.length - 1];
  const yearAgo = line.length >= 5 ? line[line.length - 5] : null;
  const yoy =
    yearAgo && yearAgo.value > 0 ? (last.value - yearAgo.value) / yearAgo.value : null;

  return (
    <>
      <h2 className="dash-title">Charts template</h2>
      <p className="dash-sub">
        Every chart type and shared primitive on <strong>synthetic
        data</strong> — nothing on this page is real. This is the proofing
        page for the design language: iterate here, then ship in a
        dashboard. Deterministic data by default so screenshots stay
        comparable; shuffle to stress-test the geometry. The per-chart
        toggles swap datasets (changes snap — transitions are a future
        design task).
      </p>

      <div className="gallery-controls">
        <button type="button" onClick={() => reseed((Math.random() * 2 ** 31) | 0 || 1)}>
          Shuffle data
        </button>
        <button type="button" onClick={() => reseed(0)} disabled={seed === 0}>
          Reset to fixed data
        </button>
      </div>

      <StatRow>
        <StatTile
          label="Stat tile with delta up"
          value={fmtCompact(last.value)}
          delta={
            yoy !== null && yearAgo ? (
              <>
                <span className={yoy >= 0 ? "dir-up" : "dir-down"}>
                  {fmtSignedPct(yoy)}
                </span>{" "}
                vs {yearAgo.label}
              </>
            ) : undefined
          }
        />
        <StatTile
          label="Stat tile with delta down"
          value={fmtPct(average)}
          delta={
            <>
              <span className="dir-down">{fmtSignedPct(-0.042)}</span> vs last
              period
            </>
          }
        />
        <StatTile label="Plain stat tile" value={last.label} delta="context line, no direction" />
      </StatRow>

      <div className="chart-card">
        <h3>Line — charts/LineChart</h3>
        <p className="chart-sub">
          2px line, round joins, 10% area wash, crosshair + tooltip on
          pointer and arrow keys, direct end label. Single series, so no
          legend. The range filter re-slices the series.
        </p>
        <Segmented
          label="Time range"
          options={[
            { value: "all", label: "All" },
            { value: "5y", label: "Last 5y" },
            { value: "2y", label: "Last 2y" },
          ]}
          value={range}
          onChange={setRange}
        />
        <LineChart
          points={line}
          formatTick={fmtCompact}
          formatValue={fmtInt}
          ariaLabel="Synthetic line chart. Use arrow keys to step through values."
        />
      </div>

      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>Multi-series line — gallery/MultiLineChart + Legend</h3>
        <p className="chart-sub">
          2px lines in the validated categorical slots, legend above
          (mandatory for ≥2 series), shared crosshair with one tooltip
          row per series, dodged value end labels. Colour follows the
          entity — the count toggle never repaints survivors. Capped at
          the four validated slots; more series means small multiples
          (below). The fixed data bakes in crossing lines and
          near-coincident endpoints to stress the label dodge. Magenta
          and yellow sit below 3:1 on the light surface, so the tooltip
          (pointer and arrow keys), which names every series with a
          swatch, is the mandated relief.
        </p>
        <Segmented
          label="Series count"
          options={[
            { value: "2", label: "2 series" },
            { value: "3", label: "3 series" },
            { value: "4", label: "4 series" },
          ]}
          value={seriesCount}
          onChange={setSeriesCount}
        />
        <MultiLineChart
          labels={data.multiLabels}
          series={multiSeries}
          formatTick={fmtCompact}
          formatValue={fmtInt}
          ariaLabel="Synthetic multi-series line chart. Use arrow keys to step through quarters; the tooltip lists every series."
        />
      </div>

      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>Small multiples — gallery/SmallMultiples</h3>
        <p className="chart-sub">
          The escape valve past four series: one panel per series in a
          single hue (the panel title carries identity, not colour), a
          shared y domain so magnitudes compare across panels, and a
          synced crosshair — hover or arrow-key any panel and every
          panel marks the same quarter. Always shows all series,
          whatever the toggle above says.
        </p>
        <SmallMultiples
          labels={data.multiLabels}
          series={allSeries}
          formatTick={fmtCompact}
          formatValue={fmtInt}
        />
      </div>

      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>Vertical bars — charts/CategoryBars</h3>
        <p className="chart-sub">
          Bars fill their band up to 64px, 4px rounded data-ends anchored
          to the baseline; per-mark tooltip; only the extreme is
          direct-labelled. Scenario A includes a zero and a bar shorter
          than its corner radius. Net change adds negatives (bars hang
          below the zero baseline) and enough bins that the category
          labels thin out.
        </p>
        <Segmented
          label="Scenario"
          options={[
            { value: "a", label: "Scenario A" },
            { value: "b", label: "Scenario B" },
            { value: "net", label: "Net change" },
          ]}
          value={scenario}
          onChange={setScenario}
        />
        <CategoryBars
          bars={bars}
          formatTick={fmtCompact}
          formatValue={fmtInt}
          tipLabel={(b) =>
            b.share !== undefined
              ? `rated ${b.label} · ${fmtPct(b.share)} of rated`
              : `net change, ${b.label}`
          }
          ariaLabel="Synthetic bar chart. Use arrow keys to step through the bars."
        />
      </div>

      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>Ranked horizontal bars — charts/RankedBars</h3>
        <p className="chart-sub">
          Share axis fixed to 0–100% here (the axis follows the measure
          when unfixed), labelled reference line at the weighted average,
          extremes direct-labelled. The metric toggle re-ranks the rows;
          the long category name stress-tests the label margin.
        </p>
        <Segmented
          label="Metric"
          options={[
            { value: "5", label: "Share rated 5" },
            { value: "4plus", label: "Share rated 4+" },
          ]}
          value={metric}
          onChange={setMetric}
        />
        <RankedBars
          rows={rows}
          domainMax={1}
          ticks={SHARE_TICKS}
          refValue={average}
          refLabel="Average"
          formatTick={fmtPct0}
          formatValue={fmtPct}
          tipValue={(row) =>
            `${fmtPct(row.value)} ${metric === "5" ? "rated 5" : "rated 4+"}`
          }
          tipLabel={(row) => `${row.label} · ${fmtInt(row.count)} rated places`}
          ariaLabel="Synthetic ranked bar chart. Use arrow keys to step through the rows."
        />
      </div>

      <h2>Cross-filtering — interaction draft</h2>
      <p className="dash-sub">
        The selection language for dashboards where every chart is also a
        filter — including the map, which is just another linked facet.
        Set a control, click a bar or a bubble — or focus a chart and
        press Enter — and the control follows: the always-present filter
        bar is the single display of what&rsquo;s filtered, so nothing
        shifts when a filter lands. Click the mark again, set the control
        back to all, or Reset to clear. The chart you clicked keeps its
        full distribution (the pick stays full-strength, the rest recede)
        while every other facet — the other charts, the map, the tiles —
        narrows to the selection. Cards are stable slots: nothing
        appears, disappears or swaps. The <em>By business type</em> card
        is the detail view — it decomposes whatever the filters currently
        scope, from all cities down to a single one.
      </p>
      <div className="filter-bar">
        <span className="filter-label">Rating</span>
        <Segmented
          label="Filter by rating"
          options={[
            { value: "all", label: "All" },
            ...RATING_LABELS.map((l) => ({ value: l, label: l })),
          ]}
          value={selRating ?? "all"}
          onChange={(v) => setSelRating(v === "all" ? null : v)}
        />
        <span className="filter-label">City</span>
        <Select
          label="Filter by city"
          options={[
            { value: "", label: "All cities" },
            ...[...data.mapCities]
              .map((a) => a.label)
              .sort()
              .map((l) => ({ value: l, label: l })),
          ]}
          value={selCity ?? ""}
          onChange={(v) => setSelCity(v === "" ? null : v)}
        />
        <button
          type="button"
          className="reset"
          disabled={selRating === null && selCity === null}
          onClick={() => {
            setSelRating(null);
            setSelCity(null);
          }}
        >
          Reset
        </button>
      </div>
      <StatRow>
        <StatTile
          label="Establishments in view"
          value={fmtInt(inView)}
          delta={
            selRating || selCity ? (
              <>{fmtPct(xfTotalAll > 0 ? inView / xfTotalAll : 0)} of all establishments</>
            ) : (
              "no filters active"
            )
          }
        />
        <StatTile
          label="Cities in view"
          value={selCity ? "1" : String(data.mapCities.length)}
          delta={selCity ?? "all cities"}
        />
      </StatRow>
      <div className="chart-card">
        <h3>Ratings — click a bar to filter the page by rating</h3>
        <p className="chart-sub">
          {selCity
            ? `Establishments by rating within ${selCity}.`
            : "Establishments by rating, all cities."}
        </p>
        <CategoryBars
          bars={xfBars}
          selected={selRating}
          onSelect={toggleRating}
          formatTick={fmtCompact}
          formatValue={fmtInt}
          tipLabel={(b) =>
            `rated ${b.label} · ${fmtPct(b.share ?? 0)} of rated`
          }
          ariaLabel="Synthetic rating distribution; selectable. Arrow keys step through the bars, Enter selects the active bar as a page filter."
        />
      </div>
      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>Cities ranked — click a row to filter the page by city</h3>
        <p className="chart-sub">
          Share of each city&rsquo;s establishments rated {xfRating}
          {selRating === null ? " (the measure until a rating is picked)" : ""}
          . The reference line is the weighted average.
          {selCity !== null && cityRank ? (
            <>
              {" "}
              <strong>{selCity}</strong> ranks {cityRank} of {xfRows.length}.
            </>
          ) : null}
        </p>
        <RankedBars
          rows={xfRows}
          domainMax={1}
          ticks={SHARE_TICKS}
          refValue={xfAverage}
          refLabel="Average"
          selected={selCity}
          onSelect={toggleCity}
          formatTick={fmtPct0}
          formatValue={fmtPct}
          tipValue={(row) => `${fmtPct(row.value)} rated ${xfRating}`}
          tipLabel={(row) => `${row.label} · ${fmtInt(row.count)} rated places`}
          ariaLabel="Synthetic ranked cities; selectable. Arrow keys step through the rows, Enter selects the active row as a page filter."
        />
      </div>
      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>Map — click a bubble to filter the page by city</h3>
        <p className="chart-sub">
          The map as a linked facet (design draft — the basemap and mark
          language are still being co-designed). Each bubble is a
          dimension member, so it filters like a bar: the pick stays
          full-strength and writes the City control, the rest recede.
          The dot cloud is rows — it re-derives under the filters but is
          never clickable (the approved rule: marks filter only when
          they represent a member of a filterable dimension). Bubbles
          re-size to the rating in view against a fixed scale, so
          filtering visibly shrinks them; changes snap, and the camera
          never moves — you own it. Keyboard access to map marks is
          still an open design item; the filter bar and ranking reach
          the same state by keyboard.
        </p>
        <MapCanvas
          bounds={UK_BOUNDS}
          layers={mapLayers}
          getTooltip={mapTip}
          onClick={onMapClick}
          ariaLabel="Synthetic map of UK cities, one bubble per city sized by establishments in view; clicking a bubble filters the page by that city. When the map is focused, arrow keys pan and plus and minus zoom; keyboard access to individual marks is not yet designed — use the city control or the ranked chart instead."
        />
      </div>
      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>By business type</h3>
        <p className="chart-sub">
          Share of each business type&rsquo;s establishments rated{" "}
          {xfRating},{" "}
          {selCity === null ? "across all cities" : `within ${selCity}`}. The
          detail card: it follows every page filter, and never replaces the
          ranking above.
        </p>
        <RankedBars
          rows={typeRows}
          domainMax={1}
          ticks={SHARE_TICKS}
          refValue={typeAverage}
          refLabel={selCity ?? "All cities"}
          formatTick={fmtPct0}
          formatValue={fmtPct}
          tipValue={(row) => `${fmtPct(row.value)} rated ${xfRating}`}
          tipLabel={(row) => `${row.label} · ${fmtInt(row.count)} rated places`}
          ariaLabel={`Synthetic breakdown by business type ${
            selCity === null ? "across all cities" : `within ${selCity}`
          }. Use arrow keys to step through the rows.`}
        />
      </div>

      <div className="caveats">
        <h4>What this page is</h4>
        <ul>
          <li>
            A proofing page for `src/components/charts/` and the exemplar
            chart types — synthetic data, no queries, no registry entry.
          </li>
          <li>
            New primitives get previewed here before any dashboard uses
            them. The multi-series line and small multiples live in
            src/gallery/ until a dashboard claims them; the Segmented
            control (the controls slot) is already shared, ahead of
            dashboards growing filters.
          </li>
          <li>
            The map card is the exception to &ldquo;no network&rdquo;:
            its marks are synthetic, but the basemap streams real vector
            tiles from OpenFreeMap (keyless — the no-secrets rule). It
            sits inside the cross-filter draft as a linked facet, under
            the approved rule (2026-07-17): a map mark filters if and
            only if it represents a member of a filterable dimension
            (the city bubbles); marks representing rows (the dot cloud)
            are details-only, never filters. Still open, to co-design:
            basemap palette sign-off, label typeface, keyboard access
            to marks, viewport-as-scope, choropleths and legends.
          </li>
          <li>
            The toggles swap datasets; changes snap for now. Transitions
            are a deliberate future design task (the charts skill records
            the lessons from the reverted first attempt).
          </li>
          <li>
            The cross-filtering section is the interaction draft for the
            coming kit: selected/dimmed mark states, Enter-to-select
            keyboard parity, and the unified filter bar (Segmented +
            Select, chart clicks writing the same state) — proofed here
            before any dashboard wires them to real queries. Chips were
            tried and rejected: a second display of filter state that
            nudged the page when it appeared.
          </li>
          <li>
            Composition is overview+detail (charts skill · Dashboard
            philosophy): cards are stable slots that never swap — a
            drill-swap was tried and rejected because the chart mutated
            under the click. The breakdown dimension gets a permanent
            detail card meaningful at every filter state; the ranking
            stays as navigation with a rank residue in its subtitle.
            Detail cards aren&rsquo;t click-filterable in v1.
          </li>
        </ul>
      </div>
    </>
  );
}
