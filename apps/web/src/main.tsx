import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root")!);
void import("./App").then(({ default: App }) => root.render(<App />));
