// Must stay the first import — see the note inside.
import "./devPerfGuard";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// Inter (variable) — the one typeface, self-hosted like everything else.
import "@fontsource-variable/inter";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
