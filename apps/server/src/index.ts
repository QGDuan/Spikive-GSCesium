import { buildApp } from "./app.js";
import { config } from "./config.js";

const { app, worker } = await buildApp();
worker.start();
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
await app.listen({ host: config.host, port: config.port });
