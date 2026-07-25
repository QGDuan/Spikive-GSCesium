#!/usr/bin/env node

import { access, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const projectRoot = path.resolve(import.meta.dirname, "..");
const dataDir = path.resolve(projectRoot, process.env.DATA_DIR ?? "var");
const dbPath = path.join(dataDir, "platform.sqlite");
const findings = [];

const exists = async filename => {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
};

const addFinding = (code, message) => findings.push({ code, message });

const parseIdList = (value, owner) => {
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed) || parsed.some(id => typeof id !== "string")) {
      addFinding("INVALID_LABEL_IDS", `${owner} 的 label_ids 不是字符串数组`);
      return [];
    }
    return parsed;
  } catch {
    addFinding("INVALID_LABEL_IDS", `${owner} 的 label_ids 不是有效 JSON`);
    return [];
  }
};

const listChildren = async directory => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
};

if (!(await exists(dbPath))) {
  console.log(`数据审计跳过：${dbPath} 尚不存在`);
  process.exit(0);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const integrity = db.prepare("PRAGMA quick_check").all();
  for (const row of integrity) {
    if (row.quick_check !== "ok") addFinding("SQLITE_INTEGRITY", String(row.quick_check));
  }
  for (const row of db.prepare("PRAGMA foreign_key_check").all()) {
    addFinding("FOREIGN_KEY", JSON.stringify(row));
  }

  const datasets = db.prepare("SELECT id, status, collision_status FROM datasets").all();
  const labels = db.prepare("SELECT id, dataset_id FROM labels").all();
  const missions = db.prepare("SELECT id, dataset_id, start_label_id, label_ids, status FROM missions").all();
  const waypoints = db.prepare(`
    SELECT w.id, w.mission_id, w.target_label_id, m.dataset_id, m.label_ids
    FROM waypoints w
    LEFT JOIN missions m ON m.id = w.mission_id
  `).all();

  const datasetIds = new Set(datasets.map(row => String(row.id)));
  const labelsById = new Map(labels.map(row => [String(row.id), String(row.dataset_id)]));
  const missionLabelIds = new Map();

  for (const label of labels) {
    if (!datasetIds.has(String(label.dataset_id))) {
      addFinding("ORPHAN_LABEL", `标签 ${label.id} 引用了不存在的数据集 ${label.dataset_id}`);
    }
  }

  for (const mission of missions) {
    const missionId = String(mission.id);
    const datasetId = String(mission.dataset_id);
    const labelIds = parseIdList(mission.label_ids, `任务 ${missionId}`);
    const startLabelId = mission.start_label_id == null ? null : String(mission.start_label_id);
    const referencedLabelIds = startLabelId ? [startLabelId, ...labelIds] : labelIds;
    missionLabelIds.set(missionId, new Set(referencedLabelIds));
    if (!datasetIds.has(datasetId)) {
      addFinding("ORPHAN_MISSION", `任务 ${missionId} 引用了不存在的数据集 ${datasetId}`);
    }
    if (new Set(labelIds).size !== labelIds.length) {
      addFinding("DUPLICATE_MISSION_LABEL", `任务 ${missionId} 包含重复标签`);
    }
    if (startLabelId && labelIds.includes(startLabelId)) {
      addFinding("DUPLICATE_START_LABEL", `任务 ${missionId} 的起点标签在巡检顺序中重复出现`);
    }
    for (const labelId of referencedLabelIds) {
      const ownerDatasetId = labelsById.get(labelId);
      if (!ownerDatasetId) addFinding("MISSING_MISSION_LABEL", `任务 ${missionId} 引用了不存在的标签 ${labelId}`);
      else if (ownerDatasetId !== datasetId) addFinding("CROSS_DATASET_LABEL", `任务 ${missionId} 跨场景引用了标签 ${labelId}`);
    }
  }

  for (const waypoint of waypoints) {
    const missionId = String(waypoint.mission_id);
    if (waypoint.dataset_id == null) {
      addFinding("ORPHAN_WAYPOINT", `航迹点 ${waypoint.id} 引用了不存在的任务 ${missionId}`);
      continue;
    }
    if (waypoint.target_label_id == null) continue;
    const targetLabelId = String(waypoint.target_label_id);
    const labelDatasetId = labelsById.get(targetLabelId);
    if (!labelDatasetId) addFinding("MISSING_WAYPOINT_LABEL", `航迹点 ${waypoint.id} 引用了不存在的标签 ${targetLabelId}`);
    else if (labelDatasetId !== String(waypoint.dataset_id)) addFinding("CROSS_DATASET_WAYPOINT", `航迹点 ${waypoint.id} 跨场景引用了标签 ${targetLabelId}`);
    if (!missionLabelIds.get(missionId)?.has(targetLabelId)) {
      addFinding("UNBOUND_WAYPOINT_LABEL", `航迹点 ${waypoint.id} 的目标标签不在任务 ${missionId} 的标签序列中`);
    }
  }

  const requiredReadyArtifacts = [
    ["tiles", "tileset.json"],
    ["tiles", "build_summary.json"],
    ["collision", "scene.voxel.json"],
    ["collision", "scene.voxel.bin"],
    ["collision", "scene.collision.glb"]
  ];
  for (const dataset of datasets) {
    const datasetId = String(dataset.id);
    const status = String(dataset.status);
    if (["queued", "tiling", "collision_processing", "rebuilding", "ready", "failed"].includes(status)) {
      const source = path.join(dataDir, "sources", `${datasetId}.ply`);
      if (!(await exists(source))) addFinding("MISSING_SOURCE", `数据集 ${datasetId} 缺少受管源文件`);
    }
    if (["rebuilding", "ready"].includes(status)) {
      if (String(dataset.collision_status) !== "ready") {
        addFinding("STATE_MISMATCH", `数据集 ${datasetId} 已 ready，但碰撞状态不是 ready`);
      }
      for (const parts of requiredReadyArtifacts) {
        const artifact = path.join(dataDir, "published", datasetId, ...parts);
        if (!(await exists(artifact))) addFinding("MISSING_ARTIFACT", `数据集 ${datasetId} 缺少 ${parts.join("/")}`);
      }
    }
  }

  for (const entry of await listChildren(path.join(dataDir, "sources"))) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".ply") continue;
    const id = path.basename(entry.name, path.extname(entry.name));
    if (!datasetIds.has(id)) addFinding("ORPHAN_SOURCE", `源文件 ${entry.name} 没有对应数据集记录`);
  }
  for (const area of ["work", "published"]) {
    for (const entry of await listChildren(path.join(dataDir, area))) {
      if (entry.isDirectory() && !datasetIds.has(entry.name)) {
        addFinding("ORPHAN_DIRECTORY", `${area}/${entry.name} 没有对应数据集记录`);
      }
    }
  }

  console.log(`数据审计：${datasets.length} 个数据集，${labels.length} 个标签，${missions.length} 个任务，${waypoints.length} 个航迹点`);
  if (findings.length === 0) {
    console.log("数据依赖与存储一致性检查通过");
  } else {
    for (const finding of findings) console.error(`[${finding.code}] ${finding.message}`);
    console.error(`数据审计失败：发现 ${findings.length} 个问题；未执行自动删除或修复`);
    process.exitCode = 1;
  }
} finally {
  db.close();
}
