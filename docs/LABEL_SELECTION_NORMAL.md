# 巡检点前表面拾取、法向量与空间标注原理

## 1. 目的与结论

巡检点必须落在操作者当前真正看到的 GS 前表面，不能沿视线穿过前墙后命中背面。当前实现采用 PlayCanvas 2.21.4 原生、启用深度的 `Picker`，让官方 GS 拾取 Pass 在 GPU 上完成 Gaussian 投影、Alpha 阈值、排序和深度遮挡；项目不再维护中心投影 Shader，也不枚举 PlayCanvas 私有 LOD interval。

固定 5px 圆内的前表面深度样本只用于一个很小的 CPU PCA，以计算局部整体朝向。体素 SVO 不参与标签位置和法向，但继续作为无人机避障、机体膨胀扫掠和航线复检的唯一安全真值。

## 2. 为什么旧 Centers 逻辑会穿墙

旧版模仿 SuperSplat Centers 模式：把当前驻留 Gaussian 中心投影到屏幕，只检查中心是否进入 5px 圆。该判断没有像素深度与 Gaussian Alpha，前墙和后墙的中心只要投影落入同一个圆就会同时入选；位置可能落到后墙，PCA 也会混合两个平面。

SuperSplat 官方文档明确区分两类语义：Centers 会选择所有落入区域的中心而不考虑深度，Rings 只选择最上层的可见 Gaussian。当前 V2 选择采用 Rings 的“可见前层”目标，但复用 PlayCanvas 公共 `Picker`，而不是复制 SuperSplat 编辑器的私有材质和选择器。

## 3. 数据流与职责

```text
一次鼠标单击
  → 临时隐藏已有标签 Mesh / 法向线 / Text Element
  → PlayCanvas Picker(depth=true) 执行一次官方 GPU 拾取 Pass
  → 中心像素必须映射到当前 GS Component
  → 中心像素返回 Alpha 合格且深度最近的 GS 世界点
  → 5px 圆内固定 21 像素模板读取同一深度缓冲的前表面点
  → 转回 local Z-up
  → 对有效前表面样本做 3×3 协方差 PCA
  → 法向符号朝向选择时相机
  → 保存视觉版本、位置、法向、采样数和 PCA 统计
```

所有昂贵的 GS 可见性工作都在 PlayCanvas 官方 GPU Pass 中完成。CPU 只处理最多 21 个三维点，不扫描源 PLY、不扫描当前 LOD Gaussian、不建立全量索引，也不执行另一套 Alpha/深度算法。

## 4. 官方 Picker 的可见性含义

初始化固定执行：

```ts
scene.gsplat.enableIds = true;
picker = new Picker(app, 1, 1, true);
```

`enableIds` 使统一 GS placement ID 能映射回当前 `GSplatComponent`；构造函数最后一个 `true` 使 Picker 同时输出深度。一次点击只调用一次 `prepare(camera, scene)`，随后通过公共 `getSelectionAsync` 和 `getWorldPointAsync` 读取结果。

PlayCanvas 的 GS Pick Shader 使用 Gaussian 椭球的屏幕覆盖和 Alpha，并在 Alpha 小于 `alphaClip` 时丢弃片元；当前引擎默认拾取阈值为 0.3。深度缓冲保留同一像素最前方通过阈值的 Gaussian 片元，因此被前墙覆盖的后墙不会成为中心命中。

需要准确描述其边界：这是“单个 Gaussian Alpha 达到拾取阈值后的最近深度”，不是把正常透明混合帧的累计颜色反演成几何表面，也不是飞行碰撞真值。项目不修改 `alphaClip`，以免标签拾取与官方 Renderer 产生第二套参数。

## 5. 固定 5px 圆与法向拟合

交互仍是一次点击、固定半径 5 CSS px，不是可拖动画笔，也不开放半径调参。为避免对同一个 GPU 深度纹理做 81 次小读回，当前模板取中心、内环、中环和 5px 边界共 21 个对称像素。超出画布或没有可见深度的样本被忽略，至少需要 3 个不重复且不共线的点。

