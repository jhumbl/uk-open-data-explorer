import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * The shared chart frame — the pieces every chart is built from, encoding
 * the design language (see CLAUDE.md · Dataviz conventions) so individual
 * charts can't drift on gridline weight, tick typography or a11y wiring.
 *
 * Whole chart types (LineChart, BarChart, …) stay dashboard-local and
 * compose these; they get promoted here only when a second dashboard
 * needs the same one.
 */

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Observe the wrapper's width so charts fill their card responsively.
 *
 * The first measurement happens in a layout effect — synchronously,
 * before the browser paints — so the chart's first visible frame is
 * already at the container's true width. (Relying on the observer's
 * initial report paints one frame at `initial` first, and the chart
 * visibly snaps when the real width lands.) The wrapper div has no
 * padding or border, so getBoundingClientRect and the observer's
 * contentRect agree.
 */
export function useContainerWidth(initial = 720) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}

/** Plot-area dimensions inside the margins. */
export function innerSize(width: number, height: number, margin: Margin) {
  return {
    iw: Math.max(width - margin.left - margin.right, 10),
    ih: Math.max(height - margin.top - margin.bottom, 10),
  };
}

interface FrameProps {
  wrapRef: RefObject<HTMLDivElement | null>;
  width: number;
  height: number;
  margin: Margin;
  ariaLabel: string;
  onKeyDown?: (e: KeyboardEvent<SVGSVGElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Marks, rendered inside the margin-translated group. */
  children: ReactNode;
  /** Positioned siblings of the svg (tooltips) — see ChartTooltip. */
  overlay?: ReactNode;
}

/**
 * Wrapper div (tooltip positioning context) + focusable svg + margin
 * group. Every chart is keyboard-reachable through this frame.
 */
export default function ChartFrame({
  wrapRef,
  width,
  height,
  margin,
  ariaLabel,
  onKeyDown,
  onFocus,
  onBlur,
  children,
  overlay,
}: FrameProps) {
  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        style={{ display: "block", maxWidth: "100%" }}
      >
        <g transform={`translate(${margin.left},${margin.top})`}>{children}</g>
      </svg>
      {overlay}
    </div>
  );
}

/** Hairline, solid, recessive gridlines at the given pixel positions. */
export function GridLines({
  positions,
  length,
  orient = "h",
}: {
  positions: number[];
  /** How far each line spans (inner width for "h", inner height for "v"). */
  length: number;
  /** "h": horizontal lines (value axis is y). "v": vertical lines. */
  orient?: "h" | "v";
}) {
  return (
    <>
      {positions.map((p) =>
        orient === "h" ? (
          <line key={p} x1={0} x2={length} y1={p} y2={p} stroke="var(--gridline)" strokeWidth={1} />
        ) : (
          <line key={p} x1={p} x2={p} y1={0} y2={length} stroke="var(--gridline)" strokeWidth={1} />
        ),
      )}
    </>
  );
}

/** The zero line — one notch darker than gridlines. */
export function Baseline({
  at,
  length,
  orient = "h",
}: {
  /** Pixel position of the line (usually ih for "h", 0 for "v"). */
  at: number;
  length: number;
  orient?: "h" | "v";
}) {
  return orient === "h" ? (
    <line x1={0} x2={length} y1={at} y2={at} stroke="var(--baseline)" strokeWidth={1} />
  ) : (
    <line x1={at} x2={at} y1={0} y2={length} stroke="var(--baseline)" strokeWidth={1} />
  );
}
