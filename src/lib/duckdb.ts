/**
 * DuckDB-Wasm singleton.
 *
 * The wasm modules and workers are bundled from node_modules via Vite's
 * `?url` imports — no CDN at runtime, the site is fully self-hosted.
 * Queries hit the published parquets over HTTPS; DuckDB issues Range
 * requests, so a filtered query reads row groups, not whole files.
 */
import * as duckdb from "@duckdb/duckdb-wasm";
import wasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import workerMvp from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import wasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import workerEh from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;
let connPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;

/**
 * Loading status, for the per-component loading panels. DuckDB-Wasm has
 * no real query-progress API, so this reports only what is honestly
 * known: whether the engine is still instantiating, and whether queries
 * are in flight. The object is replaced (never mutated) on change so it
 * can back useSyncExternalStore.
 */
export interface DuckDbStatus {
  engineReady: boolean;
  inFlight: number;
}

let status: DuckDbStatus = { engineReady: false, inFlight: 0 };
const statusListeners = new Set<() => void>();

function setStatus(patch: Partial<DuckDbStatus>): void {
  status = { ...status, ...patch };
  statusListeners.forEach((fn) => fn());
}

export function getDuckDbStatus(): DuckDbStatus {
  return status;
}

export function subscribeDuckDbStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

async function init(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: wasmMvp, mainWorker: workerMvp },
    eh: { mainModule: wasmEh, mainWorker: workerEh },
  });
  const worker = new Worker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return db;
}

export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) {
    dbPromise = init().then((db) => {
      setStatus({ engineReady: true });
      return db;
    });
  }
  return dbPromise;
}

function getConn(): Promise<duckdb.AsyncDuckDBConnection> {
  if (!connPromise) connPromise = getDb().then((db) => db.connect());
  return connPromise;
}

/**
 * Run a query and return plain JS row objects.
 *
 * Arrow gives BigInt for 64-bit integer columns; charts and formatters
 * choke on BigInt, so convert to Number here (all published counts are
 * far below Number.MAX_SAFE_INTEGER).
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  setStatus({ inFlight: status.inFlight + 1 });
  try {
    const conn = await getConn();
    const result = await conn.query(sql);
    return result.toArray().map((row) => {
      const obj = row.toJSON() as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === "bigint") obj[key] = Number(obj[key]);
      }
      return obj as T;
    });
  } finally {
    setStatus({ inFlight: status.inFlight - 1 });
  }
}

/**
 * Run a query and return the raw Arrow table — the columnar path for
 * row-scale results (the trees map pulls ~1.1M coordinate rows per
 * interaction; materialising those as JS objects via query() would cost
 * seconds and hundreds of MB, while Arrow hands back typed arrays).
 * Callers own the type discipline query() normally provides: 64-bit
 * integer columns come back as BigInt64Array — cast columns to
 * SMALLINT/INTEGER/DOUBLE in SQL so the typed arrays are usable as-is.
 */
export async function queryArrow(
  sql: string,
): Promise<import("apache-arrow").Table> {
  setStatus({ inFlight: status.inFlight + 1 });
  try {
    const conn = await getConn();
    return await conn.query(sql);
  } finally {
    setStatus({ inFlight: status.inFlight - 1 });
  }
}

/**
 * Load a small published parquet into a DuckDB-memory table, once per
 * session — the small-file tier of the two-tier query pattern (CLAUDE.md
 * · Query discipline). Pay one file-sized fetch at dashboard load, then
 * every interaction queries memory: zero network per click. Callers pass
 * the full SELECT so the projection is explicit — never load columns the
 * dashboard won't use.
 */
const tablePromises = new Map<string, Promise<void>>();

export function loadTable(name: string, selectSql: string): Promise<void> {
  let p = tablePromises.get(name);
  if (!p) {
    p = query(`CREATE TABLE "${name}" AS ${selectSql}`).then(() => undefined);
    // A failed load (offline, HF hiccup) must not poison the session —
    // forget it so the next mount retries.
    p.catch(() => tablePromises.delete(name));
    tablePromises.set(name, p);
  }
  return p;
}
