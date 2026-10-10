import { useEffect, useRef, useState } from "react";
import maplibregl, { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { LayersList, PickingInfo } from "@deck.gl/core";
import ChartTooltip from "../charts/ChartTooltip";
import { basemapStyle, readMapPalette } from "./basemapStyle";

/**
 * The one shared map surface (CLAUDE.md · Charting: MapLibre GL basemap
 * + deck.gl overlay, decided; one <MapCanvas> from day one). A map here
 * is a chart: it lives in a chart-card, wears the site's tokens (the
 * basemap style is built from them at runtime and swaps with the
 * theme), and surfaces values through the same ChartTooltip chrome.
 *
 * Data marks are deck.gl layers passed in by the caller — MapCanvas
 * owns the basemap, the theme listener, the overlay plumbing and the
 * tooltip; dashboards own their layers and what a pick means.
 *
 * Interaction choices (draft, proofed in the gallery):
 * - cooperative gestures — scrolling the page over the map never
 *   hijacks into zoom (Ctrl+scroll / two-finger to zoom);
 * - rotation and pitch disabled — these maps are flat figures, not
 *   globes to fly around;
 * - zoom control top-right, compact attribution bottom-right (OSM
 *   credit is a licence requirement, kept quiet but present).
 *
 * Keyboard: MapLibre's canvas is focusable — arrows pan, +/- zoom.
 * Arrow-key parity for *data marks* (the charts' hover contract) has no
 * map design yet; it's an open design task recorded in the charts
 * skill, to be settled with the first real map dashboard.
 */

export interface MapTip {
  value: string;
  label: string;
}

export default function MapCanvas({
  bounds,
  layers,
  height = 460,
  ariaLabel,
  focusBounds,
  getTooltip,
  onClick,
  gestures = "cooperative",
}: {
  /** Initial framing, [[west, south], [east, north]]. Initial only —
      after mount the visitor owns the camera, with one exception:
      `focusBounds` below. */
  bounds: [[number, number], [number, number]];
  layers: LayersList;
  /** Card maps pass a pixel height; the map-first page's stage passes
      "100%" and sizes the canvas itself. */
  height?: number | string;
  ariaLabel: string;
  /** "cooperative" (default): Ctrl+scroll to zoom, so a scrolling page
      is never hijacked — the rule for maps inside cards. "direct":
      plain scroll zooms; only for the map-first page, where there is no
      page scroll to protect — but ONLY on fine-pointer devices: on
      touch (coarse pointer) even the map-first page stacks the map
      above a scrollable panel, so one-finger pans would trap page
      scrolling — touch always gets cooperative gestures (two-finger
      pan/zoom; user decision 2026-07-19). Initial-only, like the other
      map options. */
  gestures?: "cooperative" | "direct";
  /** Fly-to-scope (user, 2026-07-17): when this changes to a box, the
      camera flies to frame it — the caller passes the extent of the
      data now in scope after a filter change; when it changes back to
      null (filters reset) the camera flies home to `bounds`. Flying is
      navigation, not a data transition, so it animates (and snaps
      under prefers-reduced-motion). Omit for a static camera. */
  focusBounds?: [[number, number], [number, number]] | null;
  /** Map a deck.gl pick to tooltip content; null hides it. Omit for
      non-pickable layers. */
  getTooltip?: (info: PickingInfo) => MapTip | null;
  /** Fires only for picks on pickable marks. Per the approved rule
      (charts skill · Maps), wire this only when the picked mark is a
      member of a filterable dimension — clicks then write the same
      state as the mark's filter-bar control. Row-level marks never get
      a click handler. */
  onClick?: (info: PickingInfo) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [tip, setTip] = useState<(MapTip & { x: number; y: number }) | null>(
    null,
  );
  // WebGL is a hard requirement of both maplibre and deck. When the
  // browser refuses a context (acceleration off, blocklisted driver),
  // the map degrades to a notice in its own frame — it must never
  // throw past the card and take the rest of the page with it
  // (invariant 5's spirit, applied within a page).
  const [webglFailed, setWebglFailed] = useState(false);
  // The overlay is constructed once; reach the latest callbacks from it.
  const getTooltipRef = useRef(getTooltip);
  getTooltipRef.current = getTooltip;
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  useEffect(() => {
    // Probe before constructing: maplibre throws mid-constructor on
    // context failure, and deck (luma.gl v9) needs WebGL2 specifically.
    const probe = document.createElement("canvas").getContext("webgl2");
    if (!probe) {
      setWebglFailed(true);
      return;
    }

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: targetRef.current!,
        style: basemapStyle(readMapPalette()),
        bounds,
        fitBoundsOptions: { padding: 24 },
        attributionControl: { compact: true },
        cooperativeGestures:
          gestures === "cooperative" ||
          window.matchMedia("(pointer: coarse)").matches,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
    } catch {
      setWebglFailed(true);
      return;
    }
    map.keyboard.disableRotation();
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    // Fullscreen toggle, always present, just below the zoom buttons
    // (user, 2026-07-17). It must fullscreen the .map-canvas WRAPPER,
    // not maplibre's own container — the tooltip is a sibling of the
    // map target and would be left behind. Maplibre resizes the map
    // and suspends cooperative gestures while fullscreen.
    map.addControl(
      new maplibregl.FullscreenControl({ container: wrapRef.current! }),
      "top-right",
    );

    const overlay = new MapboxOverlay({
      layers: [],
      // Small point marks (2px dots) need a forgiving hover target;
      // this pads every pick, like the charts' whole-plot hit area.
      pickingRadius: 4,
      onHover: (info: PickingInfo) => {
        const content = info.picked
          ? (getTooltipRef.current?.(info) ?? null)
          : null;
        setTip(content ? { ...content, x: info.x, y: info.y } : null);
      },
      onClick: (info: PickingInfo) => {
        if (info.picked) onClickRef.current?.(info);
      },
      getCursor: ({ isHovering }) => (isHovering ? "pointer" : ""),
    });
    map.addControl(overlay);
    mapRef.current = map;
    overlayRef.current = overlay;

    // The basemap is built from the CSS tokens, so a theme flip means a
    // style swap (the custom properties have already changed by the
    // time this fires). Snaps, like every data change on the site.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => map.setStyle(basemapStyle(readMapPalette()));
    mq.addEventListener("change", onTheme);

    return () => {
      mq.removeEventListener("change", onTheme);
      map.remove(); // removes the overlay control with it
      mapRef.current = null;
      overlayRef.current = null;
    };
    // Initial framing only — reframing under the visitor would fight
    // the camera they now own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    overlayRef.current?.setProps({ layers });
  }, [layers]);

  // Fly-to-scope. Keyed on the box's values, not its identity — the
  // caller recomputes the extent every query, and re-flying to an
  // unchanged box would yank a camera the visitor has since moved.
  const focusKey = focusBounds ? focusBounds.flat().join(",") : "";
  const focusInit = useRef(true);
  useEffect(() => {
    if (focusInit.current) {
      // Mount is already framed by `bounds`; never animate first paint.
      focusInit.current = false;
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    map.fitBounds(focusBounds ?? bounds, {
      padding: 40,
      // A single street's worth of points must not zoom past legibility.
      maxZoom: 14,
      duration: reduced ? 0 : 900,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // Clamp the tooltip inside the canvas, chart-style. Row-detail tips
  // (an establishment's name and address) run long — the CSS caps the
  // width at 260px and lets them wrap, so clamp against that measure.
  const wrapW = wrapRef.current?.clientWidth ?? 0;
  const tipStyle = tip
    ? {
        left: Math.max(8, Math.min(tip.x + 14, wrapW - 268)),
        top: Math.max(8, tip.y - 34),
      }
    : undefined;

  if (webglFailed) {
    // Same frame, same height — the card keeps its geometry, the rest
    // of the page keeps working.
    return (
      <div className="map-canvas" style={{ height }}>
        <div className="map-fallback">
          <p>
            This map needs WebGL, which your browser refused to start —
            usually hardware acceleration turned off, or a blocklisted
            graphics driver. Everything else on this page works without
            it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="map-canvas"
      style={{ height }}
      aria-label={ariaLabel}
    >
      <div ref={targetRef} className="map-target" />
      {tip && tipStyle && (
        <ChartTooltip value={tip.value} label={tip.label} style={tipStyle} />
      )}
    </div>
  );
}
