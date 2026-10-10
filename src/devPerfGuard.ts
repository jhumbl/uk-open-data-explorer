/**
 * Dev-only: disable react-dom's development-build performance tracks
 * (the "Components ⚛" / "Scheduler ⚛" lanes in the DevTools profiler).
 *
 * On every commit where a component's props changed by reference, the
 * dev build deep-diffs and serializes the props into performance.measure
 * entries — including `for…in`/JSON-stringify over entire typed arrays.
 * The map dashboards pass million-element typed arrays as props, so in
 * dev that meant multi-second freezes and ~1.5 GB of transient garbage
 * (measured 2026-07-18: trees re-entry 4,015 ms → 180 ms with this
 * guard). Production builds contain none of that instrumentation; this
 * file exists solely to make `npm run dev` behave like the real site.
 *
 * react-dom gates the whole feature on `console.timeStamp` existing at
 * module-initialisation time, so this must run before react-dom does:
 * keep this the FIRST import in main.tsx.
 */
if (import.meta.env.DEV) {
  delete (console as { timeStamp?: unknown }).timeStamp;
}

export {};
