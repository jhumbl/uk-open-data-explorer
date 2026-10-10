/**
 * Compact select — the filter bar's control for dimensions with too
 * many values for a Segmented (areas, authorities, …). Same contract:
 * state lives with the caller, this only renders it. Use a "" value
 * for the all/default option; the caller maps it to "no filter".
 *
 * `groups` renders labelled <optgroup> sections after the flat
 * options — for hierarchical dimensions sharing one control (e.g.
 * regions and the local authorities within them).
 */
export default function Select<T extends string>({
  label,
  options,
  groups,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  groups?: { label: string; options: { value: T; label: string }[] }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <select
      className="select"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {groups?.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
