import { DASHBOARDS, type DashboardMeta } from "../dashboards/registry";
import type { Catalog } from "../lib/catalog";

/**
 * The dashboard list — rendered in the desktop rail and the mobile
 * pocket. Entries are the dashboard titles (the dataset being explored)
 * over a muted publisher · table · cadence line, grouped by topic in
 * registry order, with the question the dashboard answers as a tooltip;
 * a source problem shows a dot, health stays silent.
 */

interface Group {
  topic: string;
  items: DashboardMeta[];
}

const GROUPS: Group[] = DASHBOARDS.reduce<Group[]>((groups, d) => {
  const last = groups[groups.length - 1];
  if (last && last.topic === d.topic) last.items.push(d);
  else groups.push({ topic: d.topic, items: [d] });
  return groups;
}, []);

export default function ContentsList({
  activeId,
  catalog,
}: {
  activeId: string | null;
  catalog: Catalog | null;
}) {
  return (
    <>
      {GROUPS.map((g) => (
        <div key={g.topic}>
          <p className="rail-group">{g.topic}</p>
          {g.items.map((d) => {
            const unhealthy =
              catalog !== null && catalog.families[d.family]?.status !== "ok";
            return (
              <a
                key={d.id}
                className="rail-entry"
                aria-current={activeId === d.id ? "page" : undefined}
                href={`#/d/${d.id}`}
                title={d.question}
              >
                <span className="rail-title">
                  {d.title}
                  {unhealthy && (
                    <span
                      className="status-dot bad"
                      title="Source has a problem — data may be stale"
                    />
                  )}
                </span>
                <span className="rail-source">{d.source}</span>
              </a>
            );
          })}
        </div>
      ))}
    </>
  );
}
