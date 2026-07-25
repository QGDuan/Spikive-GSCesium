import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const root = path.resolve(projectRoot, process.env.DATA_DIR ?? "var");

function numberFromEnv(name: string, fallback: number, options: { integer?: boolean; minimum: number; maximum: number }) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  const valid = Number.isFinite(value)
    && (!options.integer || Number.isInteger(value))
    && value >= options.minimum
    && value <= options.maximum;
  if (!valid) throw new Error(`${name} 必须是 ${options.minimum}～${options.maximum} 范围内的${options.integer ? "整数" : "数字"}`);
  return value;
}

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: numberFromEnv("PORT", 3000, { integer: true, minimum: 1, maximum: 65_535 }),
  dataDir: root,
  dbPath: path.join(root, "platform.sqlite"),
  uploadsDir: path.join(root, "uploads"),
  sourcesDir: path.join(root, "sources"),
  workDir: path.join(root, "work"),
  publishedDir: path.join(root, "published"),
  maxUploadBytes: numberFromEnv("MAX_UPLOAD_BYTES", 5 * 1024 ** 3, { integer: true, minimum: 1, maximum: 5 * 1024 ** 3 }),
  collisionCacheBytes: numberFromEnv("COLLISION_CACHE_BYTES", 512 * 1024 ** 2, { integer: true, minimum: 1024 ** 2, maximum: 8 * 1024 ** 3 }),
  conversionEnabled: process.env.CONVERSION_ENABLED !== "false",
  gpuDevice: process.env.GPU_DEVICE ?? "0"
};
