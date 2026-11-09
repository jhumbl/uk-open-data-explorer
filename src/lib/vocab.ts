import { query } from "./duckdb";

/**
 * Open vocabularies — categorical columns a publisher extends over time
 * (DfT's `fuel` and `body_type`). Dashboards keep a curated list for
 * order, labels and prose nouns, but the BINS come from the data: a
 * category the curated list doesn't know must still get a bar, or it
 * silently vanishes from the chart while still counting in the
 * denominator (shares quietly sum below 100%).
 *
 * The domain is read from the loaded in-memory table rather than from
 * catalog.json's `stats.categorical_values`: the catalog is chrome, not
 * a dependency (CLAUDE.md · data contract), and the table is the exact
 * data being charted.
 */

export interface VocabEntry {
  value: string;
  label: string;
}

/** The publisher's margin row ('Total') is a cube coordinate, never a bin. */
const MARGIN = "Total";

const domains = new Map<string, Promise<string[]>>();

/** A column's distinct values in a loaded table, margin excluded.
    Memoized per table+column — the table is immutable once loaded. */
export function columnDomain(table: string, column: string): Promise<string[]> {
  const key = `${table}.${column}`;
  let p = domains.get(key);
  if (!p) {
    p = query<{ v: string }>(
      `SELECT DISTINCT "${column}" AS v FROM "${table}"
       WHERE "${column}" IS NOT NULL AND "${column}" != '${MARGIN}'
       ORDER BY v`,
    ).then((rows) => rows.map((r) => r.v));
    p.catch(() => domains.delete(key));
    domains.set(key, p);
  }
  return p;
}

/**
 * Curated entries first, in their order and with their labels (kept
 * even if absent from the data: a zero bar beats a card whose bins
 * change), then every value the data holds that the curated list
 * doesn't know, under its raw name, alphabetically. Unknown values are
 * logged so a developer notices and curates them.
 */
export function extendVocab<T extends VocabEntry>(
  curated: readonly T[],
  present: string[],
  fallback: (raw: string) => T,
): T[] {
  const known = new Set(curated.map((c) => c.value));
  const unknown = present.filter((v) => !known.has(v));
  if (unknown.length > 0) {
    console.warn(
      `[vocab] values not in the curated list — shown under their raw names: ${unknown.join(", ")}`,
    );
  }
  return [...curated, ...unknown.map(fallback)];
}
