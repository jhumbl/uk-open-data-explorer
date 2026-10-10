import { useMemo } from "react";
import * as d3 from "d3";
import ChartFrame, {
  Baseline,
  GridLines,
  innerSize,
  useContainerWidth,
  type Margin,
} from "../components/charts/ChartFrame";
import ChartTooltip from "../components/charts/ChartTooltip";
import Legend from "../components/charts/Legend";
import { useActiveIndex } from "../components/charts/useActiveIndex";

export interface Series {
  name: string;
  /** A series token, e.g. "var(--series-2)" — never raw hex. */
  color: string;
  /** One value per label, in label order. */
  values: number[];
}

interface Props {
  labels: string[];
  series: Series[];
  /** Compact formatter for axis ticks and the end labels (e.g. "2.5k"). */
  formatTick: (v: number) => string;
  /** Full-precision formatter for the tooltip (e.g. "2,516"). */
  formatValue: (v: number) => string;
  ariaLabel: string;
}

const HEIGHT = 300;
const MARGIN: Margin = { top: 18, right: 64, bottom: 32, left: 48 };
/** Minimum vertical separation between end labels (≈ one line height). */
const LABEL_GAP = 14;

/**
 * Categorical multi-series line chart: 2px lines in the validated series
 * slots, shared crosshair + one tooltip row per series (pointer and
 * keyboard), legend above (mandatory for ≥2 series), value end labels
 * with collision dodging. No area wash — overlapping washes turn to mud
 * with ≥2 series; the wash is a single-series device. Colour follows the
 * entity: callers assign each series its token once and keep it through
 * filtering. Capped at the four validated slots — more series means
 * small multiples (see SmallMultiples), "Other", or a different question.
 *
 * Gallery-local until a dashboard needs it (see CLAUDE.md · Charting);
 * previewed at #/charts-template first, per the gallery's contract.
 *
 * Data changes snap — transitions were tried and reverted (see the
 * charts skill · Transitions); don't reintroduce them ad hoc.
 */

/**
 * Nudge label positions apart until each pair is ≥ gap, keeping rank
 * order and clamping to [lo, hi]. Returns positions in input order.
 */
function dodge(desired: number[], gap: number, lo: number, hi: number): number[] {
  const order = desired
    .map((y, i) => ({ y, i }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    order[k].y = Math.max(order[k].y, order[k - 1].y + gap);
  }
  const over = order.length > 0 ? order[order.length - 1].y - hi : 0;
  if (over > 0) {
    order[order.length - 1].y = hi;
    for (let k = order.length - 2; k >= 0; k--) {
      order[k].y = Math.min(order[k].y, order[k + 1].y - gap);
    }
  }
  const out = new Array<number>(desired.length);
  for (const { y, i } of order) out[i] = Math.max(lo, y);
  return out;
}

export default function MultiLineChart({
  labels,
  series,
  formatTick,
  formatValue,
  ariaLabel,
}: Props) {
  const { ref, width } = useContainerWidth();
  const { iw, ih } = innerSize(width, HEIGHT, MARGIN);
  const { active, setActive, onKeyDown, clear } = useActiveIndex(labels.length);

  const { x, y, paths, endLabelY, yTicks, xTickIdx } = useMemo(() => {
    const x = d3.scalePoint(labels, [0, iw]);
    const yMax = d3.max(series, (s) => d3.max(s.values)) ?? 1;
    const y = d3.scaleLinear([0, yMax], [ih, 0]).nice();
    const line = d3
      .line<number>()
      .x((_, i) => x(labels[i])!)
      .y((v) => y(v));
    const paths = series.map((s) => line(s.values) ?? "");
    const endLabelY = dodge(
      series.map((s) => y(s.values[s.values.length - 1])),
      LABEL_GAP,
      0,
      ih,
    );
    const yTicks = y.ticks(4).filter((t) => t > 0);
    const tickStep = Math.max(1, Math.ceil(labels.length / 6));
    const xTickIdx = labels.map((_, i) => i).filter((i) => i % tickStep === 0);
    return { x, y, paths, endLabelY, yTicks, xTickIdx };
  }, [labels, series, iw, ih]);

  if (labels.length === 0 || series.length === 0) return null;

  const indexFromPointer = (e: React.PointerEvent<SVGRectElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const step = labels.length > 1 ? iw / (labels.length - 1) : iw;
    return Math.max(0, Math.min(labels.length - 1, Math.round(px / step)));
  };

  const activeX = active !== null ? (x(labels[active]) ?? 0) : 0;

  return (
    <>
      <Legend items={series.map((s) => ({ label: s.name, color: s.color }))} />
      <ChartFrame
        wrapRef={ref}
        width={width}
        height={HEIGHT}
        margin={MARGIN}
        ariaLabel={ariaLabel}
        onKeyDown={onKeyDown}
        onBlur={clear}
        overlay={
          active !== null && (
            <ChartTooltip
              label={labels[active]}
              rows={series.map((s) => ({
                color: s.color,
                label: s.name,
                value: formatValue(s.values[active]),
              }))}
              style={{
                left: Math.max(90, Math.min(width - 90, MARGIN.left + activeX)),
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
            x={x(labels[i])}
            y={ih + 20}
            textAnchor="middle"
          >
            {labels[i]}
          </text>
        ))}
        {series.map((s, si) => (
          <path
            key={s.name}
            d={paths[si]}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {/* crosshair + active markers, one per series */}
        {active !== null && (
          <>
            <line
              x1={activeX}
              x2={activeX}
              y1={0}
              y2={ih}
              stroke="var(--baseline)"
              strokeWidth={1}
            />
            {series.map((s) => (
              <circle
                key={s.name}
                cx={activeX}
                cy={y(s.values[active])}
                r={4.5}
                fill={s.color}
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            ))}
          </>
        )}
        {/* end markers + dodged value end labels (series names live in
            the legend; the label carries the value) */}
        {series.map((s, si) => {
          const last = s.values[s.values.length - 1];
          return (
            <g key={s.name}>
              <circle
                cx={iw}
                cy={y(last)}
                r={4.5}
                fill={s.color}
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
              <text
                className="end-label"
                x={iw + 10}
                y={endLabelY[si]}
                dy="0.32em"
              >
                {formatTick(last)}
              </text>
            </g>
          );
        })}
        {/* pointer hit area — the whole plot, never just the 2px lines */}
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
    </>
  );
}
