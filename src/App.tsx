import { Suspense, lazy, useEffect, useState, type ComponentType } from "react";
import { DASHBOARDS } from "./dashboards/registry";
import { PIPELINE_REPO_URL, HF_NAMESPACE } from "./lib/catalog";
import { useCatalog, compiledDate, filesMeta } from "./lib/useCatalog";
import { fmtDate } from "./lib/format";
import ErrorBoundary from "./components/ErrorBoundary";
import ContentsList from "./components/ContentsList";
import HomePage from "./HomePage";

// Hash routing, hand-rolled: three route shapes ("#/", "#/d/<id>" and the
// dev-only "#/charts-template" proofing page) don't justify a router
// dependency. Revisit if routes grow real structure.
function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

// Create each lazy component once, not per render.
const LAZY: ReadonlyMap<string, ComponentType> = new Map(
  DASHBOARDS.map((d) => [d.id, lazy(d.load)]),
);

// The design-language proofing page — dev-only (`npm run dev`): in
// production builds the import is dead code, so the chunk isn't emitted.
const ChartsGallery = import.meta.env.DEV
  ? lazy(() => import("./gallery/ChartsGallery"))
  : null;

export default function App() {
  const hash = useHashRoute();
  const dashboardId = hash.startsWith("#/d/") ? hash.slice(4) : null;
  const chapterIdx = dashboardId
    ? DASHBOARDS.findIndex((d) => d.id === dashboardId)
    : -1;
  const chapter = chapterIdx >= 0 ? DASHBOARDS[chapterIdx] : null;
  const Dashboard = dashboardId ? LAZY.get(dashboardId) : undefined;

  // Catalog chrome: the masthead's edition stamp and the chapter meta
  // line. Pure decoration — an unreachable catalog leaves both blank.
  const { catalog } = useCatalog();
  const compiled = catalog ? compiledDate(catalog) : null;
  const chapterMeta =
    catalog && chapter ? filesMeta(catalog, chapter.files) : null;

  const contents = <ContentsList activeId={dashboardId} catalog={catalog} />;
  const strap =
    "Dashboards over UK open data, computed in your browser straight " +
    "from the published files.";

  const rail = (
    <nav className="contents-rail" aria-label="Content">
      <div className="rail-masthead">
        <p className="rail-title">
          <a href="#/">UK Open Data Explorer</a>
        </p>
        {compiled && (
          <p className="rail-edition">Compiled {fmtDate(compiled)}</p>
        )}
        <p className="rail-strap">{strap}</p>
      </div>
      <p className="rail-head">Content</p>
      {contents}
    </nav>
  );

  // Map-first dashboards (registry `mapPage`, DRAFT archetype): the map
  // fills the viewport, so the container, header and footer step aside —
  // the dashboard's own panel carries the title, caveats and the OGL
  // credit (invariant 4 lives on the page, not in the chrome).
  if (chapter?.mapPage && Dashboard) {
    return (
      <>
        {rail}
        <div className="page map-page">
          <ErrorBoundary key={dashboardId}>
            <Suspense fallback={null}>
              <Dashboard />
            </Suspense>
          </ErrorBoundary>
        </div>
      </>
    );
  }

  return (
    <>
      {rail}

      <div className="page">
        <div className={chapter?.wide ? "container wide" : "container"}>
          {/* Mobile-only: the rail (and its masthead) hides below 880px,
              so the header steps back in there. */}
          <header className="site-header">
            <div className="masthead-row">
              <h1>
                <a href="#/">UK Open Data Explorer</a>
              </h1>
              {compiled && (
                <span className="edition">Compiled {fmtDate(compiled)}</span>
              )}
            </div>
            <p className="strap">{strap}</p>
          </header>

          <details className="contents-pocket">
            <summary>Content</summary>
            {contents}
          </details>

          <main>
          {ChartsGallery && hash === "#/charts-template" ? (
            <ErrorBoundary>
              <Suspense fallback={<p className="muted">Loading…</p>}>
                <ChartsGallery />
              </Suspense>
            </ErrorBoundary>
          ) : chapter && Dashboard ? (
            <>
              <div className="chapter-head">
                <p className="chapter-kicker">{chapter.topic}</p>
                {chapterMeta && <p className="chapter-meta">{chapterMeta}</p>}
              </div>
              {/* No fallback text: the chunk is small, and the dashboard
                  typesets itself immediately with per-slot loading states —
                  a flash of "Loading…" here would just be clutter. */}
              <ErrorBoundary key={dashboardId}>
                <Suspense fallback={null}>
                  <Dashboard />
                </Suspense>
              </ErrorBoundary>
            </>
          ) : dashboardId ? (
            <div className="notice">
              No dashboard called “{dashboardId}”. Pick one from the list, or
              go <a href="#/">back to the start</a>.
            </div>
          ) : (
            <HomePage />
          )}
          </main>

          <footer className="site-footer">
            Compiled weekly by{" "}
            <a href={PIPELINE_REPO_URL}>
              {PIPELINE_REPO_URL.replace("https://", "")}
            </a>
            {" · "}
            datasets at{" "}
            <a href={`https://huggingface.co/${HF_NAMESPACE}`}>
              huggingface.co/{HF_NAMESPACE}
            </a>
            {" · "}
            contains public sector information licensed under the{" "}
            <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/">
              Open Government Licence v3.0
            </a>
            .
          </footer>
        </div>
      </div>
    </>
  );
}
