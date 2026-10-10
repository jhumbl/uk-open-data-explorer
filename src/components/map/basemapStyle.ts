import type { StyleSpecification } from "maplibre-gl";

/**
 * The hand-designed basemap style — near-monochrome, recessive, built
 * from the `--map-*` tokens in index.css so light and dark are both
 * hand-picked in the same place as everything else. The basemap's job
 * is to be geography-shaped paper: the deck.gl data layers own the
 * chroma.
 *
 * Tiles are OpenFreeMap's hosted OpenMapTiles vectors — keyless, CORS
 * open, free for production use (the site's no-secrets rule; see
 * CLAUDE.md invariant 1). PMTiles self-hosting is the recorded fallback
 * if that ever wobbles. Glyphs also come from OpenFreeMap, which means
 * map labels are Noto Sans, not Inter — matching Inter on-map would
 * mean self-hosting glyph PBFs, an open design task.
 */

const TILE_URL = "https://tiles.openfreemap.org/planet";
const GLYPH_URL = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const FONT = ["Noto Sans Regular"];

export interface MapPalette {
  land: string;
  water: string;
  green: string;
  road: string;
  roadMajor: string;
  boundary: string;
  building: string;
  /** Label inks reuse the site's text tokens. */
  labelStrong: string;
  labelMuted: string;
}

/** Read the current theme's map palette off the live CSS tokens. Call
    again after a `prefers-color-scheme` change — the media query has
    already swapped the custom properties by the time the listener
    fires. */
export function readMapPalette(): MapPalette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    land: v("--map-land", "#f4f3ef"),
    water: v("--map-water", "#dde4e6"),
    green: v("--map-green", "#eaece3"),
    road: v("--map-road", "#e6e4dd"),
    roadMajor: v("--map-road-major", "#d8d6cc"),
    boundary: v("--map-boundary", "#b5b3a8"),
    building: v("--map-building", "#ebe9e1"),
    labelStrong: v("--text-secondary", "#52514e"),
    labelMuted: v("--text-muted", "#898781"),
  };
}

/** Read a series token as a deck.gl RGB triple (deck colours are
    arrays, not CSS strings). Re-read on theme change — the dark
    palette picks different hexes. */
export function tokenRgb(name: string): [number, number, number] {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const m = /^#([0-9a-f]{6})$/i.exec(raw);
  if (!m) return [42, 120, 214]; // --series-1 light, the safe default
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function basemapStyle(p: MapPalette): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPH_URL,
    // Theme swaps snap like every other data change on the site.
    transition: { duration: 0 },
    sources: {
      openmaptiles: {
        type: "vector",
        url: TILE_URL,
        attribution:
          '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>',
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": p.land } },
      {
        id: "landcover-green",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landcover",
        filter: [
          "in",
          ["get", "class"],
          ["literal", ["wood", "forest", "grass", "grassland", "scrub"]],
        ],
        paint: { "fill-color": p.green, "fill-opacity": 0.7 },
      },
      {
        id: "park",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "park",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": p.green, "fill-opacity": 0.7 },
      },
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        paint: { "fill-color": p.water },
      },
      {
        id: "waterway",
        type: "line",
        source: "openmaptiles",
        "source-layer": "waterway",
        minzoom: 9,
        paint: {
          "line-color": p.water,
          "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 9, 0.5, 16, 3],
        },
      },
      {
        id: "building",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 13,
        paint: { "fill-color": p.building },
      },
      {
        id: "road-minor",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 10,
        filter: [
          "all",
          ["==", ["geometry-type"], "LineString"],
          [
            "in",
            ["get", "class"],
            ["literal", ["secondary", "tertiary", "minor", "service"]],
          ],
        ],
        paint: {
          "line-color": p.road,
          "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 10, 0.4, 14, 1, 16, 2.5],
        },
      },
      {
        id: "road-major",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 6,
        filter: [
          "all",
          ["==", ["geometry-type"], "LineString"],
          ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]],
        ],
        paint: {
          "line-color": p.roadMajor,
          "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 6, 0.6, 12, 1.6, 16, 4],
        },
      },
      {
        id: "boundary-region",
        type: "line",
        source: "openmaptiles",
        "source-layer": "boundary",
        filter: [
          "all",
          ["==", ["get", "admin_level"], 4],
          ["==", ["get", "maritime"], 0],
        ],
        paint: {
          "line-color": p.boundary,
          "line-width": 0.8,
          "line-dasharray": [2, 2],
          "line-opacity": 0.7,
        },
      },
      {
        id: "boundary-country",
        type: "line",
        source: "openmaptiles",
        "source-layer": "boundary",
        filter: [
          "all",
          ["==", ["get", "admin_level"], 2],
          ["==", ["get", "maritime"], 0],
        ],
        paint: {
          "line-color": p.boundary,
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.8, 8, 1.2],
        },
      },
      {
        id: "place-village",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        minzoom: 11,
        filter: ["==", ["get", "class"], "village"],
        layout: {
          "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
          "text-font": FONT,
          "text-size": 10.5,
        },
        paint: {
          "text-color": p.labelMuted,
          "text-halo-color": p.land,
          "text-halo-width": 1,
        },
      },
      {
        id: "place-town",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        minzoom: 8,
        filter: ["==", ["get", "class"], "town"],
        layout: {
          "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
          "text-font": FONT,
          "text-size": 11,
        },
        paint: {
          "text-color": p.labelMuted,
          "text-halo-color": p.land,
          "text-halo-width": 1,
        },
      },
      {
        id: "place-city",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        filter: ["==", ["get", "class"], "city"],
        layout: {
          "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 5, 11.5, 12, 14],
        },
        paint: {
          "text-color": p.labelStrong,
          "text-halo-color": p.land,
          "text-halo-width": 1.2,
        },
      },
    ],
  };
}
