import type { CSSProperties } from "react";

/**
 * The floating tooltip every chart uses — rendered as ChartFrame's
 * `overlay` so it positions against the chart wrapper. Charts compute
 * (and clamp) the position; this owns the chrome. The same content must
 * be reachable by keyboard (see useActiveIndex) — never hover-only.
 *
 * Two shapes: `value` + `label` for a single-series mark, or `rows`
 * (one per series, swatch-identified) under a `label` header for
 * multi-series charts.
 */
export interface TooltipRow {
  /** A series token, e.g. "var(--series-2)" — never raw hex. */
  color: string;
  label: string;
  value: string;
}

export default function ChartTooltip({
  value,
  label,
  style,
  rows,
}: {
  value?: string;
  label: string;
  style: CSSProperties;
  rows?: TooltipRow[];
}) {
  return (
    <div className="chart-tooltip" style={style}>
      {rows ? (
        <>
          <span className="tip-label">{label}</span>
          {rows.map((r) => (
            <span key={r.label} className="tip-row">
              <span
                className="tip-swatch"
                style={{ background: r.color }}
                aria-hidden="true"
              />
              <span className="tip-label">{r.label}</span>
              <span className="tip-value">{r.value}</span>
            </span>
          ))}
        </>
      ) : (
        <>
          <span className="tip-value">{value}</span>{" "}
          <span className="tip-label">{label}</span>
        </>
      )}
    </div>
  );
}
