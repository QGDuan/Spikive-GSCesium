import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseVersion = process.env.RELEASE_VERSION ?? `v${JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version}`;
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) {
  throw new Error("RELEASE_VERSION 必须类似 v0.1.0-beta.1");
}

const releaseTarget = process.env.RELEASE_TARGET;
const targetConfigs = {
  "macos-arm64": {
    suffix: "macos-apple-silicon",
    readme: "packaging/customer/README.macos.md",
    launchers: [
      ["packaging/customer/install.sh", "install.sh"],
      ["packaging/customer/start.sh", "start.sh"]
    ]
  },
  "windows-x64": {
    suffix: "windows-x64",
    readme: "packaging/customer/README.windows.md",
    launchers: [
      ["packaging/customer/install.cmd", "install.cmd"],
      ["packaging/customer/start.cmd", "start.cmd"]
    ]
  }
};
const targetConfig = targetConfigs[releaseTarget];
if (!targetConfig) {
  throw new Error(`RELEASE_TARGET 必须是以下值之一：${Object.keys(targetConfigs).join("、")}`);
}

const directoryOnly = process.env.CUSTOMER_PACKAGE_DIRECTORY_ONLY === "true";
const packageName = `Spikive-GS-Inspector-${releaseVersion}-${targetConfig.suffix}`;
const releaseDir = path.join(projectRoot, "release");
const stageRoot = path.join(releaseDir, ".customer-package-stage");
const packageRoot = path.join(stageRoot, packageName);
const archivePath = path.join(releaseDir, `${packageName}.zip`);
const checksumPath = `${archivePath}.sha256`;

const requiredBuildFiles = [
  "apps/server/dist/index.js",
  "apps/web/dist/index.html",
  "packages/shared/dist/index.js"
];
for (const relative of requiredBuildFiles) {
  await readFile(path.join(projectRoot, relative));
}

await mkdir(releaseDir, { recursive: true });
await rm(stageRoot, { recursive: true, force: true });
await rm(archivePath, { force: true });
await rm(checksumPath, { force: true });
await mkdir(packageRoot, { recursive: true });

const copyEntries = [
  ["package.json", "package.json"],
  ["package-lock.json", "package-lock.json"],
  ["apps/server/package.json", "apps/server/package.json"],
  ["apps/server/dist", "apps/server/dist"],
  ["apps/web/package.json", "apps/web/package.json"],
  ["apps/web/dist", "apps/web/dist"],
  ["packages/shared/package.json", "packages/shared/package.json"],
  ["packages/shared/dist", "packages/shared/dist"],
  ["docs/CUSTOMER_GUIDE.md", "USER_GUIDE.md"],
  ["docs/THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  [targetConfig.readme, "README.md"],
  ...targetConfig.launchers
];

for (const [source, destination] of copyEntries) {
  const target = path.join(packageRoot, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(projectRoot, source), target, { recursive: true });
}

async function removeCompiledTests(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await removeCompiledTests(entryPath);
    else if (entry.name.includes(".test.")) await rm(entryPath, { force: true });
  }
}
await removeCompiledTests(path.join(packageRoot, "apps", "server", "dist"));
await removeCompiledTests(path.join(packageRoot, "packages", "shared", "dist"));
await mkdir(path.join(packageRoot, "var"), { recursive: true });
await writeFile(path.join(packageRoot, "var", ".gitkeep"), "");
if (releaseTarget === "macos-arm64") {
  await chmod(path.join(packageRoot, "install.sh"), 0o755);
  await chmod(path.join(packageRoot, "start.sh"), 0o755);
}

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
await writeFile(path.join(packageRoot, "release-manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  product: "Spikive GS Inspector",
  version: releaseVersion,
  commit,
  packageType: "platform-online-installer",
  target: releaseTarget,
  nodeRequirement: ">=22.22.1",
  includesBusinessData: false,
  builtAt: new Date().toISOString()
}, null, 2)}\n`);

const forbiddenNames = new Set(["platform.sqlite", ".env", ".env.local"]);
async function assertCleanPackage(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (forbiddenNames.has(entry.name) || entry.name.endsWith(".ply") || entry.name === "node_modules") {
      throw new Error(`客户包包含禁止内容：${path.relative(packageRoot, path.join(directory, entry.name))}`);
    }
    if (entry.isDirectory()) await assertCleanPackage(path.join(directory, entry.name));
  }
}
await assertCleanPackage(packageRoot);

if (directoryOnly) {
  console.log(`客户测试包目录：${packageRoot}`);
  process.exit(0);
}

execFileSync("/usr/bin/zip", ["-X", "-q", "-r", archivePath, packageName], { cwd: stageRoot, stdio: "inherit" });
const checksum = createHash("sha256").update(await readFile(archivePath)).digest("hex");
await writeFile(checksumPath, `${checksum}  ${path.basename(archivePath)}\n`);
await rm(stageRoot, { recursive: true, force: true });

console.log(`客户测试包：${archivePath}`);
console.log(`SHA-256：${checksum}`);
