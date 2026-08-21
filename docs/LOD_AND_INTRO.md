# GS LOD 与初始化展示固定策略

本文定义平台固定使用的 Gaussian 3D Tiles 分层策略和首次加载展示状态机。实现不得依赖转换器或 Cesium 的隐式默认值；调整这些参数需要修改本文、回归测试和代码常量。

## 1. 固定 LOD 策略 V2

平台固定参数如下：

| 参数 | 固定值 | 作用 |
|---|---:|---|
| `maxLeafLimit` | 25,000 | 最细分区的目标 Gaussian 预算 |
| `minLeafLimit` | 2,500 | 普通空间切分停止阈值 |
| `samplingRatePerLevel` | 0.65 | 提高父层 Gaussian 保留率并增加自适应逻辑层数 |
| `lodMultiplier` | `max` | 使用数据量自适应的基础 geometric error 曲线 |
| `coverageBoostScale` | 0.6 | 父层更密后减少椭球覆盖膨胀，降低远景模糊 |
| `opacityFilter` | 0.02 | 仅过滤极低透明度 Gaussian，保留细弱结构 |
| geometric error layer multiplier | 1.35 | 提高粗层误差，使详细子层从更远距离开始细化 |
| geometric error scale | 2.5 | 固定放大整条误差曲线，抵消深层重估并让详细层从更远处开始细化 |
| bounds | AABB | 固定轴对齐包围盒，便于一致审计 |
| 转换内存预算 | 4 GiB | 控制 Worker 转换峰值，不是浏览器缓存 |

所有参数由 Worker 显式传给转换器。转换完成后，Worker 会读取 `build_summary.json`，核对有效点数、深度和策略字段；任何不一致都会使任务失败，不发布为 `ready`。

### 深度按有效数据量自适应

设透明度和无效值过滤后的 Gaussian 数量为 `N`，最大逻辑深度为：

```text
depth = 0                                      , N <= 25,000
depth = ceil(log(25,000 / N) / log(0.65))      , N > 25,000
LOD 层数 = depth + 1
```

层数不是小数据的固定开销：不超过 25,000 个有效 Gaussian 仍只有一层。2,468,428 点场景为最大深度 11、共 12 层；当前 14,224,203 输入在 `opacityFilter=0.02` 后预计保留 13,975,115 点，最大深度 15、共 16 层。物理 KD 树目录只是存储实现；前端不得把物理 Level 15/17 映射成逻辑 LOD。

当前代表场景的旧产物约 425 MiB，V2 预计约 630–650 MiB。发布硬上限为 700 MiB；超过上限时保留旧活动 revision 并失败，不自动修改参数。源 PLY 永久保留，SH 阶数必须前后一致；当前数据为 SH0，切片不能创造源中不存在的高阶视角颜色。

V2首轮真实构建证明，仅增加层数会使转换器重新估算叶层误差：全局 scale 为1时，根误差由旧版45.75降至21.05，1500/500/100米的静态选择密度不能达到目标。V2.1因此把全局 scale 固定为2.5；在1080p、60°垂直FOV、稳定SSE16的审计相机下，预计相对旧版在1500米多细化1层、500米3层、100米4层。该值是平台版本常量，不根据帧率或设备静默调整。

### 质量报告与版本发布

每个视觉 revision 都生成 `lod-report.json`，记录源摘要、转换器与策略版本、逻辑/物理层数、逐层 Tile/Gaussian/字节/geometricError、尺度异常统计、终端覆盖、Tiles payload 和碰撞校验摘要。发布前要求终端 Tile Gaussian 总数等于 `converted_splats`、逐层总数单调、逻辑层数匹配自动深度、SH 阶数一致且产物不超过上限。

活动版本由 `artifact-manifest.json` 指向 `visual-revisions/<revision>/tiles/`。manifest 切换前旧版持续服务；切换后旧活动版保留七天，可通过受控接口回滚。碰撞仍位于独立目录，视觉重建不复制、不重建、不失效碰撞，也不改变标签和航迹。

## 2. Cesium 运行期策略

稳定浏览阶段固定为：

