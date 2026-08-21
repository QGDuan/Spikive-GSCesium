# API 说明

所有 JSON 写接口均使用 `Content-Type: application/json`。ID 为 UUID，坐标除 WGS84 摆放外均为模型局部米制 XYZ。

`GET /healthz` 返回服务状态、转换开关以及碰撞 SVO LRU 缓存的 `entries`、`bytes`、`maximumBytes`。

## 数据集与上传

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/datasets` | 数据集列表与处理状态 |
| `POST` | `/api/datasets` | 创建数据集和上传元数据 |
| `GET/PATCH/DELETE` | `/api/datasets/:id` | 详情、摆放/处理参数更新、删除 |
| `POST` | `/api/datasets/:id/retry` | 重试失败任务 |
| `POST` | `/api/datasets/:id/rebuild-visuals` | 按固定 AHoLo 策略构建或重建 ESZ + 无损 PLY Chunk；不重建碰撞 |
| tus | `/api/uploads` | 最大 5 GiB 断点续传；metadata 必须含 `datasetId` |
| `GET` | `/api/datasets/:id/render-manifest` | AHoLo 活动视觉的无缓存清单、坐标契约与碰撞 revision |
| `GET` | `/api/datasets/:id/aholo-visual-revisions/:revision/:format/lod-meta.json` | AHoLo ESZ/PLY 版本化 LOD 清单 |
| `GET` | `/api/datasets/:id/aholo-visual-revisions/:revision/:format/*` | 不可变 ESZ/PLY Chunk，缓存一年 |
| `GET` | `/api/datasets/:id/aholo-visual-revisions/:revision/report` | AHoLo 构建与覆盖质量报告 |
| `POST` | `/api/datasets/:id/aholo-visual-revisions/:revision/activate` | 切换到仍在七天保留期内且摘要匹配的 AHoLo revision |
| `GET` | `/api/datasets/:id/collision/*` | 碰撞调试资源 |

创建数据集的关键字段：`sceneType`、`inputConvention`、`sourceCoordinateSystem`、`voxelSize`、`voxelOpacity`、`placement`。当前 `inputConvention` 固定为 `graphdeco`，`sourceCoordinateSystem` 固定为 `z_up`；室内模式还必须提供已知自由空间 `indoorSeed`。

`voxelSize`、`voxelOpacity` 和 `indoorSeed` 只允许在 `created` 或 `failed` 状态修改；上传或发布后修改但不重建碰撞体会造成配置与产物不一致，因此服务返回 `409`。名称和 WGS84 摆放不受此限制。请求体不满足 Zod 契约时统一返回 `400` 和结构化 `details`。

碰撞可变网格超过工具内存保护阈值时，失败信息会包含建议的最小 `voxelSize`，但服务绝不自动应用。操作员应先 `PATCH /api/datasets/:id` 明确提交确认后的体素尺寸，再调用 retry；工作目录中通过完整性校验的 AHoLo 视觉中间产物可以复用。体素尺寸变大意味着碰撞分辨率降低，重试成功不替代细障碍和航迹净空验收。

数据集响应中的 `aholoVisualRevision` / `aholoPolicyVersion` 代表当前 AHoLo 视觉版本；没有 Renderer 选择字段。名称或 WGS84 placement 更新只改变业务元数据，不产生新的视觉 revision。版本化内容 URI 缓存一年，活动 manifest 不缓存；切换接口会重新核对源文件、碰撞摘要和产物完整性。

AHoLo 的 `minLevel`、`maxBudget`、`backgroundPenalty`、`distanceStep` 和调度选项属于浏览器会话级 Renderer 参数，通过 AHoLo 公共 `LodSplat.setConfig()` 生效；服务端不提供持久化接口，也不会用这些参数改变 Chunk 产物、碰撞、标签或航迹。

`DELETE /api/datasets/:id` 是永久删除：服务会先取消该数据集正在执行的切片/碰撞任务，再删除上传临时文件、原始 PLY、工作目录和已发布资源。数据库外键会级联删除标签、任务及航迹点。

## 巡检标签

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET/POST` | `/api/datasets/:id/labels` | 列表、从 GS 拾取点创建标签 |
| `PATCH/DELETE` | `/api/labels/:id` | 编辑、翻转法向、删除 |
| `POST` | `/api/labels/:id/resolve` | 重新用碰撞体解析表面法向 |

创建标签至少提交 `title` 与 `positionLocal`。只有 `resolutionStatus=resolved` 且存在 `surfaceNormalLocal` 的标签可以规划。

删除标签前会检查同一 GS 场景内的任务引用。只要仍有任务的 `labelIds` 包含该标签，`DELETE /api/labels/:id` 返回 `409`；必须先永久删除引用任务，清除前端路线显示不影响引用关系。

## 巡检任务

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET/POST` | `/api/missions` | 按 `datasetId` 查询或创建任务 |
| `GET/PATCH/DELETE` | `/api/missions/:id` | 任务详情、顺序/参数调整、删除 |
| `POST` | `/api/missions/:id/plan` | 根据标签和碰撞体规划 |
| `GET` | `/api/missions/:id/export` | 导出通用 JSON |
| `GET` | `/api/missions/:id/export?format=geojson` | 导出模型局部 GeoJSON |

任务必须包含 `homeLocal`、有序 `labelIds` 以及完整 `flightProfile`：

```json
{
  "droneRadius": 0.4,
  "safetyMargin": 0.6,
  "observationDistance": 3,
  "speed": 2,
  "minimumWaypointSpacing": 0.5,
  "maximumSegmentLength": 5
}
```

`startLabelId` 可为 `null`（使用 `homeLocal`）或同场景内一个已解析标签 ID。指定标签后，`homeLocal` 仅作为兼容审计快照，规划器会根据该标签的法向、`observationDistance`、视线和碰撞净空生成实际自由空间起点，并在任务结束时返回同一点。起点标签不能再次出现在 `labelIds` 中；它和中间巡检标签具有相同的引用保护，标签移动、法向变化或删除都会使任务失效或被阻止。

`maximumSegmentLength` 控制碰撞通过后的长直线被细分成多密的航迹点，必须不小于 `minimumWaypointSpacing`，默认 5 m，最大 500 m。它只控制航迹表达和逐段复检密度，不会提高体素碰撞数据本身的空间分辨率。前端预填工程值，操作员必须结合机型、体素精度和飞控航点限制确认。

每一对 `Home / 观察点 / Home` 先按“机体半径 + 安全余量”做扫掠球直线检查。SVO 运行时的扫掠采样间距固定不大于半个碰撞体素，并结合占用体素立方体的半对角线保守膨胀，避免整体素采样因起点相位不同漏掉斜穿障碍。受阻后使用 26 邻域三维 A*；A* 的每条相邻边也执行同一检查，禁止只验证端点后斜穿障碍。得到的网格最短路经过碰撞捷径平滑、最小间距安全删点、最大航段等距细分，最后对每个点和每一条最终航段重新扫掠校验。最终点数超过 5,000 时任务保持 `invalid` 且不保存路线；某一后续目标无通路或最终复检中途失败时，只保存失败位置之前已经按顺序复检通过的安全前缀作为可视化调试预览。该前缀不是候选航线，任务仍为 `invalid`，不能导出或执行。

创建、修改和重新规划任务时，服务端都会校验 `startLabelId` 和每个 `labelId` 存在且属于任务的 `datasetId`，跨 GS 场景绑定返回 `409`。标签对应的 inspection waypoint 和标签起点通过 `targetLabelId` 保留关联，并保留内部语义名称 `hj_标签名`；场景只显示红色航迹点，不显示重复的 `hj_` 文字。

修改任务的 Home、起点标签、标签顺序或飞行参数会立即清除旧航迹并把任务恢复为 `draft`。PATCH 未提交的字段保持原值；例如只修改任务名称绝不能把 `startLabelId` 隐式清空。修改标签位置、表面法向或执行法向翻转，也会使所有引用任务恢复为 `draft` 并清除旧航迹，防止继续显示或导出与当前标签几何不一致的 `valid` 结果。

升级到逐边扫掠与最大航段策略时，缺少 `maximumSegmentLength` 的历史任务会迁移为 5 m、清空旧航点并回到 `draft`，必须重新规划后才能再次导出。
前端选择历史任务后可直接点击“重新规划当前任务”，或在每条任务上点击“计算航线/重新计算”；该操作沿用任务已保存的 Home、标签顺序和飞行参数，不会创建重复任务。新建流程会依次显示“建立任务、碰撞规划、完成/失败”和耗时，任务列表提供显式刷新入口。

`DELETE /api/missions/:id` 只永久删除指定任务及其航迹点，不删除关联的数据集和巡检标签。前端每条任务都有独立“删除航线任务”入口并要求二次确认。

AHoLo 中有效任务的 inspection 点以红色显示，内部命名为 `hj_<标签名>` 但不绘制该文字；A*/细分生成的 transit 点以蓝色显示，Home 为中性色，已校验折线为绿色。巡检对象标签本身可点击，选中时高亮并显示持久化位置、法向和解析状态。最终复检失败产生的严格安全前缀使用橙色折线并标为“部分预览”，不绘制失败点、失败航段或任何猜测后缀；只有完整 `valid` 航线可以导出。
