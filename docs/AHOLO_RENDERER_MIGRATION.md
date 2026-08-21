# AHoLo Renderer 迁移与验收

## 1. 决策与边界

AHoLoJS 是本地巡检场景的候选 Renderer；Cesium 继续作为默认生产和一个版本周期的回滚路径。两者不叠加、不共享相机、不同时创建 GPU context：`/renderer-lab` 动态加载 AHoLo 且不导入 Cesium，生产入口依据 `Dataset.visualBackend` 只挂载一个场景组件。AHoLo 初始化或 WebGL context 丢失时，当前会话有界停止并回退 Cesium，不静默更改数据库开关。

锁定依赖：

- `@manycore/aholo-viewer@1.8.1`，WebGL/WebGL2；不宣称 WebGPU。
- `@manycore/aholo-splat-transform@1.7.4`，Node.js `>=22.22.1`。

AHoLo 只替代外观显示。后端 SVO、标签吸附、法向、标签依赖、航迹规划、扫掠复检、导出和删除保护仍是唯一计算真源。更换 Renderer 不能补造源 PLY 缺失的高阶 SH；当前 14.22M、SH0 数据仍以原始 PLY 固定视角为画质上限。

## 2. 固定数据策略

`AHOLO_CHUNK_LOD_POLICY` 不接受请求侧自由参数：

| 项 | 固定值 |
|---|---:|
| 最大 Chunk | 400,000 Gaussian |
| LOD 比例 | 100%、50%、25%、5%、1% |
| Scale Boost | 1、1、1、1.01、1.02 |
| 常驻/合并 | 5%、1% |
| 运行预算 | 6,000,000 Gaussian |
| minLevel / backgroundPenalty | 0 / 0.5 |
| hysteresisTicks | 4 |
| 调度并行 / 缓存任务 / 间隔 | 4 / 64 / 160 ms |

构建顺序固定为：

```text
不可变源 PLY
  └─ 一次 AutoChunkLod ── 无损 PLY Chunk（唯一拓扑与画质基准）
       └─ 逐 Chunk Read → ESZ v2 highPrecision → release
```

该顺序避免两次独立 LOD 采样导致对照拓扑漂移，也避免同时驻留全场两套转换数据。发布前校验 LOD0 点数等于源 PLY vertex 数、SH 阶数一致、五层点数单调不增、所有 Chunk 引用和包围体有效、ESZ/PLY 拓扑完全一致，并将源 SHA-256、碰撞摘要、工具版本、层级点数和字节数写入 `aholo-report.json`。失败只保留旧候选与当前生产 Renderer，不降参数、不换格式。

## 3. 坐标、拾取与覆盖物

数据库与算法继续使用 `tile_local_z_up` 米制坐标。AHoLo 场景根固定 `Rx(-90°)`：

```text
render = (local.x, local.z, -local.y)
local  = (render.x, -render.z, render.y)
```

`LodSplat` 的 LOD 计算使用一个同步后的局部相机，避免旋转场景根后直接用 Y-up 渲染相机评估未旋转包围体。点击流程固定为“AHoLo NDC 射线 → 逆正交变换 → 单位化局部方向 → `POST /raycast` → SVO 命中”，不使用透明 Gaussian 深度。前端传递完整 `SurfaceHit`（局部位置和法向），待保存点、法向线与屏幕探针均由 AHoLo 覆盖层显示；保存时服务端仍须用当前 SVO 重新吸附或校验该法向，不能信任客户端坐标。

SVO 中对称孤立体素的中心差分可能得到零梯度。此时法向取射线实际进入该体素的表面轴向，并要求“命中点占用、沿法向一个体素后为已知非占用”才可保存为 resolved；未知网格外仍不能作为自由空间。

