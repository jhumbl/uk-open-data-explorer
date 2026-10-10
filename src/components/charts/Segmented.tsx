/**
 * Segmented control — the shared control primitive for the card
 * anatomy's controls slot (between the subtitle and the chart, or under
 * a dashboard title for page-level filters). State lives with the
 * caller; this only renders the group. Whether a dashboard filters
 * per-chart or page-wide is decided per dashboard (2026-07-17) — but
 * whichever it picks, the control looks like this.
 */
export default function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          className={value === o.value ? "active" : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
