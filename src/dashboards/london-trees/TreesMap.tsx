import { useMemo } from "react";
import { ScatterplotLayer } from "@deck.gl/layers";
import {
  DataFilterExtension,
  type DataFilterExtensionProps,
} from "@deck.gl/extensions";
import type { PickingInfo } from "@deck.gl/core";
import MapCanvas, { type MapTip } from "../../components/map/MapCanvas";
import { tokenRgb } from "../../components/map/basemapStyle";
import usePrefersDark from "../../components/map/usePrefersDark";
import type { LegendItem } from "../../components/charts/Legend";

/**
 * The stage of the map-first trees dashboard: one dot per tree,
 * coloured by the active mode (2090 climate suitability, or kind).
 *
 * Performance contract (2026-07-17, after the CPU path proved too slow
 * at this scale): all 1.14M points upload to the GPU ONCE as binary
 * attributes, and every subsequent interaction is uniform-cheap —
 * filters are a 0/1 membership mask fed to deck's DataFilterExtension
 * (the GPU discards non-members at draw time; nothing re-queries, and
 * filtered-out dots stop being pickable), colour mode and theme swap a
 * colour attribute. The dashboard builds the mask, the fly-to extent
 * and every chart aggregate in one JS pass over the resident arrays
 * (computePage) — after load, nothing on the page touches DuckDB. A
 * single mask channel is used instead of the extension's category
 * channels deliberately: categories cap at 4 channels (we have 5
 * dimensions) and a mask extends to any future filter semantics.
 *
 * Dots are ROW-LEVEL marks (approved map rule, charts skill · Maps):
 * details-on-demand only — tooltip, never click-filterable.
 */

/** Columnar points, loaded once: positions interleaved for deck, the
    categorical columns as dictionary codes decoded through `TreeDicts`. */
export interface TreePoints {
  n: number;
  /** [lon0, lat0, lon1, lat1, …] */
  pos: Float32Array;
  genus: Int16Array;
  clim: Int16Array;
  loc: Int16Array;
  name: Int16Array;
  species: Int16Array;
  age: Int16Array;
  height: Int16Array;
  borough: Int16Array;
}

/** code → string, one array per encoded column. */
export interface TreeDicts {
  genus: string[];
  clim: string[];
  loc: string[];
  name: string[];
  species: string[];
  age: string[];
  height: string[];
  borough: string[];
}

export type ColourMode = "clim" | "genus";

/** Climate classes → tokens. Draw order is a fixed random shuffle (see
    the dashboard's LOAD_TREES note — any systematic order inverts the
    picture at this density), so alphas alone carry salience: the
    dominant Low class (60% of trees) stays the quiet base of the
    mixture, the rare High (0.4%) and the Vulnerable classes get enough
    weight to survive it. */
const CLIM_STYLE: Record<string, { token: string; alpha: number }> = {
  High: { token: "--clim-high", alpha: 235 },
  Moderate: { token: "--clim-moderate", alpha: 95 },
  Low: { token: "--clim-low", alpha: 130 },
  Vulnerable: { token: "--clim-vulnerable", alpha: 160 },
  "Not provided": { token: "--clim-none", alpha: 60 },
};

/** The eight most numerous kinds get the categorical map slots (55% of
    all trees); everything else shares the muted rest colour. Assignment
    is by name, not rank, so the colours are stable if the data shifts. */
const GENUS_TOKEN: Record<string, string> = {
  Cherry: "--map-cat-1",
  Maple: "--map-cat-2",
  Lime: "--map-cat-3",
  Oak: "--map-cat-4",
  Plane: "--map-cat-5",
  Ash: "--map-cat-6",
  Birch: "--map-cat-7",
  Sycamore: "--map-cat-8",
};
const GENUS_ALPHA = 130;
const OTHER_ALPHA = 85;

export const CLIM_LEGEND: LegendItem[] = [
  { label: "High suitability", color: "var(--clim-high)" },
  { label: "Moderate", color: "var(--clim-moderate)" },
  { label: "Low", color: "var(--clim-low)" },
  { label: "Vulnerable", color: "var(--clim-vulnerable)" },
  { label: "Not assessed", color: "var(--clim-none)" },
];

export const GENUS_LEGEND: LegendItem[] = [
  ...Object.keys(GENUS_TOKEN).map((g) => ({
    label: g,
    color: `var(${GENUS_TOKEN[g]})`,
  })),
  { label: "All other kinds", color: "var(--map-cat-0)" },
];

/** Greater London — initial frame and the fly-home target on reset. */
const LONDON_BOUNDS: [[number, number], [number, number]] = [
  [-0.52, 51.27],
  [0.31, 51.71],
];

