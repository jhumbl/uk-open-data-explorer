import { useEffect, useState } from "react";
import { fetchCatalog, type Catalog } from "./catalog";
import { fmtDate, fmtInt } from "./format";

/**
 * The catalog as React state. fetchCatalog() caches its promise, so any
 * number of components can call this for the price of one request.
 * Catalog chrome must degrade gracefully — render nothing on error.
 */
export function useCatalog(): { catalog: Catalog | null; error: string | null } {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchCatalog()
      .then((c) => !cancelled && setCatalog(c))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);
  return { catalog, error };
}

/** Chapter meta line, e.g. "374,547 rows · 2011 Q4 → 2025 Q4 · updated 12 Jul 2026". */
export function filesMeta(catalog: Catalog, files: string[]): string {
  const entries = files
    .map((f) => catalog.datasets[f])
    .filter((e) => e !== undefined);
  if (entries.length === 0) return "";
  const parts: string[] = [];
  const rows = entries.reduce((sum, e) => sum + (e.stats?.row_count ?? 0), 0);
  if (rows > 0) parts.push(`${fmtInt(rows)} rows`);
  const stats = entries[0].stats;
  if (entries.length === 1 && stats?.min_period && stats?.max_period) {
    parts.push(`${stats.min_period} → ${stats.max_period}`);
  }
  const updated = entries
    .map((e) => e.last_changed)
    .sort()
    .at(-1);
  if (updated) parts.push(`updated ${fmtDate(updated)}`);
  return parts.join(" · ");
}

/** Latest pipeline check across all files — the masthead's edition date. */
export function compiledDate(catalog: Catalog): string | null {
  const latest = Object.values(catalog.datasets)
    .map((e) => e.last_checked)
    .sort()
    .at(-1);
  return latest ?? null;
}
