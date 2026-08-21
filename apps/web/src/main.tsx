import { createRoot } from "react-dom/client";

// Cesium owns a WebGL renderer with an imperative destroy lifecycle. React's
// development StrictMode intentionally mounts, destroys and mounts components
// again, which can leave work queued by the first Cesium Viewer touching
// already-destroyed GPU resources while the replacement Viewer is rendering.
const root = createRoot(document.getElementById("root")!);
if (window.location.pathname === "/renderer-lab" || window.location.pathname.startsWith("/renderer-lab/")) {
  void import("./RendererLabApp").then(({ default: RendererLabApp }) => root.render(<RendererLabApp />));
} else {
  void import("./App").then(({ default: App }) => root.render(<App />));
}
