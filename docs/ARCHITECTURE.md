# 系统架构与数据管理闭环

## 1. 当前架构结论

`main` 是 AHoLo 单 Renderer 架构。前端只创建一个 AHoLo Viewer 和一个 WebGL2 context；不存在 Cesium 运行时、Renderer 切换、双 Canvas 合成或失败后隐式切换。

显示与安全计算严格分离：

```text
GraphDECO PLY（不可变源，局部 Z-up，米）
 ├─ AHoLo Chunk LOD ── 浏览、标签和航线叠加显示
 └─ SVO + collision GLB ── 射线命中、表面法向、净空与路径规划
                              │
标签 ── 数据集绑定/引用保护 ──┤
任务 ── 标签顺序/飞行参数 ── 航点与导出
```

AHoLo 的透明排序或屏幕深度不作为无人机安全真值。标签创建时由 AHoLo 相机生成射线，转换回局部 Z-up 后交给后端 SVO；航线也只由同一 SVO 和后端规划器计算。

## 2. 组件职责

- `apps/web`：React、AHoLo Viewer、tus-js-client；负责上传、浏览器会话级 LOD 调参、射线生成，以及标签与路线可视化。
- `apps/server`：Fastify、SQLite、tus、AHoLo 转换任务、SVO 查询、标签依赖和路径规划。
- `packages/shared`：前后端共用 Zod 契约和坐标/任务类型。
- `@manycore/aholo-splat-transform@1.7.4`：GraphDECO PLY → AHoLo Chunk LOD。
- `@playcanvas/splat-transform@3.1.6`：GraphDECO PLY → SVO、碰撞 GLB；只参与服务端碰撞构建。

SQLite 使用 WAL。API 启动先建立/迁移数据库，再核对已发布 AHoLo manifest。旧数据库中只有在既有 AHoLo 报告或历史构建摘要能确认轴向时才补记 `sourceCoordinateSystem=z_up`；无法确认的旧数据不会被静默解释。

## 3. 坐标契约

- 数据库、标签、任务、航点、碰撞和导出统一使用数据集局部 Z-up 米制坐标。
- AHoLo 显示适配固定为 `render=(x,z,-y)`，逆变换为 `local=(x,-z,y)`。
- 射线、位置和法向在适配层成对变换；数据库不保存 AHoLo Y-up 坐标。
- `placement` 只保留未来地理定位/导出的元数据，不参与本地巡检渲染和碰撞 revision。

创建数据集必须显式提交 `inputConvention=graphdeco` 与 `sourceCoordinateSystem=z_up`。当前不自动猜测其他坐标系，也不通过显示对齐结果倒推安全坐标。

## 4. 构建、发布与版本

首次上传的固定流水线为：

1. 验证 GraphDECO PLY header、点数、属性和有限值。
2. 串行构建碰撞 SVO 与 collision GLB，并校验 `coordinateFrame=tile_local_z_up`。
3. 构建无损 PLY Chunk LOD，作为视觉质量参考。
4. 逐 Chunk 转换高精度 ESZ v2；每个 Chunk 完成后释放解码资源。
5. 比较源点数、SH 阶数、各级拓扑、空间覆盖和碰撞摘要。
6. 在工作目录完成后原子发布，最后更新数据库中的活动 revision。

可视化重建只生成新的 AHoLo revision，复用并重新校验已发布碰撞，不复制、不重建碰撞，也不改变标签和任务。构建失败时继续服务上一活动 revision；参数或格式不自动降级。

活动 manifest 不缓存；带 revision 的 ESZ/PLY Chunk 可缓存一年。系统保留活动版和上一个已验收版，上一个版本保留七天并可显式激活。AHoLo report 记录源 SHA-256、点数、SH 阶数、工具/策略版本、各级点数、Chunk 数、字节数、坐标变换和碰撞摘要。

历史 Cesium 产物可能继续存在于升级前的 `var/published` 中，用于冻结版本回退。AHoLo-only `main` 不读取、不发布、也不在迁移时自动删除这些持久数据。

## 5. AHoLo Chunk LOD

固定构建策略 `aholo-chunk-lod-v1`：

