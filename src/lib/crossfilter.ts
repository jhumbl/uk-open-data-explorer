import { useCallback, useMemo, useState } from "react";

/**
 * The cross-filter kit (decided 2026-07-17; pilot: food-hygiene-london).
 *
 * A dashboard declares its filterable dimensions once (a module-level
 * const — the hook keeps `reset` stable by identity) and this hook owns
 * the single filter state. The always-rendered filter bar is the single
 * DISPLAY of that state; chart clicks only WRITE it, via `toggle`, so a
 * mark click and its bar control are interchangeable.
 *
 * The SQL side is deliberately tiny and composable: each card builds its
 * own WHERE from `eq()` clauses and simply leaves out its own dimension
 * (the crossfilter convention — the clicked chart keeps its full
 * distribution for re-selection; tiles and detail cards include every
 * clause). No query builder, no registry of predicates: what a card
 * excludes is visible in its own SQL.
 */

export type FilterState<K extends string> = Record<K, string | null>;

export function useCrossFilter<K extends string>(dims: readonly K[]) {
  const initial = useCallback(
    () => Object.fromEntries(dims.map((d) => [d, null])) as FilterState<K>,
    [dims],
  );
  const [filters, setFilters] = useState<FilterState<K>>(initial);

  /** Filter-bar semantics: set a value, or null for "All". */
  const set = useCallback((dim: K, value: string | null) => {
    setFilters((f) => ({ ...f, [dim]: value }));
  }, []);

  /** Chart-click semantics: clicking the selected mark clears it. */
  const toggle = useCallback((dim: K, value: string) => {
    setFilters((f) => ({ ...f, [dim]: f[dim] === value ? null : value }));
  }, []);

  const reset = useCallback(() => setFilters(initial()), [initial]);

  const isDefault = useMemo(
    () => Object.values(filters).every((v) => v === null),
    [filters],
  );

  return { filters, set, toggle, reset, isDefault };
}

/** A value as a SQL single-quoted string literal (quotes doubled). */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Equality clause for a filter value; null ("All") contributes nothing. */
export function eq(column: string, value: string | null): string | null {
  return value === null ? null : `${column} = ${sqlString(value)}`;
}

/** AND the live clauses into a WHERE — or nothing, when all are null. */
export function buildWhere(clauses: Array<string | null>): string {
  const live = clauses.filter((c): c is string => c !== null);
  return live.length === 0 ? "" : `WHERE ${live.join(" AND ")}`;
}