- `maximumScreenSpaceError = 16`；
- `dynamicScreenSpaceError = false`，只按切片写入的 geometric error 细化；
- `foveatedScreenSpaceError = false`；
- `progressiveResolutionHeightFraction = 0`；
- `skipLevelOfDetail = false`，避免透明 Gaussian 父子层同时渲染产生重影；
- `cullRequestsWhileMoving = false`，保留当前针对 Cesium Gaussian 资源销毁竞争的稳定性设置；
- Tile 缓存 384 MiB，允许额外 128 MiB 临时溢出。
- 浏览器推荐分辨率关闭，有效像素比固定为 `min(devicePixelRatio, 1.5)`；
- 渲染错误恢复不得把 SSE 提高到 32–64，连续失败时停止有界重试并要求重新加载。

### 已发布场景的高清重建

`POST /api/datasets/:id/rebuild-tiles` 只对 `ready` 数据集开放。任务进入 `rebuilding` 后仅从受管源 PLY 重建可视化 Tiles，上一视觉版本、碰撞体、标签和航迹继续服务。新 Tiles 完成质量报告后进入独立 revision，再原子切换 manifest。重建失败时恢复 `ready` 并继续使用旧活动 revision。

根 tileset 继续由稳定 API 提供，但所有内容 URI 指向不可变 revision 路径，避免浏览器一年的缓存命中旧 GLB。重建完成时前端只重新创建该数据集的 Tileset，仍不创建第二个 GS Renderer。

## 3. Luma 风格初始化状态机

初始化效果由两条互相隔离的链路组成：Cesium 公共 3D Tiles 参数负责中心优先流式请求；一个严格锁定 `@cesium/engine 26.1.0` 的 Gaussian 顶点 Shader 变体只负责已加载 Gaussian 的种子生长。它不修改 Tile 遍历、选取、下载、缓存、聚合、深度排序、碰撞数据或标签逻辑，也不增加第二套渲染器和 GS 数据副本。

```text
加载 tileset 元数据
  → 锁定 ScreenSpaceCameraController.enableInputs
  → 相机定位到模型中心，等待首个 Tile（最多 10 秒）
  → 首 Tile 到达后确认 Gaussian Reveal 扩展可用
  → 执行中心优先渐进加载 + 反向斜轨道 1.5 圈环绕
  → 当前 LOD 已选中且已加载的全部 Gaussian 先显示为统一投影尺度种子
  → 0～20 秒投影协方差尺度持续增长；Solid 波从中心向外决定局部成长范围
  → 0～20 秒同步扩大 foveated cone；Alpha Reveal 波作为辅助亮度变化
  → 20 秒内连续改变 heading、pitch 和 range，并等待 initialTilesLoaded
  → 最迟 20.5 秒结束
  → 恢复稳定浏览参数并解锁鼠标
```

初始化参数：

| 参数 | 固定值 |
|---|---:|
| `maximumScreenSpaceError` | 24 |
| `progressiveResolutionHeightFraction` | 0.3 |
| `foveatedScreenSpaceError` | true |
| `foveatedConeSize` | 0.06，整个 20 秒按三次缓出曲线扩展到 1.0 |
| `foveatedMinimumScreenSpaceErrorRelaxation` | 12，整个 20 秒按同一缓出曲线降低到 0 |
| `foveatedTimeDelay` | 0.35 秒 |
| heading | 从 -36° 反向递减 540°，完整环绕 1.5 圈 |
| pitch | 基准 -27°，按正弦在 -34°～-20°之间缓慢倾斜 |
| range | 基准观察距离的约 0.92～1.20 倍，先拉远、再拉近、最终回到基准 |
| 角速度 | 前后 12% 行程缓入缓出，中段保持近似匀速 |
| 相机更新频率 | 最高 30 FPS，减少移动期间 Gaussian 重排压力 |
| 最短动画 | 20 秒 |
| 最长动画 | 20.5 秒 |
| 首 Tile 超时 | 10 秒 |
| Reveal 中心 | 当前 Tileset 包围球中心，即 Gaussian 根 ENU 坐标 `(0,0,0)` |
| Reveal 覆盖半径 | 当前 Tileset 包围球半径的 1.1 倍 |
| 种子投影尺寸 | 4.2 px；相比 3.6 px 轴长增加约 16.7%，片元包围面积约增加 36% |
| 全局尺度进度 | 0～20 秒从 0 线性增长到 1；10 秒仅为 0.5，不提前完成 |
| Reveal 外扩曲线 | 0～20 秒使用 `1-(1-t)^3` 三次缓出：初段快、末段慢 |
| Solid 外扩曲线 | 0～20 秒使用 `1-(1-t)^2` 二次缓出；始终位于 Reveal 波后方 |
| Alpha/S 耦合曲线 | 基线 0.80；目标值在 0～20 秒增长到 1；实际增强进度为 `30% Reveal + 70% Solid/S` |
| Reveal/Solid 羽化 | 场景半径的 6%，限制在 0.2～8 m |
| 慢帧降级 | 可见页面连续 10 帧间隔大于 100 ms 时立即结束效果 |

