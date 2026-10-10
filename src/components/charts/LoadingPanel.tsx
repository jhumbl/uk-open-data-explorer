import { useSyncExternalStore } from "react";
import {
  getDuckDbStatus,
  subscribeDuckDbStatus,
  type DuckDbStatus,
} from "../../lib/duckdb";

function useDuckDbStatus(): DuckDbStatus {
  return useSyncExternalStore(subscribeDuckDbStatus, getDuckDbStatus);
}

/**
 * The empty plate: fills the slot a chart will occupy, at the chart's
 * exact height so nothing reflows when the data lands. Shows a thin
 * indeterminate progress rule and an honest stage label — DuckDB-Wasm
 * exposes no real query progress, so we only claim the stage we know.
 */
export default function LoadingPanel({ height }: { height: number }) {
  const status = useDuckDbStatus();
  const label = !status.engineReady
    ? "Loading the query engine — fetched once, then cached…"
    : "Querying the published file in your browser…";
  return (
    <div className="loading-panel" style={{ height }} role="status">
      <div className="progress-rule" aria-hidden="true" />
      <p className="loading-label">{label}</p>
    </div>
  );
}
