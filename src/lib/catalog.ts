/**
 * Client for the pipeline repo's catalog.json — the machine-readable index
 * of everything published: per-file sha256, sizes, timestamps, row-count
 * stats, and source/family health. Fetched at runtime so the site reflects
 * each weekly pipeline run without a redeploy.
 *
 * The catalog is metadata only. If it is unreachable the dashboards still
 * work (they query Hugging Face directly); only freshness/health chrome
 * degrades. Keep it that way.
 */

export const HF_NAMESPACE = "jhumbl";

export const PIPELINE_REPO_URL = "https://github.com/jhumbl/uk-open-data";

export const CATALOG_URL =
  "https://raw.githubusercontent.com/jhumbl/uk-open-data/main/catalog.json";

/** Stable "latest" URL for a published file (same pattern the pipeline documents). */
export function hfFileUrl(family: string, filename: string): string {
  return `https://huggingface.co/datasets/${HF_NAMESPACE}/${family}/resolve/main/${filename}`;
}

export function hfRepoUrl(family: string): string {
  return `https://huggingface.co/datasets/${HF_NAMESPACE}/${family}`;
}

export interface CatalogFileStats {
  row_count: number;
  min_period?: string;
  max_period?: string;
}

export interface CatalogFile {
  download_url: string;
  fetched_from?: string;
  first_seen: string;
  hf_repo: string;
  last_changed: string;
  last_checked: string;
  sha256: string;
  size_bytes: number;
  source: string;
  stats?: CatalogFileStats;
}

export interface CatalogFamily {
  consecutive_failures: number;
  last_synced?: string;
  last_tag?: string;
  repo_url: string;
  revision?: string;
  status: string; // "ok" | "sync_failed"
}

export interface CatalogSource {
  consecutive_failures: number;
  last_success?: string;
  last_failure?: string;
  last_error?: string;
  status: string; // "ok" | "fetch_failed" | "validation_failed" | "config_failed"
}

export interface Catalog {
  datasets: Record<string, CatalogFile>;
  families: Record<string, CatalogFamily>;
  sources: Record<string, CatalogSource>;
}

let catalogPromise: Promise<Catalog> | null = null;

export function fetchCatalog(): Promise<Catalog> {
  if (!catalogPromise) {
    catalogPromise = fetch(CATALOG_URL).then((res) => {
      if (!res.ok) throw new Error(`catalog.json fetch failed: HTTP ${res.status}`);
      return res.json() as Promise<Catalog>;
    });
    // Allow a retry on the next call rather than caching the failure.
    catalogPromise.catch(() => {
      catalogPromise = null;
    });
  }
  return catalogPromise;
}
