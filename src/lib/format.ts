/** Shared number/date formatters (en-GB). */

const compact = new Intl.NumberFormat("en-GB", {
  notation: "compact",
  maximumSignificantDigits: 3,
});

const integer = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

/** 2_790_000 -> "2.79M" — hero figures, axis ticks. */
export function fmtCompact(n: number): string {
  return compact.format(n);
}

/** 2_790_000 -> "2,790,000" — tooltips, tables. */
export function fmtInt(n: number): string {
  return integer.format(n);
}

/** Bytes -> "6.5 MB" / "887 MB" / "1.2 GB". */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/** ISO timestamp -> "12 Jul 2026". */
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Unsigned percentage with one decimal: 0.683 -> "68.3%". */
export function fmtPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Whole-number percentage: 0.25 -> "25%" — axis ticks. */
export function fmtPct0(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Signed percentage with one decimal: 0.124 -> "+12.4%". */
export function fmtSignedPct(fraction: number): string {
  const pct = fraction * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** Signed integer: 164661 -> "+164,661" — net changes. */
export function fmtSignedInt(n: number): string {
  return `${n >= 0 ? "+" : ""}${integer.format(n)}`;
}

/** One decimal place: 99.31 -> "99.3" — rates per 1,000. */
export function fmtDec1(n: number): string {
  return n.toFixed(1);
}