| 项目 | 固定值 |
|---|---:|
| 单 Chunk 最大 Gaussian | 400,000 |
| LOD 比例 | 100%、50%、25%、5%、1% |
| Scale Boost | 1、1、1、1.01、1.02 |
| 常驻合并层 | 5%、1% |
| 默认运行预算 | 6,000,000 |
| 默认 `minLevel` | 0 |
| `backgroundPenalty` | 0.5 |
| `hysteresisTicks` | 4 |
| 调度并行数 | 4 |
| 任务缓存上限 | 64 |
| 最短调度间隔 | 160 ms |

LOD0 必须覆盖全部有效源 Gaussian，不能以随机删点代替。界面开放 `minLevel`、`maxBudget`、背景惩罚、距离步长和调度参数，但这些仅存于当前浏览器会话；系统不因低帧率静默改小预算，也不把显示参数写入碰撞和任务。

详见 [AHoLo 渲染、Chunk LOD 与生命周期](AHOLO_RENDERING.md)。

## 6. 标签拾取与法向

标签建立流程：

1. 浏览器将点击坐标转换为 AHoLo 相机射线。
2. 通过逆坐标变换得到局部 Z-up 射线。
3. 服务端 SVO raycast 返回表面位置、法向、占用依据和当前碰撞 revision。
4. 标签以 `positionLocal`、`surfaceNormalLocal`、`resolutionStatus` 持久化。

GS 近似拾取只可用于光标反馈，不能替代 SVO 命中。巡检对象标签可点击，选中后高亮并展示位置、法向和解析状态。

标签修改位置、法向或翻转法向后，所有引用任务立即回到 `draft` 并清除旧航点。标签被任一任务的起点或巡检序列引用时禁止删除；必须先永久删除引用任务。

## 7. 航迹规划

任务记录数据集、可选起点标签、有序巡检标签、Home 快照、飞行参数、状态和航点。当前版本不提供碰撞产物的独立替换接口；任务在数据集当前唯一碰撞产物上规划。

规划固定执行：观察点生成与视线检查 → 膨胀扫掠球直线检查 → 受阻时 26 邻域三维 A* → 碰撞安全捷径平滑 → 最小间距删点 → 最大航段等距细分 → 每点和每段最终扫掠复检。

- 标签关联观察点为红点，内部语义名为 `hj_<标签名>`，不重复显示文字。
- A*/细分产生的途经点为蓝点。
- 完整有效路线为绿色。
- 最终复检失败前的严格安全前缀为橙色，仅供诊断，任务仍是 `invalid` 且禁止导出。

如果未来增加碰撞重建或替换，必须先增加任务/标签的碰撞 provenance，并让旧任务失效后才能上线。AHoLo 视觉 revision 变化不影响任务，因为位置、法向和航点不依赖显示 Chunk。

## 8. 生命周期与故障边界

AHoLo 场景销毁顺序固定为：停止交互和调度 → 中止网络请求 → 释放 LodSplat/Chunk → 移除标签与线对象 → 移除帧循环和监听器 → 销毁 Viewer。所有异步回调先检查 abort/destroy 状态，禁止访问已销毁对象。

初始化失败或 WebGL context 丢失时，当前场景有界停止并显示明确错误与重试入口；不创建第二 Renderer。数据集切换、清除显示和组件卸载使用相同销毁闭环。

碰撞构建的可变网格超过工具安全限制时任务失败，并返回人工建议的最小 `voxelSize`。服务不会自动调粗体素；操作员确认参数后修改失败数据集并重试。体素变粗会降低小障碍辨识能力，必须重新做现场和航线安全验收。

## 9. 数据删除与运维

- 清除显示只卸载浏览器场景，不改数据库和文件。
- 删除任务会删除任务航点并解除标签引用。
- 删除标签前必须无任务引用。
- 永久删除数据集会先取消任务，再级联删除标签、任务和航点，并清理源 PLY、工作目录、上传临时文件、AHoLo revision 与碰撞产物。
- `var/` 是业务数据根目录，不能由 `clean`、构建、安装包生成或代码升级删除。

每次发布必须运行 `npm run verify`。对现有业务数据另运行 `npm run audit:data`；审计只读，不修复或删除产物。
