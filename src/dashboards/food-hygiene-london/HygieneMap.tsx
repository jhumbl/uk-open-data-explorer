import { useMemo } from "react";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import MapCanvas, { type MapTip } from "../../components/map/MapCanvas";
import { tokenRgb } from "../../components/map/basemapStyle";
import usePrefersDark from "../../components/map/usePrefersDark";
import type { LegendItem } from "../../components/charts/Legend";

/**
 * The dashboard's point map: one dot per geocoded establishment in the
 * current filter scope, coloured by rating class.
 *
 * Dots are ROW-LEVEL marks, so under the approved map rule (charts
 * skill · Maps) they are details-on-demand only: the cloud re-derives
 * under every active filter, each dot carries a tooltip, and no dot is
 * click-filterable — "one establishment" is not a state the filter bar
 * could display. The filter bar and the linked charts are the keyboard
 * path to the same data.
 */

/** One geocoded establishment in scope. `type` arrives pre-shortened
    by the dashboard's label map; `inspected` is preformatted in SQL. */
export interface MapPoint {
  name: string;
  addr: string;
  type: string;
  rating: string;
  inspected: string;
  lon: number;
  lat: number;
}

/** The three rating classes, in DRAW order — the dominant rated-5 wash
    first (underneath), problems last (on top). Colours are the
    pre-validated series slots; nothing new to validate. */
const BANDS = [
  { label: "Rated 5", token: "--series-2" },
  { label: "Rated 3–4", token: "--series-4" },
  { label: "Rated 0–2", token: "--series-3" },
] as const;

/** For the card's Legend — same tokens the dots wear. */
export const BAND_LEGEND: LegendItem[] = BANDS.map((b) => ({
  label: b.label,
  color: `var(${b.token})`,
}));

/** Per-band fill alpha: salience follows severity. 40k rated-5 dots
    are the map's background texture; 3.7k rated-0–2 dots are its
    subject and stay near-opaque. */
const ALPHA = [140, 175, 215] as const;

function bandOf(rating: string): 0 | 1 | 2 {
  if (rating === "5") return 0;
  if (rating === "4" || rating === "3") return 1;
  return 2;
}

/** Greater London, [[west, south], [east, north]] — the initial frame,
    and where the camera flies home to on filter reset. */
const LONDON_BOUNDS: [[number, number], [number, number]] = [
  [-0.53, 51.26],
  [0.35, 51.72],
];

/** Plausibility box for the fly-to extent: a handful of published FSA
    geocodes are simply wrong (they plot as far as Scotland), and one
    bad point must not drag the camera out of London. Slightly looser
    than LONDON_BOUNDS so genuine edge-of-authority sites still count. */
const CLIP: [[number, number], [number, number]] = [
  [-0.6, 51.2],
  [0.4, 51.8],
];

/** The extent of the points in scope, for fly-to-scope; null when
    nothing plausible remains (the camera then stays put). */
function extentOf(
  points: MapPoint[],
): [[number, number], [number, number]] | null {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  for (const p of points) {
    if (p.lon < CLIP[0][0] || p.lon > CLIP[1][0]) continue;
    if (p.lat < CLIP[0][1] || p.lat > CLIP[1][1]) continue;
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  return e < w ? null : [[w, s], [e, n]];
}

export const MAP_HEIGHT = 460;

export default function HygieneMap({
  points,
  scoped,
}: {
  points: MapPoint[];
  /** True when any page filter is active — the camera then flies to
      the extent of the points in scope, and home again on reset. */
  scoped: boolean;
}) {
  // deck colours are RGB arrays, not live CSS vars — rebuild the layer
  // when the theme flips so the dots pick up the dark-palette hexes.
  const prefersDark = usePrefersDark();

  const layers = useMemo(() => {
    const rgb = BANDS.map((b) => tokenRgb(b.token));
    return [
      new ScatterplotLayer<MapPoint>({
        id: "fhrs-points",
        data: points,
        getPosition: (d) => [d.lon, d.lat],
        // Metres, clamped: at London-wide zoom every dot collapses to a
        // ~1.3px grain so 60k points read as a density texture and the
        // on-top 0–2 class can't overplot the centre into a false
        // majority; zoomed to street level a dot grows to shop scale.
        radiusUnits: "meters",
        getRadius: 28,
        radiusMinPixels: 1,
        radiusMaxPixels: 7,
        getFillColor: (d) => {
          const b = bandOf(d.rating);
          return [rgb[b][0], rgb[b][1], rgb[b][2], ALPHA[b]];
        },
        // Pickable for the tooltip only — no onClick, per the rule above.
        pickable: true,
      }),
    ];
    // `points` is a fresh array per query, so accessors re-evaluate
    // without updateTriggers; prefersDark re-reads the tokens.
  }, [points, prefersDark]);

  const tip = (info: PickingInfo): MapTip | null => {
    const d = info.object as MapPoint | undefined;
    if (!d) return null;
    return {
      value: d.name || "(unnamed establishment)",
      label: [
        `rated ${d.rating}`,
        d.type,
        d.addr,
        d.inspected && `inspected ${d.inspected}`,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  };

  const focusBounds = useMemo(
    () => (scoped ? extentOf(points) : null),
    [points, scoped],
  );

  return (
    <MapCanvas
      bounds={LONDON_BOUNDS}
      layers={layers}
      height={MAP_HEIGHT}
      focusBounds={focusBounds}
      getTooltip={tip}
      ariaLabel="Map of London with one dot per geocoded establishment in the current filter scope, coloured by rating class: 5, 3 to 4, and 0 to 2. Hovering a dot shows that establishment's name, rating, business type, address and inspection date. When the map is focused, arrow keys pan and plus and minus zoom; individual dots are not keyboard-reachable — the filters and the other charts reach the same data."
    />
  );
}
