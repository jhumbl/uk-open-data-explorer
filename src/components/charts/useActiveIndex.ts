import { type KeyboardEvent, useState } from "react";

/**
 * The active-mark state shared by every chart's hover/focus layer:
 * arrow keys step through the marks, Escape clears, blur clears
 * (charts wire `clear` to ChartFrame's onBlur). Pointer handling stays
 * chart-local — hit-testing depends on the scale — but feeds the same
 * state, so keyboard and pointer always surface identical information.
 *
 * Selectable charts (cross-filtering) pass `onSelect`: Enter or Space
 * then fires it with the active index — the keyboard twin of clicking a
 * mark, so selection has parity for free. The chart maps the index to
 * its own value and toggles the filter; no selection state lives here.
 */
export function useActiveIndex(
  count: number,
  onSelect?: (index: number) => void,
) {
  const [active, setActive] = useState<number | null>(null);

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (delta !== 0) {
      e.preventDefault();
      setActive((a) => {
        const current = a ?? (delta === 1 ? -1 : count);
        return Math.max(0, Math.min(count - 1, current + delta));
      });
    } else if (e.key === "Escape") {
      setActive(null);
    } else if ((e.key === "Enter" || e.key === " ") && onSelect) {
      if (active !== null) {
        e.preventDefault();
        onSelect(active);
      }
    }
  };

  const clear = () => setActive(null);

  return { active, setActive, onKeyDown, clear };
}
