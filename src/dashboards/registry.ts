import type { ComponentType } from "react";

/**
 * The dashboard catalogue. One entry per dashboard; each dashboard lives in
 * its own folder under src/dashboards/ and is lazy-loaded, so a heavy or
 * broken dashboard costs nothing until it is opened.
 *
 * `files` are the published filenames the dashboard reads — used to pull
 * row counts / freshness for its catalogue card out of catalog.json.
 */
export interface DashboardMeta {
  id: string;
  title: string;
  /** Topic tag — groups entries in the rail and appears above the
      dashboard title, e.g. "Vehicles". */
  topic: string;
  /** Muted source line under the rail title — publisher · table ·
      cadence, e.g. "DfT · VEH0105 · quarterly". Name the publisher of
      the dataset, not where its records originate (VEH0105 is DfT's
      table, built from DVLA data). Keep it to three short segments; it
      has one line in the rail. */
  source: string;
  /** The one question the dashboard answers — surfaced as the tooltip on
      its contents entry. A dashboard that can't state its question isn't
      one. */
  question: string;
  /** One-or-two-sentence honest description. Not currently rendered —
      it documents the dashboard here in the registry. */
  blurb: string;
  /** HF family repo the dashboard's data lives in (catalog.json key). */
  family: string;
  /** Published filenames this dashboard queries. */
  files: string[];
  /** Multi-facet (cross-filter) dashboards opt into the wide container
      + .dash-grid layout so linked charts share a screen; single-chart
      dashboards keep the site's 800px reading measure. */
  wide?: boolean;
  /** Map-first dashboards (DRAFT archetype, 2026-07-17): the map fills
      the viewport and the dashboard renders its own side panel — App
      swaps the container/header/footer chrome for the .map-page split.
      The dashboard component renders `.map-panel` + `.map-stage` as
      siblings. */
  mapPage?: boolean;
  load: () => Promise<{ default: ComponentType }>;
}

export const DASHBOARDS: DashboardMeta[] = [
  {
    id: "vehicle-fleet",
    title: "Licensed vehicles",
    topic: "Vehicles",
    source: "DfT · VEH0105 · quarterly",
    question:
      "How many vehicles are on UK roads — of what kind, running on what, kept by whom, and where?",
    blurb:
      "Every licensed vehicle in the UK, quarterly since 2009, from DVLA registration data (VEH0105) — the whole fleet sliceable by body type, fuel, keepership and area.",
    family: "dft-vehicle-licensing",
    files: ["dft_veh0105_licensed_by_la.parquet"],
    wide: true,
    load: () => import("./vehicle-fleet/VehicleFleetDashboard"),
  },
  {
    id: "ulev-uptake",
    title: "Ultra low emission vehicles",
    topic: "Vehicles",
    source: "DfT · VEH0132 · quarterly",
    question:
      "How fast is the switch to electric happening — and where, in what form, and kept by whom?",
    blurb:
      "Licensed ultra low emission vehicles, quarterly since 2011, from DVLA registration data — sliceable by fuel, keepership and region, with rates against the whole fleet (VEH0105).",
    family: "dft-vehicle-licensing",
    files: [
      "dft_veh0132_ulev_by_la.parquet",
      "dft_veh0105_licensed_by_la.parquet",
    ],
    wide: true,
    load: () => import("./ulev-uptake/UlevUptakeDashboard"),
  },
  {
    id: "london-trees",
    title: "London’s public trees",
    topic: "Environment",
    source: "GLA / GiGL · public realm trees · occasional",
    question:
      "What is growing on London’s streets and in its parks — and how will it cope with the 2090 climate?",
    blurb:
      "Every tree in the GLA’s public-realm inventory — 1.14 million street, park and estate trees — on one map, coloured by kind or by the GLA’s 2090 climate-suitability assessment. The map-first draft.",
    family: "gla-trees",
    files: ["gla_public_realm_trees.parquet"],
    mapPage: true,
    load: () => import("./london-trees/TreesDashboard"),
  },
  {
    id: "food-hygiene-london",
    title: "Food hygiene in London",
    topic: "Food safety",
    source: "FSA · FHRS · current ratings",
    question:
      "Where in London — and in what kinds of places — are good and bad hygiene ratings concentrated?",
    blurb:
      "The FSA's currently published rating for every listed establishment across the 33 London authorities. The cross-filter pilot: every chart filters the others over one in-memory table.",
    family: "fsa-food-hygiene-london",
    files: ["fsa_fhrs_london_food_hygiene.parquet"],
    wide: true,
    load: () => import("./food-hygiene-london/FoodHygieneDashboard"),
  },
];
