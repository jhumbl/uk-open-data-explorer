/**
 * The series legend — mandatory for every chart with ≥2 series, never
 * shown for one (the card title names a single series). Identity comes
 * from the coloured swatch; the text wears text tokens, never the
 * series colour (see CLAUDE.md · Dataviz conventions).
 */
export interface LegendItem {
  label: string;
  /** A series token, e.g. "var(--series-2)" — never raw hex. */
  color: string;
}

export default function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div className="chart-legend" role="list" aria-label="Series">
      {items.map((it) => (
        <span key={it.label} role="listitem" className="legend-item">
          <span
            className="legend-swatch"
            style={{ background: it.color }}
            aria-hidden="true"
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}
