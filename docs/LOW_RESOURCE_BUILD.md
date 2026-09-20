# 低资源切片与分区体素构建（test 分支）

## 目标与边界

2026-09-20：`main` 保留 `fdad393` 稳定版，本次优化只在 `test`。前端 PlayCanvas 保持 2.21.4；转换器升级到未经修改的正式版 [splat-transform 3.4.2](https://github.com/playcanvas/splat-transform/releases/tag/v3.4.2)。本轮不更换 Renderer，不修改 GS Shader、标签深度选择或路线规划数学。

验收目标是 16GB 内存／4GB 显存设备，构建进程树峰值 RSS ≤8GiB、转换器报告 GPU 资源估算 ≤2GiB。它们是需实测的验收门槛，不是“低于门槛就一定成功”的保证；Windows 驱动挂起仍需目标机器实测。GPU 估算不等同物理显存。统一内存 Mac 的结果不能替代独显 Windows 验收。

## 官方能力与新增工程能力

| 层次 | 责任 |
|---|---|
| 官方转换器 | 流式 PLY 读取/写入、Gaussian 合并简化、CPU/GPU 设备选择、磁盘临时存储、SOG 编码、GPU 密度积分/阈值/体素过滤/SVO 与 GLB 输出 |
| 本项目新增 | 资源模式、串行调度、摘要检查点、取消/续算、磁盘 R-tree、完整贡献范围分区、重试、全覆盖验证、原子发布、分页碰撞读取与日志分类 |
| 保持不变 | 完整 LOD0、用户层级比例、官方编码默认值、用户体素尺寸/透明度阈值、局部坐标、标签模型与膨胀航线数学 |

不修改 `node_modules` 或官方网格保护值，不自写体素 Shader，不将显存失败等同于系统 RAM 不够。

## 视觉流水线

资源模式 `low-memory`（默认）使用 `--gpu cpu --max-workers 0`；`standard` 使用原生默认设备和最多四个编码 worker。每一层都从同一个不可变 PLY 单独调用官方 `--decimate`，各级串行，输出无损中间 PLY，然后官方 `--tag-lod` 生成 Streamed SOG。临时文件参数 `--scratch-dir` 指向该任务工作目录。

`--memory` 仅开启官方资源遥测，不是内存限制。视觉模式不添加 Chunk count/extent、格式、过滤、尺度补偿、旋转、裁剪或隐藏环境参数。SOG 本身采用官方默认编码，不能称为逐属性无损；完整 LOD0 指源 Gaussian 数量未抽稀，发布前逐项核对数量。

检查点绑定源 SHA-256、工具版本、全部比例及资源模式。每个已完成中间层单独校验 SHA-256，匹配才复用；不完整/损坏的层重新生成。最终 SOG 编码若中断，会从已完成的 PLY 中间层重做编码，不宣称 Chunk 级编码续传。改变参数使旧检查点失效，不删除旧活动版本。

## 分区数学

1. 官方公开 `readFile` 返回懒加载 ChunkSource，逐 Chunk 读取位置、四元数和对数尺度；官方公开 `writeSource` 输出所需行的完整 PLY。
2. 与官方 Gaussian AABB 定义一致，半轴为 `3 * exp(scale)`，使用归一化四元数旋转包围盒，再进入 voxel identity 坐标 `(-x,-y,z)`。候选选择增加 float32 舍入裕量，不改变实际高斯尺度或体素判定。
3. 所有核心区域定义在统一的整数 **4³ 体素块坐标** 中，区间左闭右开，世界原点不随分区平移。初始细分到每轴至多 32 块，即 128 个体素；超出 100 万贡献 Gaussian 时继续沿最长轴二分，最小为单个 4³ 块。
4. 核心外围增加一圈完整体素块。空间索引查询所有旋转后影响盒与该缓冲范围相交的 Gaussian；不限中心是否在核心内。同一个贡献集合一次交给官方体素化，透明度在阈值前统一累积；不 OR 独立批次结果。
5. 只读取每个核心的结果。缓冲数据用于边界贡献与官方相邻体素过滤，不具有跨分区所有权。此方案不适用于未经论证的全局 flood fill、floor fill 或导航 carve，这些功能保持关闭。
6. 官方 CLI 没有“只计算指定 AABB”选项，因此分区输入可能包含跨区大椭球，输出范围可能大于核心；核心大小不是输出网格/显存的硬上限。极端重叠、巨大 Gaussian 或设备能力过低，最小分区也可能失败；必须明确停止，不偷偷删点、剪尺度或改分辨率。

每个官方体素任务在独立子进程运行，GPU 并发固定为 1。结果校验、落盘、子进程退出后才进入下一分区。设备挂起/显存或内存资源失败可以分裂该任务后重试，最多两次重试；不能细分或超限就失败。其他错误不盲目重试。空核心显式记录，缺失核心不是空核心。

即使存在输入 Gaussian，经过官方密度阈值和过滤后也可能没有占用体素。官方会合法输出 `nodeCount=leafDataCount=0`、零字节 BIN；它必须经过 JSON/长度/摘要校验，记录为已计算的空占用，不能误报为缺失分区。缺少 BIN 文件仍然是错误。此类分区不列入可显示网格编号。

## 发布、恢复和查询

新版 `collision-manifest.json` schemaVersion=2 包括：源摘要、工具/策略版本、参数、坐标约定、统一根网格、核心列表、空区标记、分区元数据与文件摘要、完成标记。校验核心无重叠、完全覆盖根网格，检查所有 JSON/BIN 长度和 SHA-256，再原子移动目录并原子替换 `dataset.json` 活动指针。未完成产物禁止成为活动版本。

另外保留 `queryBounds`：从各分区官方网格裁剪范围与核心所有权的交集汇总得到全局有效占用包围盒，复现官方整场 `cropToOccupied` 的查询边界。不能仅把全源 Gaussian 外包围盒当作可飞行域，否则低透明度离群 Gaussian 会扩大已知自由空间，改变原规划结果。统一根网格用于分区完整性，裁剪查询边界用于原碰撞数学；二者职责不同。

旧单体 schemaVersion=1 仍可读取，无需重建。新增适配器继承原 `VoxelWorld` 的球/扫掠/射线/净空方法，仅将整数格坐标路由到分区。SVO 二进制按 64KiB 页读取，默认 LRU 缓存 256MiB，最多 64 个打开句柄；读取前验证摘要。损坏、缺失、重复分区停止规划，不当作自由空间。全局场景外仍由原 `sphereIsFree/segmentIsFree` 视为未知/不可飞行。

每次规划在工作线程中进行，结束释放页缓存/文件句柄。整个服务一次最多一个构建或规划重任务。异步规划完成后重新检查任务和碰撞 revision，防止过期结果写回。规划点随机 UUID 不作为几何一致性比对项。

取消以 AbortSignal 终止转换子进程，三秒未退出再强制结束；已校验的中间层/分区保留。索引只复用已完整生成并通过 SQLite 检查、行数和源摘要检查的文件。索引阶段中断会重建索引，不宣称逐行续算。临时数据在各场景目录内，随场景删除级联清理。启动恢复会将中断任务标为可重试。

碰撞成功激活才使相关任务失效；失败、取消与调试网格更新均不改变标签空间数据、现有视觉版本和已激活 SVO。

## 调试网格

SVO 默认不加 `--collision-mesh`，从而不走官方为 fill/nav/mesh 设置的 1GiB mutable-grid 分支。需要显示时选择非空分区编号，使用同一源贡献集、同一参数额外执行官方 `--collision-mesh faces`。校验新 SVO 与活动分区的二进制和 gridBounds 一致，才把 GLB 作为独立版本化附件挂载。旧单体版按整体生成附件；仍可能触发官方保护。

每次仅显示所选分区的官方网格（含缓冲），不是完整场景。失败只更新 `debugMeshStatus/debugMeshError`，不撤销 SVO，也不使航线失效。调试网格不能拾取，仍沿用现有坐标节点和单 Renderer。

## API

| 方法/路径 | 契约 |
|---|---|
| `POST /api/datasets/:id/build` | `{lodLevels, resourceProfile}`；仅首次切片/失败续算，成功后视觉仍锁定 |
| `POST /api/datasets/:id/collision/build` | `{voxelSize, voxelOpacity, resourceProfile}`；相同检查点继续，不同参数新任务；两种资源模式的体素均分区 GPU 串行 |
| `POST /api/datasets/:id/tasks/cancel` | 只取消该场景正在执行的构建，返回 202；检查点保留 |
| `POST /api/datasets/:id/collision/debug-mesh/build` | `{partitionIndex:0}`，API 从 0 计数，界面从 1 显示；参数取活动碰撞版本，不取表单修改值 |
| `GET /api/datasets/:id/logs/{visual-revision\|collision-revision\|debug}.log` | 完整进程日志，`no-store`；实际文件名由场景列表的 `visualLogUrl/collisionLogUrl` 提供 |
| `GET /api/datasets/:id/collision-revisions/:revision/*` | 已发布不可变资源，长缓存、原有 Range 支持 |

`Dataset` 新增资源模式、pending revision、日志 URL；`CollisionState` 新增分区数量、manifest 摘要、独立调试状态/附件 URL/分区编号。`activeTask.type` 增加 `debug`。没有修改标签或航线数据库结构。

## 运维与验收

完整记录各进程标准输出、错误输出及顶层异常。分类包括 `RAM`、`GPU_MEMORY`、`GPU_LOST`、`GRID_LIMIT`、`DISK_FULL`、`CANCELLED`。原始堆栈留在日志，界面显示中文诊断。磁盘阶段预检保留至少 2GiB 余量，仍须处理中途 ENOSPC；预检不能保证后续磁盘永不耗尽。

构建前保存本页面镜头并卸载当前 GS、网格、标签和路线显示；完成、失败、取消后恢复场景和镜头，恢复第一人称时不强行重新获取 Pointer Lock。其他标签页/浏览器不是本页面可控制的资源，低配验收需关闭它们。

常规 `npm test` 不运行切片；原生小场景实测由 `verify-partition-native.mjs` 执行。全量实测由 `verify-low-resource.mjs` 执行，保留检查点与报告，完成阶段可复验而不重做切片。Windows 4GB 独显、真实设备丢失、人工视觉与浏览器生命周期验收必须单列，不得用 mock 或 Mac 结果冒充。
