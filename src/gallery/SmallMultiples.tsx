import { useMemo, useState } from "react";
import * as d3 from "d3";
import ChartFrame, {
  Baseline,
  innerSize,
  useContainerWidth,
  type Margin,
} from "../components/charts/ChartFrame";
import ChartTooltip from "../components/charts/ChartTooltip";
import { useActiveIndex } from "../components/charts/useActiveIndex";
import type { Series } from "./MultiLineChart";

interface Props {
  labels: string[];
  series: Series[];
  /** Compact formatter for the end labels (e.g. "2.5k"). */
  formatTick: (v: number) => string;
  /** Full-precision formatter for the tooltip (e.g. "2,516"). */
  formatValue: (v: number) => string;
}

const HEIGHT = 110;
const MARGIN: Margin = { top: 10, right: 48, bottom: 22, left: 8 };

/**
 * Small multiples — the escape valve when a line chart would need more
 * series than the four validated colour slots: one mini panel per
 * series, all in --series-1 (the panel title carries identity, so
 * colour doesn't have to — Series.color is deliberately ignored), all
 * on a SHARED y domain so magnitudes compare across panels. The
 * crosshair is synced: hovering or arrow-keying any panel marks the
 * same period everywhere; the tooltip follows the panel with the
 * pointer or focus.
 *
 * Gallery-local until a dashboard needs it (see CLAUDE.md · Charting);
 * previewed at #/charts-template first, per the gallery's contract.
 */
export default function SmallMultiples({
  labels,
  series,
  formatTick,
  formatValue,
}: Props) {
  const { active, setActive, onKeyDown, clear } = useActiveIndex(labels.length);
  const [panel, setPanel] = useState<number | null>(null);

  const yMax = useMemo(
    () => d3.max(series, (s) => d3.max(s.values)) ?? 1,
    [series],
  );

  if (labels.length === 0 || series.length === 0) return null;

  return (
    <div className="small-multiples">
      {series.map((s, si) => (
        <Panel
          key={s.name}
          labels={labels}
          series={s}
          yMax={yMax}
          active={active}
          showTooltip={panel === si}
          formatTick={formatTick}
          formatValue={formatValue}
          onKeyDown={onKeyDown}
          onEnter={() => setPanel(si)}
          onLeave={() => {
            setPanel((p) => (p === si ? null : p));
            clear();
          }}
          setActive={setActive}
        />
      ))}
    </div>
  );
}

function Panel({
  labels,
  series,
  yMax,
  active,
  showTooltip,
  formatTick,
  formatValue,
  onKeyDown,
  onEnter,
  onLeave,
  setActive,
}: {
  labels: string[];
  series: Series;
  yMax: number;
  active: number | null;
  showTooltip: boolean;
  formatTick: (v: number) => string;
  formatValue: (v: number) => string;
  onKeyDown: React.KeyboardEventHandler<SVGSVGElement>;
  onEnter: () => void;
  onLeave: () => void;
  setActive: (i: number) => void;
}) {
  const { ref, width } = useContainerWidth(240);
  const { iw, ih } = innerSize(width, HEIGHT, MARGIN);

  const { x, y, path } = useMemo(() => {
    const x = d3.scalePoint(labels, [0, iw]);
    const y = d3.scaleLinear([0, yMax], [ih, 0]).nice();
    const path =
      d3
        .line<number>()
        .x((_, i) => x(labels[i])!)
        .y((v) => y(v))(series.values) ?? "";
    return { x, y, path };
  }, [labels, series, yMax, iw, ih]);

  const indexFromPointer = (e: React.PointerEvent<SVGRectElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const step = labels.length > 1 ? iw / (labels.length - 1) : iw;
    return Math.max(0, Math.min(labels.length - 1, Math.round(px / step)));
  };

  const last = series.values[series.values.length - 1];
  const activeX = active !== null ? (x(labels[active]) ?? 0) : 0;

  return (
    <div>
      <p className="sm-title">{series.name}</p>
      <ChartFrame
        wrapRef={ref}
        width={width}
        height={HEIGHT}
        margin={MARGIN}
        ariaLabel={`${series.name}. Use arrow keys to step through values.`}
        onKeyDown={onKeyDown}
        onFocus={onEnter}
        onBlur={onLeave}
        overlay={
          showTooltip &&
          active !== null && (
            <ChartTooltip
              value={formatValue(series.values[active])}
              label={labels[active]}
              style={{
                left: Math.max(70, Math.min(width - 70, MARGIN.left + activeX)),
                top: 0,
                transform: "translateX(-50%)",
              }}
            />
          )
        }
      >
        <Baseline at={ih} length={iw} />
        <text className="tick-label" x={0} y={ih + 14}>
          {labels[0]}
        </text>
        <text className="tick-label" x={iw} y={ih + 14} textAnchor="end">
          {labels[labels.length - 1]}
        </text>
        <path
          d={path}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* synced crosshair; the marker only where the tooltip is */}
        {active !== null && (
          <line
            x1={activeX}
            x2={activeX}
            y1={0}
            y2={ih}
            stroke="var(--baseline)"
            strokeWidth={1}
          />
        )}
        {showTooltip && active !== null && (
          <circle
            cx={activeX}
            cy={y(series.values[active])}
            r={4.5}
            fill="var(--series-1)"
            stroke="var(--surface-1)"
            strokeWidth={2}
          />
        )}
        <circle
          cx={iw}
          cy={y(last)}
          r={4}
          fill="var(--series-1)"
          stroke="var(--surface-1)"
          strokeWidth={2}
        />
        <text className="end-label" x={iw + 8} y={y(last)} dy="0.32em">
          {formatTick(last)}
        </text>
        {/* pointer hit area — the whole plot, never just the 2px line */}
        <rect
          x={0}
          y={0}
          width={iw}
          height={ih}
          fill="transparent"
          onPointerMove={(e) => {
            onEnter();
            setActive(indexFromPointer(e));
          }}
          onPointerLeave={onLeave}
        />
      </ChartFrame>
    </div>
  );
}