中心像素的 `getWorldPointAsync` 结果是标签位置 `P`。其余样本只计算法向：

```text
μ = (1 / n) Σ pᵢ
C = (1 / n) Σ (pᵢ - μ)(pᵢ - μ)ᵀ
```

Jacobi 迭代求解对称矩阵 `C`，最小特征值对应的单位特征向量作为局部拟合平面法向 `N`。样本接近一条线时失败并要求调整视角，不保存任意方向。因为特征向量正负号不唯一，最终执行：

```text
若 N · (cameraLocal - μ) < 0，则 N = -N
```

这使法向朝向选择时相机所在的一侧，符合操作者从物体外侧点击时的观察意图。`normalPlanarity` 和三个特征值只用于诊断，不是安全证明。

## 6. 坐标与版本

持久化真值仍是源 PLY 的局部 Z-up 米制坐标：

```text
local  = (x, y, z)
render = (x, z, -y)
```

Picker 返回 PlayCanvas 世界坐标后，使用当前场景根节点逆矩阵转回 local；位置与法向绝不保存为 Renderer 坐标。

新标签记录：

- `selectionMethod = playcanvas-picker-depth-pca-v2`；
- `pickBackend = playcanvas-native-depth-picker`；
- `selectionDataSource = rendered-alpha-front-surface`；
- 源 PLY SHA-256、活动视觉 revision、5px、有效样本数、PCA 特征值和平面度。

V2 不读取私有 LOD residency，因此旧数据库的 `residentLodLevels` / `residentFileCount` 兼容列写为 `[]` / `0`。历史 V1 标签在其原视觉 revision 内仍可显示；新建接口只接受 V2 证据。激活新视觉 revision 后，无论 V1/V2 都必须重新选择，并使依赖几何的航线失效。

## 7. 标注和观察方向

保存后的标签使用正常深度关系绘制：

1. 小型红色 Sphere Mesh 表示 `P`，选中时变蓝并适度放大；
2. 1m 橙色圆柱从 `P` 沿单位 `N` 延伸；
3. Text Element 锚点位于 `P + N × 1.12m`，文字平面逐帧面向相机。

它们都属于同一 PlayCanvas 场景和 GPU 上下文，能够被建筑正确遮挡。文字沿法向移出表面，但不把文字平面固定为法向朝向，否则常见侧视角会变成不可读的薄边。

名义观察关系为：

```text
preferredObservation = P + N × observationDistance
nominalViewDirection = -N
```

这只是观察意图。最终观察点和航线仍必须通过 SVO 膨胀净空、目标视线、连接航段扫掠与最终复检。

## 8. 生命周期与验收

- 每次点击只准备一次 Picker；异步读回通过场景 generation 丢弃过期结果；
- 已有标注只在准备拾取缓冲时临时禁用，并恢复原 enabled 状态；
- 场景切换、清除或销毁等待当前拾取结束后再销毁唯一 Picker/Application；
- 已删除自定义中心纹理、RGBA 掩码、WGSL/GLSL 选择 Shader、活动 LOD 私有适配和相关缓存清理循环；
- 不修改官方 GS Shader、SOG Loader、LOD 调度、Alpha 参数或视觉输出。

验收重点：

- 同一屏幕位置存在前后两堵墙时，命中前墙而不是后墙；
- 竖直、水平和倾斜表面的法向朝向选择相机侧；
- 轮廓边缘样本不足或退化时明确失败，不保存猜测法向；
- WebGPU 与 WebGL2 都使用 `getSelectionAsync/getWorldPointAsync`；
- 重复点击、缩放、LOD 更替、场景切换和清除显示无资源增长或 destroyed-object 异常；
- 标签位置/法向变化后的航线必须重新规划，体素和规划安全规则不变。

代码位置：

- 官方 Picker 与坐标转换：`src/viewer.ts`；
- 固定模板与 PCA：`src/gaussian-surface-selector.ts`；
- 标签 API 与 V2 证据校验：`server.mjs`；
- SQLite CRUD：`server/label-store.mjs`。
