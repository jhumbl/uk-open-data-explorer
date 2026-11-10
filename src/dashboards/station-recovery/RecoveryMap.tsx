import { useMemo } from "react";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import MapCanvas, { type MapTip } from "../../components/map/MapCanvas";
import { tokenRgb } from "../../components/map/basemapStyle";
import usePrefersDark from "../../components/map/usePrefersDark";
import { fmtInt, fmtPct } from "../../lib/format";

/**
 * TfL stations on a London map, recovery against 2019. Reviewed and
 * accepted by the user 2026-11-10 (charts skill · Maps · Proportional
 * symbols).
 *
 * Builds on the accepted proportional-symbol pattern (charts skill ·
 * Maps · Proportional symbols, the national station map):
 *   - circle AREA ∝ taps a day in the latest 12 months, pixel radius,
 *     largest drawn first; circles are STATIONS (a filterable
 *     dimension), so a click writes the Station filter;
 *   - the line filter fades stations off the line and flies to the
 *     line's extent (accepted for member maps with the station map).
 * Accepted with it:
 *   - COLOUR carries recovery in two classes, below 2019 vs at or above.
 *     Blue and green are taken on this page (weekdays / weekends in the
 *     monthly chart), so this uses the other two validated categorical
 *     slots, magenta (below) and yellow (at or above). A graded
 *     diverging scale would say more but is a new palette — undesigned.
 */

export interface RecoveryPoint {
  name: string;
  lon: number;
  lat: number;
  /** Taps a day, latest 12 months. */
  al: number;
  /** Latest 12 months ÷ 2019. */
  r: number;
}

const R_MAX = 14;
const R_MIN = 2;

export const RECOVERY_MAP_HEIGHT = 560;
export const BELOW = "--series-3";
export const ABOVE = "--series-4";

function extentOf(points: RecoveryPoint[]): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of points) {
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  return e < w ? null : [[w, s], [e, n]];
}

export default function RecoveryMap({
  points,
  inScope,
  station,
  focus,
  onSelectStation,
}: {
  /** Every mapped station, largest first (draw order); stable across
      filters — scope is an alpha change, not a re-query. */
  points: RecoveryPoint[];
  /** Station names in the line scope, or null for every station. */
  inScope: Set<string> | null;
  station: string | null;
  /** Stations to frame (the line's), or null to fly home. */
  focus: RecoveryPoint[] | null;
  onSelectStation: (name: string) => void;
}) {
  const prefersDark = usePrefersDark();
  const max = points[0]?.al ?? 1;
  const home = useMemo(
    (): [[number, number], [number, number]] => extentOf(points) ?? [[-0.6, 51.3], [0.3, 51.7]],
    [points],
  );

  const layers = useMemo(() => {
    const below = tokenRgb(BELOW);
    const above = tokenRgb(ABOVE);
    const full = (d: RecoveryPoint) =>
      station ? d.name === station : inScope ? inScope.has(d.name) : true;
    return [
      new ScatterplotLayer<RecoveryPoint>({
        id: "tfl-recovery",
        data: points,
        getPosition: (d) => [d.lon, d.lat],
        radiusUnits: "pixels",
        getRadius: (d) => Math.max(R_MIN, R_MAX * Math.sqrt(d.al / max)),
        getFillColor: (d): [number, number, number, number] => [
          ...(d.r >= 1 ? above : below),
          full(d) ? 150 : 18,
        ],
        stroked: true,
        lineWidthUnits: "pixels",
        getLineWidth: (d) => (station && d.name === station ? 2.5 : 1),
        getLineColor: (d): [number, number, number, number] => [
          ...(d.r >= 1 ? above : below),
          full(d) ? 235 : 50,
        ],
        pickable: true,
        updateTriggers: {
          getFillColor: [inScope, station, prefersDark],
          getLineColor: [inScope, station, prefersDark],
          getLineWidth: [station],
        },
      }),
    ];
  }, [points, max, inScope, station, prefersDark]);

  const tip = (info: PickingInfo): MapTip | null => {
    const d = info.object as RecoveryPoint | undefined;
    if (!d) return null;
    return {
      value: `${fmtPct(d.r)} of 2019`,
      label: `${d.name} · ${fmtInt(Math.round(d.al))} taps a day`,
    };
  };

  const focusBounds = useMemo(() => (focus ? extentOf(focus) : null), [focus]);

  return (
    <MapCanvas
      bounds={home}
      layers={layers}
      height={RECOVERY_MAP_HEIGHT}
      focusBounds={focusBounds}
      getTooltip={tip}
      onClick={(info) => {
        const d = info.object as RecoveryPoint | undefined;
        if (d) onSelectStation(d.name);
      }}
      ariaLabel="Map of London with one circle per TfL station, its area proportional to taps a day in the latest 12 months and its colour showing whether the station is below, or at or above, its 2019 level. Hovering a circle shows its figures; clicking one filters the page to that station. When the map is focused, arrow keys pan and plus and minus zoom; individual circles are not keyboard-reachable — the Station control and the rankings reach the same stations."
    />
  );
}
