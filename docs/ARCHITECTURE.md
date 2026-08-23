# 系统架构与数据管理闭环

## 1. 总体结构

`main` 只运行一个 PlayCanvas Renderer、一个 Canvas 和一个 `GraphicsDevice`。没有 Cesium、AHoLo、双 Canvas 或自定义 Gaussian Renderer。

```text
不可变 GraphDECO PLY（局部 Z-up、米）
 ├─ 官方 splat-transform Streamed SOG ── 仅负责 GS 显示
 └─ 官方 splat-transform Voxel ───────── SVO + collision GLB
                                              │
                                              ├─ 表面拾取与法向
                                              ├─ 标签吸附
                                              └─ 膨胀碰撞与航迹规划
```

视觉与安全计算共享源文件和局部坐标，但没有运行时数据依赖。视觉 Chunk 永不参与体素化或规划。

## 2. 组件职责

- `apps/web`：React、PlayCanvas 2.21.4、tus；负责原生 GS 加载、相机输入、标签/航线叠加和只读性能监控。
- `apps/server`：Fastify、SQLite、tus、未修改的 `@playcanvas/splat-transform` 3.3.0；负责上传、官方 Streamed SOG、碰撞 SVO、标签依赖、航线规划和原子发布。
- `packages/shared`：前后端坐标、数据集、标签、任务和 manifest 契约。
- `var/`：源 PLY、数据库、工作目录、碰撞和版本化视觉产物；属于受管业务数据。

## 3. 坐标与交互

持久坐标固定为数据集局部 Z-up 米制。PlayCanvas 显示适配为 `render=(x,z,-y)`，逆变换为 `local=(x,-z,y)`。标签拾取链固定为：

```text
屏幕点 → PlayCanvas 相机射线 → 局部射线 → 服务端 SVO raycast → 命中点与法向
```

Renderer 深度和近似 Gaussian 命中不作为业务真值。

## 4. 视觉 revision

视觉策略标识为 `playcanvas-upstream-streamed-sog-v1`。LOD0 使用源 PLY，LOD1–3 分别由上游 `--decimate 50%/25%/10%` 生成，再由上游默认 Streamed SOG writer 输出 `lod-meta.json` 与 Chunk。平台不传 Chunk、格式、过滤、旋转或预算参数。

构建路径：

```text
var/published/<dataset>/visual-revisions/<revision>/
 ├─ sog/lod-meta.json
 ├─ sog/<official native SOG chunks>
 └─ visual-report.json
```

活动指针写入 `visual-artifact-manifest.json`。新版本完整构建、校验后原子激活；失败不影响旧版。版本化 Chunk 长缓存，活动清单不缓存。

## 5. 碰撞、标签与任务

碰撞分支从全量源 PLY 串行构建 `.voxel.json`、`.voxel.bin` 和调试 GLB。`voxelSize`、`voxelOpacity` 及室内/室外填充是业务输入；内存不足时不得自动调参。

SVO 是标签吸附、法向、直线扫掠、26 邻域 A*、捷径平滑、航段细分与最终复检的唯一真值。净空半径为 `droneRadius + safetyMargin`，并计入占用体素半对角线。

依赖规则：

- 数据集拥有源 PLY、视觉 revisions、碰撞、标签、任务和航点。
- 标签和任务必须属于同一数据集。
- 被任务引用的标签不可删除，必须先删除引用任务。
- 标签位置或法向变化会清除相关旧航点并把任务恢复为 `draft`。
- 视觉重建不修改碰撞、标签或任务。
- 永久删除数据集会取消在途工作并级联清理全部关联数据。

## 6. 生命周期与监控

右上角性能面板只读显示 FPS、帧时间、CPU、内存、浏览器堆、引擎可见 GPU 资源、WebGPU/WebGL2、排序方式、Chunk 与 Gaussian 统计。浏览器无法可靠读取整机 GPU 利用率或真实物理显存，界面不得伪装这些值。

场景销毁顺序固定为：中止加载与 SVO 请求，解绑输入/帧监听/ResizeObserver，清除线点与 DOM，卸载 GS Asset，移除 Entity，销毁相机与 Application。异步回调必须检查 abort/destroy 状态。
