import { render } from "preact";
import { App } from "./App";
import { createWebBackend } from "./runtime/web-backend";

// Phase 1 entry point: resolve the inference backend (WebGPU, or a clean WASM
// fallback) and mount the segmentation app. The page must be cross-origin
// isolated for ORT Web's threaded WASM backend (see scripts/serve.ts).
async function start() {
  const root = document.getElementById("app");
  if (root === null) {
    return;
  }
  if (!crossOriginIsolated) {
    render(
      <p>
        This page is not cross-origin isolated; the WASM backend needs COOP/COEP
        headers. See scripts/serve.ts / netlify.toml.
      </p>,
      root,
    );
    return;
  }
  const backend = await createWebBackend();
  render(<App backend={backend} />, root);
}

start();
