#!/usr/bin/env node
/**
 * Consumer-path smoke test — this site's equivalent of the pipeline repo's
 * smoke_test.py, checking the promises THIS repo depends on:
 *
 *   1. catalog.json is reachable from raw.githubusercontent.com with CORS
 *      (the site fetches it at runtime for the catalogue page);
 *   2. the published parquets answer HTTP Range requests with CORS
 *      (the DuckDB-Wasm consumer path).
 *
 * Runs before every deploy and weekly on a schedule. Never weaken it to
 * make a run green — a failure here means the deployed site is broken for
 * real visitors even though every file "exists".
 */

const CATALOG_URL =
  "https://raw.githubusercontent.com/jhumbl/uk-open-data/main/catalog.json";

// Any origin works for the check; use the real one the site serves from.
const ORIGIN = "https://jhumbl.github.io";

const failures = [];

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function corsOk(res) {
  const acao = res.headers.get("access-control-allow-origin");
  return acao === "*" || acao === ORIGIN;
}

// --- 1. catalog.json: reachable, CORS, parseable, non-empty ---------------

const catRes = await fetch(CATALOG_URL, { headers: { Origin: ORIGIN } });
check("catalog.json HTTP 200", catRes.status === 200, `status ${catRes.status}`);
check(
  "catalog.json CORS header",
  corsOk(catRes),
  `access-control-allow-origin: ${catRes.headers.get("access-control-allow-origin")}`,
);

const catalog = await catRes.json();
const files = Object.values(catalog.datasets ?? {});
check("catalog lists datasets", files.length > 0, `${files.length} files`);

// --- 2. Range + CORS on a parquet (the DuckDB-Wasm consumer path) ---------
// Smallest parquet keeps the check fast; the serving behaviour is per-host,
// not per-file, and the pipeline's own smoke test covers every URL.

const parquets = files
  .filter((f) => f.download_url.endsWith(".parquet"))
  .sort((a, b) => a.size_bytes - b.size_bytes);
check("catalog lists parquets", parquets.length > 0);

if (parquets.length > 0) {
  const target = parquets[0];
  console.log(`      (range-checking ${target.download_url})`);
  const res = await fetch(target.download_url, {
    headers: { Origin: ORIGIN, Range: "bytes=0-127" },
  });
  check("parquet Range request → 206", res.status === 206, `status ${res.status}`);
  check(
    "parquet CORS header",
    corsOk(res),
    `access-control-allow-origin: ${res.headers.get("access-control-allow-origin")}`,
  );
  const buf = new Uint8Array(await res.arrayBuffer());
  check("Range honoured (128 bytes back)", buf.length === 128, `${buf.length} bytes`);
  const magic = String.fromCharCode(...buf.slice(0, 4));
  check("parquet magic bytes 'PAR1'", magic === "PAR1", JSON.stringify(magic));
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
