import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "node_modules/cesium/Build/Cesium");
const destination = path.join(projectRoot, "apps/web/dist/cesium");
await mkdir(destination, { recursive: true });
await Promise.all(["Workers", "ThirdParty", "Assets", "Widgets"].map(name => cp(path.join(source, name), path.join(destination, name), { recursive: true, force: true })));
