#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
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

  const datasets = db.prepare("SELECT id, status, collision_status, active_visual_revision, lod_policy_version, visual_backend, aholo_visual_revision, aholo_policy_version, visual_build_target FROM datasets").all();
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

  const requiredCollisionArtifacts = [
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
      for (const parts of requiredCollisionArtifacts) {
        const artifact = path.join(dataDir, "published", datasetId, ...parts);
        if (!(await exists(artifact))) addFinding("MISSING_ARTIFACT", `数据集 ${datasetId} 缺少 ${parts.join("/")}`);
      }
      const datasetRoot = path.join(dataDir, "published", datasetId);
      const manifestPath = path.join(datasetRoot, "artifact-manifest.json");
      if (await exists(manifestPath)) {
        try {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          const active = Array.isArray(manifest.visualRevisions)
            ? manifest.visualRevisions.find(value => value?.revision === manifest.activeVisualRevision)
            : null;
          if (!active || typeof active.relativeTilesPath !== "string") {
            addFinding("INVALID_VISUAL_MANIFEST", `数据集 ${datasetId} 的活动视觉 revision 无效`);
          } else {
            const manifestRevisionIds = new Set(manifest.visualRevisions.map(value => String(value.revision)));
            if (String(dataset.active_visual_revision ?? "") !== String(active.revision)) {
              addFinding("VISUAL_REVISION_MISMATCH", `数据集 ${datasetId} 的数据库活动 revision 与 manifest 不一致`);
            }
            if (String(dataset.lod_policy_version ?? "") !== String(active.policyVersion ?? "")) {
              addFinding("LOD_POLICY_MISMATCH", `数据集 ${datasetId} 的数据库 LOD 策略与 manifest 不一致`);
            }
            for (const name of ["tileset.json", "build_summary.json"]) {
              if (!(await exists(path.join(datasetRoot, active.relativeTilesPath, name)))) {
                addFinding("MISSING_VISUAL_ARTIFACT", `数据集 ${datasetId} 的活动视觉 revision 缺少 ${name}`);
              }
            }
            if (active.lodReportPath && !(await exists(path.join(datasetRoot, active.lodReportPath)))) {
              addFinding("MISSING_LOD_REPORT", `数据集 ${datasetId} 的活动视觉 revision 缺少 LOD 报告`);
            }
            for (const entry of await listChildren(path.join(datasetRoot, "visual-revisions"))) {
              if (entry.isDirectory() && !manifestRevisionIds.has(entry.name)) {
                addFinding("ORPHAN_VISUAL_REVISION", `数据集 ${datasetId} 的 visual-revisions/${entry.name} 不在 manifest 中`);
              }
            }
          }
        } catch (error) {
          addFinding("INVALID_VISUAL_MANIFEST", `数据集 ${datasetId} 的 artifact manifest 无法读取：${String(error)}`);
        }
      } else {
        for (const name of ["tileset.json", "build_summary.json"]) {
          if (!(await exists(path.join(datasetRoot, "tiles", name)))) {
            addFinding("MISSING_ARTIFACT", `数据集 ${datasetId} 缺少 legacy tiles/${name}`);
          }
        }
      }
      const aholoManifestPath = path.join(datasetRoot, "aholo-artifact-manifest.json");
      if (await exists(aholoManifestPath)) {
        try {
          const manifest = JSON.parse(await readFile(aholoManifestPath, "utf8"));
          const active = Array.isArray(manifest.revisions)
            ? manifest.revisions.find(value => value?.revision === manifest.activeRevision)
            : null;
          if (!active || typeof active.relativeRootPath !== "string") {
            addFinding("INVALID_AHOLO_MANIFEST", `数据集 ${datasetId} 的活动 AHoLo revision 无效`);
          } else {
            const revisionIds = new Set(manifest.revisions.map(value => String(value.revision)));
            if (String(dataset.aholo_visual_revision ?? "") !== String(active.revision)) {
              addFinding("AHOLO_REVISION_MISMATCH", `数据集 ${datasetId} 的数据库 AHoLo revision 与 manifest 不一致`);
            }
            if (String(dataset.aholo_policy_version ?? "") !== String(active.policyVersion ?? "")) {
              addFinding("AHOLO_POLICY_MISMATCH", `数据集 ${datasetId} 的数据库 AHoLo 策略与 manifest 不一致`);
            }
            for (const name of ["esz/lod-meta.json", "ply-reference/lod-meta.json", "aholo-report.json"]) {
              if (!(await exists(path.join(datasetRoot, active.relativeRootPath, name)))) {
                addFinding("MISSING_AHOLO_ARTIFACT", `数据集 ${datasetId} 的活动 AHoLo revision 缺少 ${name}`);
              }
            }
            for (const entry of await listChildren(path.join(datasetRoot, "aholo-visual-revisions"))) {
              if (entry.isDirectory() && !revisionIds.has(entry.name)) {
                addFinding("ORPHAN_AHOLO_REVISION", `数据集 ${datasetId} 的 aholo-visual-revisions/${entry.name} 不在 manifest 中`);
              }
            }
          }
        } catch (error) {
          addFinding("INVALID_AHOLO_MANIFEST", `数据集 ${datasetId} 的 AHoLo manifest 无法读取：${String(error)}`);
        }
      } else if (dataset.aholo_visual_revision != null || String(dataset.visual_backend) === "aholo-chunk-lod") {
        addFinding("MISSING_AHOLO_MANIFEST", `数据集 ${datasetId} 声明 AHoLo revision/后端但缺少 manifest`);
      }
      if (!["cesium-3dtiles", "aholo-chunk-lod"].includes(String(dataset.visual_backend))) {
        addFinding("INVALID_VISUAL_BACKEND", `数据集 ${datasetId} 的 visual_backend 无效`);
      }
      if (dataset.visual_build_target != null && !["cesium-3dtiles", "aholo-chunk-lod"].includes(String(dataset.visual_build_target))) {
        addFinding("INVALID_VISUAL_BUILD_TARGET", `数据集 ${datasetId} 的 visual_build_target 无效`);
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
