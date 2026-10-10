import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base MUST match the GitHub Pages project path:
// https://<user>.github.io/uk-open-data-explorer/
// If the repo is ever renamed or moved to a custom domain, change this
// or every asset 404s on Pages (dev server is unaffected either way).
export default defineConfig({
  base: "/uk-open-data-explorer/",
  plugins: [react()],
});
