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
import Legend from "./Legend";
import { useActiveIndex } from "./useActiveIndex";

export interface Series {
  name: string;
  /** A series token, e.g. "var(--series-2)" — never raw hex. */
  color: string;
  /** One value per label, in label order. null = no figure (the series
      hadn't started, or the publisher gives none) — the line breaks
      there rather than dropping to zero. */
  values: (number | null)[];
}

/** A labelled shaded span on the x-axis (e.g. "Covid years") — context
    the reader needs to read the lines, drawn under them. */
export interface Band {
  /** First and last label covered (inclusive). */
  from: string;
  to: string;
  label: string;
}

interface Props {
  labels: string[];
  series: Series[];
  /** Compact formatter for axis ticks and the end labels (e.g. "2.5k"). */
  formatTick: (v: number) => string;
  /** Full-precision formatter for the tooltip (e.g. "2,516"). */
  formatValue: (v: number) => string;
  ariaLabel: string;
  height?: number;
  /** Which label indices get an x tick. Defaults to ~6 evenly spaced. */
  xTicks?: number[];
  /** Display text for an x tick. Defaults to the label itself. */
  formatXTick?: (label: string) => string;
  /** Tooltip header for a label. Defaults to the label itself. */
  tipHeader?: (label: string) => string;
  band?: Band;
}

const DEFAULT_HEIGHT = 300;
const MARGIN: Margin = { top: 18, right: 64, bottom: 32, left: 48 };
/** Minimum vertical separation between end labels (≈ one line height). */
const LABEL_GAP = 14;
/** Minimum horizontal pitch between x tick labels. */
const MIN_TICK_GAP = 44;

/**
 * Categorical multi-series line chart: 2px lines in the validated series
 * slots, shared crosshair + one tooltip row per series (pointer and
 * keyboard), legend above (mandatory for ≥2 series), value end labels
 * with collision dodging. No area wash — overlapping washes turn to mud
 * with ≥2 series; the wash is a single-series device. Colour follows the
 * entity: callers assign each series its token once and keep it through
 * filtering. Capped at the four validated slots — more series means
 * small multiples (see gallery/SmallMultiples), "Other", or a different
 * question.
 *
 * Promoted from the gallery when transport-recovery became its first
 * dashboard consumer (2026-11), gaining null gaps, an optional band,
 * and caller-chosen x ticks for long series.
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

/** Index of the last non-null value, or -1. */
function lastDefined(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
}

export default function MultiLineChart({
  labels,
  series,
  formatTick,
  formatValue,
  ariaLabel,
  height = DEFAULT_HEIGHT,
  xTicks,
  formatXTick = (l) => l,
  tipHeader = (l) => l,
  band,
}: Props) {
  const { ref, width } = useContainerWidth();
  const { iw, ih } = innerSize(width, height, MARGIN);
  const { active, setActive, onKeyDown, clear } = useActiveIndex(labels.length);

  const { x, y, paths, ends, endLabelY, yTicks, xTickIdx } = useMemo(() => {
    const x = d3.scalePoint(labels, [0, iw]);
    const yMax =
      d3.max(series, (s) => d3.max(s.values, (v) => v ?? undefined)) ?? 1;
    const y = d3.scaleLinear([0, yMax], [ih, 0]).nice();
    const line = d3
      .line<number | null>()
      .defined((v) => v !== null)
      .x((_, i) => x(labels[i])!)
      .y((v) => y(v as number));
    const paths = series.map((s) => line(s.values) ?? "");
    const ends = series.map((s) => lastDefined(s.values));
    const endLabelY = dodge(
      series.map((s, si) =>
        ends[si] >= 0 ? y(s.values[ends[si]] as number) : ih,
      ),
      LABEL_GAP,
      0,
      ih,
    );
    const yTicks = y.ticks(4).filter((t) => t > 0);
    const tickStep = Math.max(1, Math.ceil(labels.length / 6));
    const wanted =
      xTicks ?? labels.map((_, i) => i).filter((i) => i % tickStep === 0);
    // Thin caller ticks on narrow charts so labels never collide.
    const xTickIdx: number[] = [];
    for (const i of wanted) {
      const prev = xTickIdx[xTickIdx.length - 1];
      if (prev === undefined || x(labels[i])! - x(labels[prev])! >= MIN_TICK_GAP) {
        xTickIdx.push(i);
      }
    }
    return { x, y, paths, ends, endLabelY, yTicks, xTickIdx };
  }, [labels, series, iw, ih, xTicks]);

  if (labels.length === 0 || series.length === 0) return null;

  const indexFromPointer = (e: React.PointerEvent<SVGRectElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const step = labels.length > 1 ? iw / (labels.length - 1) : iw;
    return Math.max(0, Math.min(labels.length - 1, Math.round(px / step)));
  };

  const activeX = active !== null ? (x(labels[active]) ?? 0) : 0;
  const bandX0 = band ? x(band.from) : undefined;
  const bandX1 = band ? x(band.to) : undefined;

  return (
    <>
      {/* ≥2 series always get a legend; one series never does (the card
          title names it) — so a single gappy series can use this chart. */}
      {series.length >= 2 && (
        <Legend items={series.map((s) => ({ label: s.name, color: s.color }))} />
      )}
      <ChartFrame
        wrapRef={ref}
        width={width}
        height={height}
        margin={MARGIN}
        ariaLabel={ariaLabel}
        onKeyDown={onKeyDown}
        onBlur={clear}
        overlay={
          active !== null && (
            <ChartTooltip
              label={tipHeader(labels[active])}
              rows={series.map((s) => {
                const v = s.values[active];
                return {
                  color: s.color,
                  label: s.name,
                  value: v === null ? "—" : formatValue(v),
                };
              })}
              style={{
                left: Math.max(90, Math.min(width - 90, MARGIN.left + activeX)),
                top: 0,
                transform: "translateX(-50%)",
              }}
            />
          )
        }
      >
        {band && bandX0 !== undefined && bandX1 !== undefined && (
          <>
            <rect
              x={bandX0}
              y={0}
              width={Math.max(0, bandX1 - bandX0)}
              height={ih}
              fill="var(--hover)"
            />
            <text className="tick-label" x={bandX0 + 6} y={12}>
              {band.label}
            </text>
          </>
        )}
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
            {formatXTick(labels[i])}
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
        {/* crosshair + active markers, one per series with a figure */}
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
            {series.map((s) => {
              const v = s.values[active];
              return v === null ? null : (
                <circle
                  key={s.name}
                  cx={activeX}
                  cy={y(v)}
                  r={4.5}
                  fill={s.color}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              );
            })}
          </>
        )}
        {/* end markers + dodged value end labels (series names live in
            the legend; the label carries the value) */}
        {series.map((s, si) => {
          const i = ends[si];
          if (i < 0) return null;
          const last = s.values[i] as number;
          return (
            <g key={s.name}>
              <circle
                cx={x(labels[i])}
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
