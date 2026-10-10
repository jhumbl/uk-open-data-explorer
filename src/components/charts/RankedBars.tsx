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

export interface RankedBar {
  label: string;
  /** The ranked measure (a share, a rate, a count — the axis follows). */
  value: number;
  /** Supporting count for tooltip copy (denominator, absolute total…). */
  count: number;
}

interface Props {
  /** Pre-sorted rows, best first. */
  rows: RankedBar[];
  /** Optional labelled reference line (e.g. the overall average). */
  refValue?: number;
  /** Name for the reference line's label (e.g. "London"). */
  refLabel?: string;
  /** Axis-tick formatter (compact). */
  formatTick: (v: number) => string;
  /** End-label formatter (the extremes' direct labels). */
  formatValue: (v: number) => string;
  /** Tooltip's value line. */
  tipValue: (row: RankedBar) => string;
  /** Tooltip's second line. */
  tipLabel: (row: RankedBar) => string;
  ariaLabel: string;
  /** Cross-filter selection on this chart's own dimension: the selected
      row's label, or null. Keyed by label so it survives re-ranks. */
  selected?: string | null;
  /** Present ⇒ the rows are selectable: click, or Enter/Space on the
      active row, fires with the row's label (caller toggles). */
  onSelect?: (label: string) => void;
  /** Vertical pitch per row. The default is the comfortable single-column
      reading; dense multi-card layouts pass ~15. Bar thickness scales. */
  rowHeight?: number;
  /** Fix the axis maximum (e.g. 1 for a 0–100% share axis, so bars read
      against "all of them"). Defaults to a nice data-driven maximum. */
  domainMax?: number;
  /** Fix the axis ticks (e.g. quarters of a share axis). Defaults to
      ~4 nice data-driven ticks. */
  ticks?: number[];
  /** Width of the category-label gutter (the left margin). The default
      fits borough/LA names; short-label dimensions (tree kinds, fuels)
      pass less so the plot gets the space back. */
  labelWidth?: number;
}

const MARGIN: Margin = { top: 24, right: 44, bottom: 28, left: 176 };
const END_RADIUS = 4;

/** Bar anchored to the left baseline with a rounded data-end (right). */
function roundedRightBar(y: number, w: number, h: number): string {
  const r = Math.min(END_RADIUS, w, h / 2);
  return [
    `M0,${y}`,
    `L${w - r},${y}`,
    `Q${w},${y} ${w},${y + r}`,
    `L${w},${y + h - r}`,
    `Q${w},${y + h} ${w - r},${y + h}`,
    `L0,${y + h}`,
    "Z",
  ].join("");
}

/**
 * Horizontal ranked bars: one row per category, best first. Single
 * measure, single hue, no legend. Extremes are direct-labelled;
 * everything else is in the tooltip (pointer + arrow keys).
 */
export default function RankedBars({
  rows,
  refValue,
  refLabel,
  formatTick,
  formatValue,
  tipValue,
  tipLabel,
  ariaLabel,
  selected = null,
  onSelect,
  rowHeight = 19,
  domainMax,
  ticks,
  labelWidth = MARGIN.left,
}: Props) {
  // 19 → 10px bars (the long-standing look); 15 → 8px.
  const barHeight = Math.round(rowHeight * 0.55);
  const margin: Margin = { ...MARGIN, left: labelWidth };
  const { ref, width } = useContainerWidth();
  const height = rows.length * rowHeight + margin.top + margin.bottom;
  const { iw, ih } = innerSize(width, height, margin);
  const { active, setActive, onKeyDown, clear } = useActiveIndex(
    rows.length,
    onSelect ? (i) => onSelect(rows[i].label) : undefined,
  );

  const { x, xTicks } = useMemo(() => {
    const x = d3.scaleLinear(
      [0, domainMax ?? d3.max(rows, (r) => r.value) ?? 1],
      [0, iw],
    );
    if (domainMax === undefined) x.nice(4);
    const xTicks = ticks ?? x.ticks(4).filter((t) => t > 0);
    return { x, xTicks };
  }, [rows, iw, domainMax, ticks]);

  if (rows.length === 0) return null;

  const rowY = (i: number) => i * rowHeight;
  const barY = (i: number) => rowY(i) + (rowHeight - barHeight) / 2;

  const indexFromPointer = (e: React.MouseEvent<SVGRectElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const py = e.clientY - rect.top;
    return Math.max(0, Math.min(rows.length - 1, Math.floor(py / rowHeight)));
  };

  const activeRow = active !== null ? rows[active] : null;

  return (
    <ChartFrame
      wrapRef={ref}
      width={width}
      height={height}
      margin={margin}
      ariaLabel={ariaLabel}
      onKeyDown={onKeyDown}
      onBlur={clear}
      overlay={
        activeRow && active !== null && (
          <ChartTooltip
            value={tipValue(activeRow)}
            label={tipLabel(activeRow)}
            style={{
              left: Math.max(
                120,
                Math.min(width - 120, margin.left + x(activeRow.value)),
              ),
              top: margin.top + rowY(active) - 34,
              transform: "translateX(-50%)",
            }}
          />
        )
      }
    >
      <GridLines positions={xTicks.map(x)} length={ih} orient="v" />
      {xTicks.map((t) => (
        <text
          key={t}
          className="tick-label"
          x={x(t)}
          y={ih + 18}
          textAnchor="middle"
        >
          {formatTick(t)}
        </text>
      ))}
      {/* reference line, labelled at the top */}
      {refValue !== undefined && (
        <>
          <line
            x1={x(refValue)}
            x2={x(refValue)}
            y1={-6}
            y2={ih}
            stroke="var(--baseline)"
            strokeWidth={1}
          />
          <text
            className="tick-label"
            x={x(refValue)}
            y={-12}
            textAnchor="middle"
          >
            {refLabel} {formatValue(refValue)}
          </text>
        </>
      )}
      {rows.map((r, i) => (
        <g key={r.label}>
          <path
            className={
              selected !== null && r.label !== selected
                ? "mark-dimmed"
                : undefined
            }
            d={roundedRightBar(barY(i), x(r.value), barHeight)}
            fill="var(--series-1)"
          />
          <text
            className={
              r.label === selected ? "cat-label selected" : "cat-label"
            }
            x={-8}
            y={rowY(i) + rowHeight / 2}
            dy="0.32em"
            textAnchor="end"
          >
            {r.label}
          </text>
        </g>
      ))}
      {/* direct labels on the extremes only */}
      {[0, rows.length - 1].map((i) => (
        <text
          key={i}
          className="end-label"
          x={x(rows[i].value) + 8}
          y={rowY(i) + rowHeight / 2}
          dy="0.32em"
        >
          {formatValue(rows[i].value)}
        </text>
      ))}
      <Baseline at={0} length={ih} orient="v" />
      <rect
        x={0}
        y={0}
        width={iw}
        height={ih}
        fill="transparent"
        style={onSelect ? { cursor: "pointer" } : undefined}
        onPointerMove={(e) => setActive(indexFromPointer(e))}
        onPointerLeave={clear}
        onClick={
          onSelect ? (e) => onSelect(rows[indexFromPointer(e)].label) : undefined
        }
      />
    </ChartFrame>
  );
}
