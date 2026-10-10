# UK Open Data Explorer

A catalogue of small dashboards over curated UK public datasets. Every
chart is computed **in your browser** with
[DuckDB-Wasm](https://github.com/duckdb/duckdb-wasm), querying parquet
files served from Hugging Face — there is no backend.

The data comes from the [uk-open-data](https://github.com/jhumbl/uk-open-data)
pipeline, which re-fetches each source weekly, tidies it into
analysis-ready parquet, validates it against a declared schema, and
publishes it at stable URLs. This site is a pure consumer of that
contract.

## Develop

    npm install
    npm run dev        # dev server (queries hit the real published data)
    npm run build      # typecheck + production build
    npm run smoke      # verify the data-serving contract (CORS + Range)

## Deploy

Pushing to `main` builds and deploys to GitHub Pages via
`.github/workflows/deploy.yml` — after a one-time setting: repo
**Settings → Pages → Source = "GitHub Actions"**. Nothing generated is
ever committed.

## Licence

Dashboard code: [MIT](LICENSE). The data contains public sector
information licensed under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/);
each dashboard links its dataset's Hugging Face repo and original
publisher.
