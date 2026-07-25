import { createRoot } from "react-dom/client";
import App from "./App";

// Cesium owns a WebGL renderer with an imperative destroy lifecycle. React's
// development StrictMode intentionally mounts, destroys and mounts components
// again, which can leave work queued by the first Cesium Viewer touching
// already-destroyed GPU resources while the replacement Viewer is rendering.
createRoot(document.getElementById("root")!).render(<App />);