标签和航迹在 AHoLo 同一 Scene 中绘制：巡检对象标签使用自身颜色，标签关联航迹点（内部名 `hj_<标签名>`）为红色固定屏幕 Sprite，但不显示 `hj_` 文字；途经点蓝色，自由 Home 中性色，有效航线绿色 FatLine，无效任务的已验证安全前缀橙色。覆盖物使用公开的 `DrawableRenderMode.Overlay`，避免被 GS 合成阶段覆盖；巡检对象文字是空间投影绑定的可点击 DOM 按钮，点击后通过会话状态高亮并显示详情，进入 SVO 拾取模式时禁用这些按钮。路径数据不在前端重新规划。

进入场景时，若没有仍然存在的当前任务，界面自动选择该场景第一条任务，保证已保存航线立即可见；用户显式执行“清除航线显示”后保持空选状态，不能由后台轮询擅自重新显示。

## 4. 运行时 LOD 调参

AHoLo 视图开放一个会话级调参面板，直接使用公开的 `LodSplat.setConfig()`，允许操作员显式修改 `minLevel`、`maxBudget`、`backgroundPenalty`、近距 `distanceStep`、滞回、调度并行数、任务缓存、调度间隔、节点合并、视锥剔除与诊断着色。默认值仍固定为 minLevel 0、6M、0.5、4/64/160 ms；系统不依据 FPS 自动降预算或提高 minLevel。

参数只影响当前浏览器会话的 Chunk 选择和调度，不写数据库、不重切片、不改变碰撞 revision、标签或航迹。稍卡时可由操作员先显式尝试 4M 预算；画质与性能取舍必须可见、可复位，不能伪装成数据策略变化。

## 5. 生命周期契约

每个 AHoLo 场景只有一个所有者。销毁顺序固定为：

1. 置 destroyed 标志并取消应用 RAF；
2. 断开 ResizeObserver、指针、滚轮和 context 监听；
3. 中止 manifest、LOD meta 和所有 Chunk 流式 fetch；仅过滤本实例主动取消产生的特定异步拒绝，并在加载归零后移除过滤监听；
4. 移除并销毁 Sprite、FatLine 和文字投影；
5. `LodSplat.destroy()`，取消内部调度、移除代理并释放已加载资源；
6. `Viewer.destroy()`，释放 WebGL context 与 Canvas；迟到的应用回调先检查销毁状态。

不得在 AHoLo 和 Cesium 间复用对象，也不得让一次失败触发重复 destroy。生产端的回退只更换 React 分支；持久化开关仍需人工显式操作。

## 6. 验收门禁

- `/renderer-lab` 分别加载无损 PLY Chunk 与高精度 ESZ，对比原始 PLY、当前 Cesium；固定 1080p/FOV，在九个锚点和 30/100/500/1500 m 截图。
- 近景必须调度 LOD0；ESZ 不得比无损 Chunk 新增空洞、尺度/旋转/Alpha/颜色损失、轮廓变软或细线消失。
- M5/16GB Chrome 固定 6M 预算，中位 FPS 不低于 30；不得下载完整源 PLY，调度完成后内存稳定。
- 连续 50 轮拉近/拉远/旋转、20 轮场景切换，网络请求、RAF、监听器、Canvas 和 GPU 资源不得持续增长。
- 同一屏幕点击转换后的局部射线、SVO 命中，以及同一任务的局部航点、顺序、净空、状态和导出必须与 Cesium 完全一致；九个投影锚点偏差不超过 1 px。
- 首次进入有任务的场景必须自动显示一条航线；有效航线为绿色、失败安全前缀为橙色，标签关联点为红色、途经点为蓝色。显式清除显示后不得被轮询自动恢复。
- 修改 AHoLo 会话参数后确认 `LodSplat.setConfig()` 生效，恢复默认可回到 6M/minLevel 0；任何参数变化均不得改变 SVO 命中、标签、任务记录或导出结果。
- 只有全部门禁通过才显式启用 AHoLo；任一画质、性能或生命周期门禁失败都继续使用 Cesium，不启用双 Canvas 折中方案。

自动化覆盖固定 pipeline、manifest、拓扑/覆盖、版本 URI、坐标正逆变换、严格类型、互斥挂载结构和资源销毁路径。真实近景画质、FPS、GPU context 丢失与像素偏差仍必须在代表性浏览器和数据上人工验收，不能用单元测试替代。