// One extension instance for the layer's lifetime.
const FILTER_EXT = [new DataFilterExtension({ filterSize: 1 })];

export default function TreesMap({
  points,
  dicts,
  mode,
  mask,
  focusBounds,
}: {
  points: TreePoints | null;
  dicts: TreeDicts | null;
  mode: ColourMode;
  /** 0/1 membership per point (buildFilterMask); null until loaded. */
  mask: Float32Array | null;
  /** Extent of the points in scope while any filter is active, null at
      defaults (fly home) — see MapCanvas. */
  focusBounds: [[number, number], [number, number]] | null;
}) {
  const prefersDark = usePrefersDark();

  // Per-dot RGBA from the dictionary codes: a tiny code→colour table
  // per mode/theme, then one pass over the column. Rebuilt only when
  // the mode or theme change — never on filter changes.
  const colors = useMemo(() => {
    if (!points || !dicts) return null;
    const names = mode === "clim" ? dicts.clim : dicts.genus;
    const table = new Uint8Array(names.length * 4);
    for (let c = 0; c < names.length; c++) {
      const spec =
        mode === "clim"
          ? (CLIM_STYLE[names[c]] ?? { token: "--clim-none", alpha: 80 })
          : GENUS_TOKEN[names[c]]
            ? { token: GENUS_TOKEN[names[c]], alpha: GENUS_ALPHA }
            : { token: "--map-cat-0", alpha: OTHER_ALPHA };
      const [r, g, b] = tokenRgb(spec.token);
      table[c * 4] = r;
      table[c * 4 + 1] = g;
      table[c * 4 + 2] = b;
      table[c * 4 + 3] = spec.alpha;
    }
    const codes = mode === "clim" ? points.clim : points.genus;
    const out = new Uint8Array(points.n * 4);
    for (let i = 0; i < points.n; i++) {
      const c = codes[i] * 4;
      out[i * 4] = table[c];
      out[i * 4 + 1] = table[c + 1];
      out[i * 4 + 2] = table[c + 2];
      out[i * 4 + 3] = table[c + 3];
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, dicts, mode, prefersDark]);

  const layers = useMemo(() => {
    if (!points || !colors || !mask) return [];
    return [
      new ScatterplotLayer<unknown, DataFilterExtensionProps>({
        id: "trees",
        data: {
          length: points.n,
          // Unchanged attribute references (positions; colors between
          // filter clicks) are not re-uploaded — a filter change ships
          // only the 1-float mask channel.
          attributes: {
            getPosition: { value: points.pos, size: 2 },
            getFillColor: { value: colors, size: 4 },
            getFilterValue: { value: mask, size: 1 },
          },
        },
        // A tree-sized dot: sub-pixel at London-wide zoom so a million
        // points read as a density texture (alpha does the work), a
        // canopy at street zoom.
        radiusUnits: "meters",
        getRadius: 3.5,
        radiusMinPixels: 0.8,
        radiusMaxPixels: 9,
        stroked: false,
        pickable: true,
        extensions: FILTER_EXT,
        filterRange: [0.5, 1.5],
      }),
    ];
  }, [points, colors, mask]);

  const tip = (info: PickingInfo): MapTip | null => {
    if (!points || !dicts || info.index == null || info.index < 0) return null;
    const i = info.index;
    const name = dicts.name[points.name[i]];
    const species = dicts.species[points.species[i]];
    const height = dicts.height[points.height[i]];
    const age = dicts.age[points.age[i]];
    const clim = dicts.clim[points.clim[i]];
    const parts = [
      species !== "NA" && species !== name ? species : null,
      height !== "Not recorded" ? height : null,
      age !== "Not provided" && age !== "Undefined" ? age : null,
      clim !== "Not provided" ? `2090: ${clim.toLowerCase()}` : "2090: not assessed",
      dicts.borough[points.borough[i]],
    ];
    return { value: name, label: parts.filter(Boolean).join(" · ") };
  };

  return (
    <MapCanvas
      bounds={LONDON_BOUNDS}
      layers={layers}
      height="100%"
      gestures="direct"
      focusBounds={focusBounds}
      getTooltip={tip}
      ariaLabel="Map of London with one dot per public-realm tree in the current filter scope, coloured by the chosen mode: 2090 climate suitability, or kind. Hovering a dot shows that tree's name, species, size, age, 2090 assessment and borough. When the map is focused, arrow keys pan and plus and minus zoom; individual dots are not keyboard-reachable — the filters and the panel charts reach the same data."
    />
  );
}
