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

export interface CategoryBar {
  label: string;
  value: number;
  /** Optional share of the card's total (0–1), for tooltip copy. */
  share?: number;
}

interface Props {
  bars: CategoryBar[];
  formatTick: (v: number) => string;
  formatValue: (v: number) => string;
  /** Tooltip's second line. */
  tipLabel: (bar: CategoryBar) => string;
  ariaLabel: string;
  /** Cross-filter selection on this chart's own dimension: the selected
      bar's label, or null. Keyed by label, not index, so it survives
      re-sorts and re-queries. */
  selected?: string | null;
  /** Present ⇒ the bars are selectable: click, or Enter/Space on the
      active bar, fires with the bar's label (caller toggles). */
  onSelect?: (label: string) => void;
  /** Chart height. The default is the single-column reading; dense
      multi-card layouts pass ~220. */
  height?: number;
}

const DEFAULT_HEIGHT = 260;
const MARGIN: Margin = { top: 22, right: 16, bottom: 32, left: 48 };
// Bars fill their band up to this cap (design decision 2026-07 — the
// old ≤24px rule read as anaemic with few categories).
const MAX_BAR_WIDTH = 64;
const END_RADIUS = 4;

/** Bar anchored to the baseline with a rounded data-end (top). */
function roundedTopBar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(END_RADIUS, h, w / 2);
  return [
    `M${x},${y + h}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${x + w - r},${y}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `L${x + w},${y + h}`,
    "Z",
  ].join("");
}

/** Bar hanging from the baseline with a rounded data-end (bottom). */
function roundedBottomBar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(END_RADIUS, h, w / 2);
  return [
    `M${x},${y}`,
    `L${x + w},${y}`,
    `L${x + w},${y + h - r}`,
    `Q${x + w},${y + h} ${x + w - r},${y + h}`,
    `L${x + r},${y + h}`,
    `Q${x},${y + h} ${x},${y + h - r}`,
    "Z",
  ].join("");
}

/**
 * Vertical bar chart over ordered categories: single series (counts or
 * net changes), so single hue and no legend. Negative values hang below
 * the zero baseline. Per-mark tooltip on pointer and keyboard; only the
 * largest-magnitude bar is direct-labelled; category labels thin out
 * automatically when the bins are many (e.g. quarters).
 */
export default function CategoryBars({
  bars,
  formatTick,
  formatValue,
  tipLabel,
  ariaLabel,
  selected = null,
  onSelect,
  height = DEFAULT_HEIGHT,
}: Props) {
  const { ref, width } = useContainerWidth();
  const { iw, ih } = innerSize(width, height, MARGIN);
  const { active, setActive, onKeyDown, clear } = useActiveIndex(
    bars.length,
    onSelect ? (i) => onSelect(bars[i].label) : undefined,
  );

  const { x, y, yTicks, extremeIdx } = useMemo(() => {
    const x = d3
      .scaleBand(
        bars.map((b) => b.label),
        [0, iw],
      )
      .paddingInner(0.25)
      .paddingOuter(0.15);
    const y = d3
      .scaleLinear(
        [
          Math.min(0, d3.min(bars, (b) => b.value) ?? 0),
          Math.max(0, d3.max(bars, (b) => b.value) ?? 1),
        ],
        [ih, 0],
      )
      .nice();
    const yTicks = y.ticks(4).filter((t) => t !== 0);
    const extremeIdx = d3.maxIndex(bars, (b) => Math.abs(b.value));
    return { x, y, yTicks, extremeIdx };
  }, [bars, iw, ih]);

  if (bars.length === 0) return null;

  const y0 = y(0);
  const barWidth = Math.min(MAX_BAR_WIDTH, x.bandwidth());
  const barX = (label: string) =>
    (x(label) ?? 0) + (x.bandwidth() - barWidth) / 2;
  // Many bins (quarters) can't all carry labels — thin to every Nth,
  // anchored at the first bin. Few bins (ratings, bands) show all.
  const labelStep = Math.max(1, Math.ceil(bars.length / 8));

  const indexFromPointer = (e: React.MouseEvent<SVGRectElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    return Math.max(
      0,
      Math.min(bars.length - 1, Math.floor(px / x.step())),
    );
  };

  const activeBar = active !== null ? bars[active] : null;
  const extreme = bars[extremeIdx];

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
        activeBar && (
          <ChartTooltip
            value={formatValue(activeBar.value)}
            label={tipLabel(activeBar)}
            style={{
              left: Math.max(
                90,
                Math.min(
                  width - 90,
                  MARGIN.left + barX(activeBar.label) + barWidth / 2,
                ),
              ),
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
      {bars.map((b) => (
        <path
          key={b.label}
          className={
            selected !== null && b.label !== selected ? "mark-dimmed" : undefined
          }
          d={
            b.value >= 0
              ? roundedTopBar(barX(b.label), y(b.value), barWidth, y0 - y(b.value))
              : roundedBottomBar(barX(b.label), y0, barWidth, y(b.value) - y0)
          }
          fill="var(--series-1)"
        />
      ))}
      <Baseline at={y0} length={iw} />
      {/* category labels under each bar, thinned when bins are many */}
      {bars.map((b, i) =>
        i % labelStep === 0 || b.label === selected ? (
          <text
            key={b.label}
            className={b.label === selected ? "cat-label selected" : "cat-label"}
            x={(x(b.label) ?? 0) + x.bandwidth() / 2}
            y={ih + 20}
            textAnchor="middle"
          >
            {b.label}
          </text>
        ) : null,
      )}
      {/* direct label on the extreme only */}
      <text
        className="end-label"
        x={barX(extreme.label) + barWidth / 2}
        y={
          extreme.value >= 0
            ? y(extreme.value) - 8
            : // A negative extreme is labelled above the baseline in its
              // own column — empty by definition, so the label can never
              // collide with the bar, the axis ticks, or a neighbour.
              y0 - 8
        }
        textAnchor="middle"
      >
        {formatTick(extreme.value)}
      </text>
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
          onSelect ? (e) => onSelect(bars[indexFromPointer(e)].label) : undefined
        }
      />
    </ChartFrame>
  );
}
