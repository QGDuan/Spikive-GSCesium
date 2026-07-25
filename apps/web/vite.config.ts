import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { CESIUM_GS_REVEAL_PATCH_VERSION } from "./src/cesium-patch-version";

// Bump with the audited Cesium engine patch so Vite invalidates any optimized
// dependency bundle produced from an older Gaussian Shader extension.
export default defineConfig(({ command }) => ({
  // Cesium is patched in-place before Vite starts. Version the optimizer cache
  // with that patch so an already-running workspace cannot serve stale engine code.
  cacheDir: `node_modules/.vite-spikive-gs-v${CESIUM_GS_REVEAL_PATCH_VERSION}`,
  define: {
    CESIUM_BASE_URL: JSON.stringify(command === "serve" ? "/" : "/cesium"),
    __SPIKIVE_CESIUM_GS_REVEAL_PATCH_VERSION__: JSON.stringify(CESIUM_GS_REVEAL_PATCH_VERSION)
  },
  publicDir: command === "serve" ? "../../node_modules/cesium/Build/Cesium" : false,
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:3000", "/healthz": "http://localhost:3000" } },
  build: {
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/cesium/") || id.includes("/node_modules/@cesium/")) return "cesium";
        }
      }
    }
  }
}));