### 固定的种子生长算法

实现参考 Luma WebGL Library `particleRevealEnabled` 的公开思路，而不引入其 Three/WebGL 渲染器：Luma 将加载半径、显示半径和实体半径作为三个径向波前，实体波滞后于显示波，投影协方差轴从种子尺寸插值到 Gaussian 原始椭圆轴。本平台在 Cesium 已有 Gaussian Primitive 内重新表达同一视觉语义：

1. 用已转换到 Tileset 根 ENU 局部坐标的 `splatPosition` 计算到 `(0,0,0)` 的距离。
2. 当前 Cesium LOD 已选中且已加载、并通过原生投影尺寸剔除的 Gaussian，不再按 `RevealRadius` 隐藏；其屏幕空间主轴和次轴首帧都取 4.2 px。这里的“全部”不包含尚未请求或尚未加载的 Tile。
3. `SolidRadius` 使用二次缓出从中心向外扩张；径向 Solid 与全局 `scaleProgress` 相乘后，才把两条投影协方差轴从统一种子尺度插值回 Cesium 计算的最终椭圆。`scaleProgress` 在整个 20 秒从 0 到 1，因此中心在 10 秒仍只有 50% 的全局成长上限，直到 20 秒才精确恢复最终尺度。
4. Alpha 与尺度共享成长语义：原始每点 Alpha 的初始乘数为 0.80，仅有轻微透明。其目标乘数在 20 秒内线性增长到 1，实际到达进度固定为 `0.30 × RevealAlpha + 0.70 × spikiveSolid`。Reveal 只提供少量提前显现，70% 权重跟随包含全局 `scaleProgress` 的实际轴插值，因此椭球变大时同步变实；Alpha 不单独制造第二套明显动画，也没有 1.75 倍亮度增强。
5. Cesium 原生 foveated cone 在整个 20 秒使用同一 Reveal 三次缓出曲线，从一开始就扩大 Tile 请求优先区。Reveal 与 Solid 都是初段快、末段慢，但 Solid 的二次曲线始终落后于 Reveal，形成先显现、再成长的空间层次。
6. Cesium 原始“小投影 Gaussian”剔除先基于完整协方差执行，随后才压缩种子，避免种子被误判为无效数据。

这是逐 Gaussian 的真实几何投影变化，不再使用白色雾化蒙板。`foveatedConeSize` 仍只决定 Tile 的请求优先级，Shader 只处理已经由 Cesium 按 LOD 选中和流式加载的 Gaussian，因此大场景覆盖与按需加载逻辑不变。全场种子会增加初始化阶段的小面积透明片元，但不增加顶点、纹理或 GS 副本；现有慢帧保护仍会在持续压力过高时提前恢复标准浏览。

### Cesium 隔离边界

- Reveal 与普通路径是同一 Gaussian Primitive 的两个阶段性 Program 变体，不是两个 Renderer，也不会同时提交两个 GS DrawCommand。完整权衡和升级门槛见 [Cesium GS Reveal 渲染架构决策](CESIUM_GS_RENDERING.md)。
- 唯一引擎改动保存在 `patches/cesium-engine-26.1.0/`，由 `scripts/patch-cesium-gs-reveal.mjs` 确定性应用；脚本同时校验精确 engine 版本、JS 锚点、GLSL 锚点和补丁完整标记，结构漂移时拒绝启动构建。
- React 只通过 `gs-reveal-controller.ts` 在 Tileset 上写一个命名扩展状态，不读取 `gaussianSplatPrimitive` 等 Cesium 私有对象。
- Reveal 开启时才编译/取得附带 9 个 uniform 的 Shader 变体。结束或中止时只重建一次原始 Cesium Gaussian Shader；两者来自同一份 `GaussianSplatVS` 主体和受校验的 Reveal 差量，不复制维护两份完整 GLSL。被替换的 `DrawCommand` Shader 引用和 VA 不在当前帧立即销毁，而是进入与纹理一致的退休队列，在下一帧归还 ShaderCache 引用并释放 VA，避免命令队列仍引用资源时触发 `object was destroyed`。LOD 重排、快照替换、Reveal/普通 Shader 切换和 Primitive 销毁都进入同一回收闭环。`spikiveGaussianSplatRevealShaderActive` 只在新命令成功建立后置位，React 会在退出后连续确认其清零。Primitive 销毁还会关闭状态、清零能力/活动标志、清空退休队列并解除状态引用。普通浏览阶段没有 Reveal 条件判断、距离计算或额外数据副本。
- `postinstall`、`predev`、`prebuild` 和 `pretypecheck` 自动应用/校验补丁，避免开发机和部署环境行为漂移。升级 Cesium 前必须重新审计补丁，不能绕过版本保护。
- 前端控制器、Vite `define` 和依赖优化缓存目录共同读取 `cesium-patch-version.ts`；每次补丁升级都会生成新的 Vite Cesium 缓存命名空间，防止开发服务器继续加载旧版优化 Bundle 而错误降级。

