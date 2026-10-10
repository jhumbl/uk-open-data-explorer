import { useMemo } from "react";
import * as d3 from "d3";
import ChartFrame, {
  Baseline,
  GridLines,
  innerSize,
  useContainerWidth,
  type Margin,
} from "./ChartFrame";
import ChartTooltip from "./ChartTooltip";
import { useActiveIndex } from "./useActiveIndex";

export interface Point {
  label: string;
  value: number;
}

interface Props {
  points: Point[];
  /** Compact formatter for axis ticks and the end label (e.g. "2.5M"). */
  formatTick: (v: number) => string;
  /** Full-precision formatter for the tooltip (e.g. "2,516,321"). */
  formatValue: (v: number) => string;
  ariaLabel: string;
  /** Chart height; dense layouts pass less. */
  height?: number;
}

const DEFAULT_HEIGHT = 280;
const MARGIN: Margin = { top: 18, right: 64, bottom: 32, left: 48 };

/**
 * Single-series line chart: 2px line, 10%-opacity area wash, crosshair +
 * tooltip (pointer and keyboard), direct end label. One series, so no
 * legend — the card title names it. Promoted from ulev-uptake when
 * vehicle-fleet became its second consumer (CLAUDE.md · Charting).
 *
 * Data changes snap — transitions were tried and reverted (see the
 * charts skill · Transitions); don't reintroduce them ad hoc.
 */
export default function LineChart({
  points,
  formatTick,
  formatValue,
  ariaLabel,
  height = DEFAULT_HEIGHT,
}: Props) {
  const { ref, width } = useContainerWidth();
  const { iw, ih } = innerSize(width, height, MARGIN);
  const { active, setActive, onKeyDown, clear } = useActiveIndex(points.length);

  const { x, y, linePath, areaPath, yTicks, xTickIdx } = useMemo(() => {
    const x = d3.scalePoint(
      points.map((p) => p.label),
      [0, iw],
    );
    const y = d3
      .scaleLinear([0, d3.max(points, (p) => p.value) ?? 1], [ih, 0])
      .nice();
    const linePath =
      d3
        .line<Point>()
        .x((p) => x(p.label)!)
        .y((p) => y(p.value))(points) ?? "";
    const areaPath =
      d3
        .area<Point>()
        .x((p) => x(p.label)!)
        .y0(ih)
        .y1((p) => y(p.value))(points) ?? "";
    const yTicks = y.ticks(4).filter((t) => t > 0);
    const tickStep = Math.max(1, Math.ceil(points.length / 6));
    const xTickIdx = points
      .map((_, i) => i)
      .filter((i) => i % tickStep === 0);
    return { x, y, linePath, areaPath, yTicks, xTickIdx };
  }, [points, iw, ih]);

  if (points.length === 0) return null;

  const last = points[points.length - 1];

  const indexFromPointer = (e: React.PointerEvent<SVGRectElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const step = points.length > 1 ? iw / (points.length - 1) : iw;
    return Math.max(0, Math.min(points.length - 1, Math.round(px / step)));
  };

  const activePoint = active !== null ? points[active] : null;
  const activeX = activePoint ? (x(activePoint.label) ?? 0) : 0;

  return (
    <ChartFrame
      wrapRef={ref}
      width={width}
      height={height}
      margin={MARGIN}
      ariaLabel={ariaLabel}
      onKeyDown={onKeyDown}
      onBlur={clear}
      overlay={
        activePoint && (
          <ChartTooltip
            value={formatValue(activePoint.value)}
            label={activePoint.label}
            style={{
              left: Math.max(70, Math.min(width - 70, MARGIN.left + activeX)),
              top: 0,
              transform: "translateX(-50%)",
            }}
          />
        )
      }
    >
      <GridLines positions={yTicks.map(y)} length={iw} />
      {yTicks.map((t) => (
        <text
          key={t}
          className="tick-label"
          x={-10}
          y={y(t)}
          dy="0.32em"
          textAnchor="end"
        >
          {formatTick(t)}
        </text>
      ))}
      <Baseline at={ih} length={iw} />
      {xTickIdx.map((i) => (
        <text
          key={i}
          className="tick-label"
          x={x(points[i].label)}
          y={ih + 20}
          textAnchor="middle"
        >
          {points[i].label}
        </text>
      ))}
      {/* area wash + line */}
      <path d={areaPath} fill="var(--series-1)" opacity={0.1} />
      <path
        d={linePath}
        fill="none"
        stroke="var(--series-1)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* crosshair + active marker */}
      {activePoint && (
        <>
          <line
            x1={activeX}
            x2={activeX}
            y1={0}
            y2={ih}
            stroke="var(--baseline)"
            strokeWidth={1}
          />
          <circle
            cx={activeX}
            cy={y(activePoint.value)}
            r={4.5}
            fill="var(--series-1)"
            stroke="var(--surface-1)"
            strokeWidth={2}
          />
        </>
      )}
      {/* end marker with surface ring + direct end label */}
      <circle
        cx={x(last.label)}
        cy={y(last.value)}
        r={4.5}
        fill="var(--series-1)"
        stroke="var(--surface-1)"
        strokeWidth={2}
      />
      <text className="end-label" x={iw + 10} y={y(last.value)} dy="0.32em">
        {formatTick(last.value)}
      </text>
      {/* pointer hit area — the whole plot, never just the 2px line */}
      <rect
        x={0}
        y={0}
        width={iw}
        height={ih}
        fill="transparent"
        onPointerMove={(e) => setActive(indexFromPointer(e))}
        onPointerLeave={clear}
      />
    </ChartFrame>
  );
}
