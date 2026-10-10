import { useCatalog } from "./lib/useCatalog";
import { fmtDate } from "./lib/format";

/** The pipeline runs weekly; past this, the catalog itself is stale. */
const STALE_AFTER_DAYS = 9;

/**
 * The home page. Navigation lives in the rail; this page's job is to say
 * what the site is, briefly, and hand over.
 */
export default function HomePage() {
  const { catalog, error } = useCatalog();

  const unhealthySources = catalog
    ? Object.entries(catalog.sources).filter(([, s]) => s.status !== "ok")
    : [];

  // catalog.json has no top-level timestamp, but every run re-stamps each
  // file's last_checked — the latest one is when the compilation last ran.
  const lastRun = catalog
    ? Object.values(catalog.datasets)
        .map((d) => d.last_checked)
        .sort()
        .at(-1)
    : undefined;
  const stale =
    lastRun !== undefined &&
    Date.now() - Date.parse(lastRun) > STALE_AFTER_DAYS * 86_400_000;
  const healthy = unhealthySources.length === 0 && !stale;
  const asOf = lastRun ? ` (${fmtDate(lastRun)})` : "";

  return (
    <>
      <h2>About</h2>
      <div className="intro">
        <p>
          Each dashboard answers one question that gets asked of a local
          authority, using the published open data that can answer it. The
          charts are computed in your browser, straight from the published
          files — no server, no tracking — which is why the first chart can
          take a few seconds, and why every dashboard states its caveats.
        </p>
        <p className="fine">
          {error !== null ? (
            <>
              The source-health check couldn&rsquo;t load — the dashboards
              themselves are unaffected; they read the data directly.
            </>
          ) : catalog === null ? (
            <>Checking the sources…</>
          ) : stale ? (
            <>
              <span className="status-dot bad" aria-hidden="true" />
              The weekly compilation hasn&rsquo;t run since{" "}
              {fmtDate(lastRun!)}, so this health check may be out of date.
              The dashboards still read the last published data.
            </>
          ) : healthy ? (
            <>
              <span className="status-dot ok" aria-hidden="true" />
              All sources were healthy at the last weekly compilation{asOf}.
            </>
          ) : (
            <>
              <span className="status-dot bad" aria-hidden="true" />
              Sources with problems at the last weekly compilation{asOf}:{" "}
              {unhealthySources
                .map(([name, s]) => `${name} (${s.status})`)
                .join(", ")}
              . Their dashboards still read the last good data.
            </>
          )}
        </p>
      </div>
    </>
  );
}