Luma WebGL Library 只作为算法研究参考，未作为运行时依赖接入；归档与许可说明见 [第三方参考说明](THIRD_PARTY_NOTICES.md)。

相机轨道固定为斜向 1.5 圈而不是水平正圆：heading 反向运动，pitch 与观察距离在 20 秒内各完成一次低频正弦变化。三组变化都通过 Cesium `camera.lookAtTransform` 完成，不引入额外相机库；首尾距离连续，解除 `lookAt` 变换时不会跳镜头。

## 4. 退出与异常保护

- 初始化期间鼠标旋转、平移、缩放和倾斜全部禁用。
- 正常结束后立即切换为普通 3D Tiles 参数，之后拖动不会再次触发 Luma 效果。
- 首 Tile 超时会结束展示并解锁，不阻塞用户。
- Cesium `renderError`、数据集切换、清除模型和组件销毁都会取消动画、移除事件监听和定时器，并恢复输入。
- 正常退出后最多进行三次短间隔 Shader 路径恢复确认；如果 Reveal 活动标志仍未清零，会继续请求渲染并在控制台与状态栏明确告警。底层旧资源引用按下一帧退休、Cesium ShaderCache 自身周期最终回收，不在当前帧强制删除。
- 扩展缺失、Shader 结构不匹配或持续慢帧会直接降级为标准 Cesium GS；效果失败不能阻止场景使用。
- 不使用 `Viewer.zoomTo` 持有异步 Tile 引用，避免再次出现已销毁对象错误。

## 5. 验收标准

1. 小于等于 25,000 个有效 Gaussian 的新数据只生成一层。
2. 以 2,468,428 个有效 Gaussian 验证时生成最大深度 7、共 8 层；13,518,212 点场景生成最大深度 10、共 11 层。
3. `build_summary.json` 与固定策略不一致时数据集进入 `failed`，不得发布。
4. 初始化期间拖动、滚轮和触摸手势不改变相机。
5. 首 Tile 到达后，相机在约 20 秒内反向环绕 1.5 圈，俯仰和距离均有连续变化，首尾无镜头跳变。
6. 首个可渲染帧中，当前 LOD 已加载 Gaussian 的全部中心以统一 4.2 px 投影轴和 0.80 Alpha 乘数出现；两条投影协方差轴在整个 20 秒持续成长，10 秒不得提前成为最终椭球；Reveal、Solid 和 Tile 请求优先区从中心向外连续扩散并呈现初段快、末段慢的速度，外围在成长波到达前保持种子，不得消失或出现白色雾化遮罩。Alpha 增强的 70% 必须跟随实际 Solid/S 成长，并在 20 秒末与尺度一起恢复原始值。
7. 初始化正常结束、超时、渲染异常或切换数据集后均可立即自由操作。
8. 解锁后 SSE、渐进和中心优先参数恢复稳定浏览值，Shader 恢复 Cesium 原始版本，动画不再次运行。
9. 连续 LOD 重排、Reveal 退出、数据集切换和销毁后，旧 DrawCommand Shader 引用及被替换 VA 均进入延迟回收，不发生已销毁资源被当前帧再次使用，也不持续累积缓存引用。
10. 已发布场景高清重建期间，旧 Tiles、碰撞查询、标签和航迹保持可用；重建失败继续服务旧版，成功后浏览器使用新修订 URI 加载高清 Tile。
