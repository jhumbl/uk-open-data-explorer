import { useMemo } from "react";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import MapCanvas, { type MapTip } from "../../components/map/MapCanvas";
import { tokenRgb } from "../../components/map/basemapStyle";
import usePrefersDark from "../../components/map/usePrefersDark";
import { fmtInt } from "../../lib/format";

/**
 * Proportional-symbol map of station usage. Reviewed and accepted
 * "for now" by the user 2026-11-10 (charts skill · Maps · Proportional
 * symbols) — refinements below are open, not settled.
 *
 * Each circle is one STATION — a member of the page's filterable station
 * dimension — so under the approved map rule (charts skill · Maps) the
 * circles click-filter: a click writes the same state as the Station
 * control. Selection language follows the gallery's member-bubble map:
 * in-scope circles full-strength, the rest receding (alpha).
 *
 * Decisions (accepted as-is; revisit in a refinement pass):
 *   - circle AREA ∝ entries+exits (radius ∝ √value), pixel units so a
 *     circle keeps its size across zoom (standard for proportional
 *     symbols), max radius 16px for the busiest station;
 *   - one hue (--series-1): size carries the value, so no new colour;
 *   - draw order largest-first, so small stations sit on top and stay
 *     hoverable inside London's heap;
 *   - camera flies to the region's extent when a region (or a station,
 *     which pins its region) is filtered, and home on reset (first member map to fly).
 */

export interface StationPoint {
  name: string;
  region: string | null;
  crs: string;
  lon: number;
  lat: number;
  ee: number;
}

/** Great Britain, [[west, south], [east, north]]. */
const GB_BOUNDS: [[number, number], [number, number]] = [
  [-7.6, 49.9],
  [1.9, 58.7],
];

const R_MAX = 16;
const R_MIN = 1.5;

export const STATION_MAP_HEIGHT = 560;

function extentOf(points: StationPoint[]): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of points) {
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  return e < w ? null : [[w, s], [e, n]];
}

export default function StationMap({
  points,
  region,
  station,
  onSelectStation,
}: {
  /** Every mapped station, largest first (draw order). Stable across
      filter changes — selection is an alpha change, not a re-query. */
  points: StationPoint[];
  region: string | null;
  station: string | null;
  onSelectStation: (name: string) => void;
}) {
  const prefersDark = usePrefersDark();
  const max = points[0]?.ee ?? 1;

  const layers = useMemo(() => {
    const c = tokenRgb("--series-1");
    const full = (d: StationPoint) =>
      station ? d.name === station : region ? d.region === region : true;
    return [
      new ScatterplotLayer<StationPoint>({
        id: "orr-stations",
        data: points,
        getPosition: (d) => [d.lon, d.lat],
        radiusUnits: "pixels",
        getRadius: (d) => Math.max(R_MIN, R_MAX * Math.sqrt(d.ee / max)),
        getFillColor: (d): [number, number, number, number] => [...c, full(d) ? 70 : 14],
        stroked: true,
        lineWidthUnits: "pixels",
        getLineWidth: (d) => (station && d.name === station ? 2.5 : 1),
        getLineColor: (d): [number, number, number, number] => [...c, full(d) ? 220 : 50],
        pickable: true,
        updateTriggers: {
          getFillColor: [region, station, prefersDark],
          getLineColor: [region, station, prefersDark],
          getLineWidth: [station],
        },
      }),
    ];
  }, [points, max, region, station, prefersDark]);

  const tip = (info: PickingInfo): MapTip | null => {
    const d = info.object as StationPoint | undefined;
    if (!d) return null;
    return {
      value: `${fmtInt(d.ee)} entries and exits`,
      label: [d.name, d.region, d.crs].filter(Boolean).join(" · "),
    };
  };

  const focusBounds = useMemo(
    () => (region ? extentOf(points.filter((p) => p.region === region)) : null),
    [points, region],
  );

  return (
    <MapCanvas
      bounds={GB_BOUNDS}
      layers={layers}
      height={STATION_MAP_HEIGHT}
      focusBounds={focusBounds}
      getTooltip={tip}
      onClick={(info) => {
        const d = info.object as StationPoint | undefined;
        if (d) onSelectStation(d.name);
      }}
      ariaLabel="Map of Great Britain with one circle per railway station, its area proportional to the station's entries and exits in the latest year. Hovering a circle shows the station's name, region and figure; clicking one filters the page to that station. When the map is focused, arrow keys pan and plus and minus zoom; individual circles are not keyboard-reachable — the Station control and the rankings reach the same stations."
    />
  );
}
