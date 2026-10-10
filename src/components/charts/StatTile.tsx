import type { ReactNode } from "react";

/** The headline row above a dashboard's charts. */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className="stat-row">{children}</div>;
}

/**
 * One headline figure. `delta` is the small line under the value —
 * context, a comparison, or a change (wrap the changing part in
 * .dir-up / .dir-down spans for the coloured direction treatment).
 *
 * With `loading`, the tile renders its full frame (rule + label) and a
 * placeholder bar where the value will be, at the value's exact height,
 * so the number lands without any reflow. The delta line keeps a
 * non-breaking space for the same reason.
 */
export function StatTile({
  label,
  value,
  delta,
  loading = false,
}: {
  label: ReactNode;
  value?: ReactNode;
  delta?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="stat-tile">
      <div className="label">{label}</div>
      <div className="value">
        {loading ? (
          <span className="value-pending" role="status" aria-label="loading" />
        ) : (
          value
        )}
      </div>
      {(delta !== undefined || loading) && (
        <div className="delta">{loading ? <>&nbsp;</> : delta}</div>
      )}
    </div>
  );
}
