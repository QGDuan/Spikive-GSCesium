# 巡检点与表面法向获取实现说明

## 1. 结论

当前巡检点和法向量获取方案以成熟能力复用为主，没有自研第二套 Gaussian Splatting 拾取渲染器，也没有额外编写或注入 GS 拾取 Shader。

| 能力 | 当前实现 | 是否复用成熟逻辑 | 是否自写 Shader |
|---|---|---:|---:|
| 判断点击是否属于 GS | PlayCanvas 官方 `Picker.getSelectionAsync` | 是 | 否 |
| 处理 Gaussian Alpha 和前后遮挡 | PlayCanvas 官方 GS Pick Pass 与深度缓冲 | 是 | 否 |
| 获取巡检点位置 | PlayCanvas 官方 `Picker.getWorldPointAsync` | 是 | 否 |
| 获取局部表面样本 | 同一 Picker 深度结果，固定5px圆内21个像素 | 是，调用公共API | 否 |
| 计算表面法向 | 项目侧小规模CPU PCA | 使用标准数学方法 | 否 |
| 坐标转换、版本绑定和保存 | 项目业务逻辑 | 项目实现 | 否 |
| 飞行碰撞与航线安全 | 独立SVO和后端规划器 | 复用既有安全链路 | 否 |

相较旧方案，新的地方是把“投影所有 Gaussian 中心”的 Centers 选择替换成了 PlayCanvas 原生 Alpha/深度 Picker。PCA、坐标契约和标签业务闭环仍属于项目侧逻辑，但它们不改变 Gaussian 渲染过程。

## 2. 总体处理流程

```text
用户单击5px圆形区域
  ↓
PlayCanvas官方Picker执行一次GPU拾取Pass
  ↓
中心像素必须命中当前GS Component
  ↓
官方Alpha阈值和深度确定中心像素的最前可见Gaussian
  ↓
getWorldPointAsync返回巡检点世界坐标
  ↓
在同一5px圆内读取最多21个前表面深度点
  ↓
世界坐标转换为数据集local Z-up坐标
  ↓
CPU PCA拟合局部平面法向，并将正方向调整到相机侧
  ↓
后端校验并保存位置、法向、视觉版本和拟合证据
```

整个流程只使用一个 PlayCanvas `Application`、一个 Canvas、一个 `GraphicsDevice` 和一个 `Picker`，没有第二个渲染上下文。

## 3. 巡检点位置如何获取

### 3.1 初始化官方 Picker

系统初始化时启用 PlayCanvas 的统一 GS 拾取 ID，并创建带深度输出的 Picker：

```ts
scene.gsplat.enableIds = true;
picker = new Picker(app, 1, 1, true);
```

- `enableIds` 让官方 GS placement ID 能映射回当前 `GSplatComponent`；
- `Picker` 最后一个参数为 `true`，表示同时生成拾取深度；
- WebGPU 和 WebGL2 都调用相同的 PlayCanvas 公共接口。

### 3.2 一次GPU拾取Pass

用户点击后，系统先临时隐藏已有巡检点 Mesh、法向线和文字，避免业务标注挡住 GS；随后只调用一次：

```ts
picker.prepare(camera, app.scene);
```

这个 Pass 由 PlayCanvas 官方 Renderer 执行。Gaussian 的屏幕椭球覆盖、Alpha 判断、排序和深度测试都由官方引擎负责。

### 3.3 前表面与Alpha判断

当前固定版本 PlayCanvas 2.21.4 的官方 GS Pick Shader 会计算 Gaussian 在当前像素的 Alpha。当 Alpha 低于引擎的 `alphaClip` 时，该片元被丢弃；通过阈值的片元再由深度缓冲确定最前方结果。

因此，当同一条视线上同时存在前墙和后墙时：

- 前墙在该像素具有足够 Alpha 时，前墙写入更近的拾取深度；
- 后墙被前墙遮挡，不会成为中心命中；
- 不再出现旧 Centers 方案中“只看中心投影、不看深度”造成的穿墙选择。

系统没有修改官方 `alphaClip`，也没有重新实现透明混合或 Gaussian 覆盖计算。

### 3.4 中心像素成为巡检点

中心像素必须先通过：

```ts
picker.getSelectionAsync(...)
```

确认其属于当前 GS Component。随后通过：

```ts
picker.getWorldPointAsync(...)
```

取得该像素的前表面世界坐标。这个坐标经过场景根节点逆矩阵转换，保存为源数据的局部 Z-up 米制坐标：

```text
render = (x, z, -y)
local  = (x, -z, y)
```

这个 local 坐标就是巡检点位置 `P`。

## 4. 法向量如何获取

### 4.1 为什么不能只用一个点

单个三维点只能确定位置，不能确定表面朝向。因此系统围绕点击中心，在固定半径5px的圆内读取局部前表面。

当前使用中心、内环、中环和圆边界组成的21个对称像素模板。每个像素仍调用同一官方 Picker 的 `getWorldPointAsync`，所以每个样本都是该像素经过官方 Alpha和深度处理后的最前可见结果。

这样做的目的包括：

- 避免扫描源 PLY；
- 避免遍历当前 LOD 的全部 Gaussian；
- 避免建立第二份大规模空间索引；
- 把CPU输入固定在最多21个三维点；
- 保留局部表面的整体几何趋势，而不是依赖一个 Gaussian 的偶然朝向。

### 4.2 PCA局部平面拟合

假设得到有效样本 `p₁ ... pₙ`，先计算质心：

```text
μ = (1 / n) Σpᵢ
```

再计算3×3协方差矩阵：

```text
C = (1 / n) Σ(pᵢ - μ)(pᵢ - μ)ᵀ
```

协方差矩阵最小特征值对应的特征向量，是局部点集变化最小的方向，因此作为拟合平面的单位法向 `N`。

项目侧使用 Jacobi 迭代求解这个3×3对称矩阵。这里确实有项目代码，但它只是标准、小规模CPU几何计算：

- 不参与 GS 渲染；
- 不读取 Gaussian Shader 数据；
- 不创建 GPU Compute Pass；
- 不修改 PlayCanvas 的渲染或 LOD；
- 最多处理21个点，计算量相对于一次GPU拾取可以忽略。

### 4.3 法向正方向

PCA特征向量的正负号在数学上等价。为了让法向表达操作者所在的外侧，系统使用点击时的相机位置确定符号：

```text
若 N · (cameraLocal - μ) < 0，则 N = -N
```

最终得到的 `N` 朝向点击时相机一侧。后续规划的名义观察关系为：

```text
观察候选位置 = P + N × 观察距离
名义观察方向 = -N
```

该关系只表达观察意图，最终观察点和航线仍必须经过SVO净空、视线和机体膨胀扫掠复检。

## 5. 哪些逻辑是复用的，哪些是项目实现

### 5.1 直接复用的成熟能力

系统直接复用以下 PlayCanvas 官方能力：

- GS Component与统一placement ID；
- GS Pick Pass；
- Gaussian屏幕投影；
- Gaussian Alpha计算和`alphaClip`；
- 深度缓冲与最前片元判断；
- WebGPU/WebGL2设备适配；
- `Picker.prepare`；
- `Picker.getSelectionAsync`；
- `Picker.getWorldPointAsync`；
- Picker和Application资源生命周期。

方案设计也参考了SuperSplat对Centers与Rings选择语义的成熟划分：Centers不考虑深度，Rings强调最上层可见Gaussian。当前系统没有复制SuperSplat编辑器的私有Picker或自定义材质，而是使用PlayCanvas公开API实现所需的前表面语义。

参考资料：

- [PlayCanvas Scene Picker](https://developer.playcanvas.com/user-manual/graphics/cameras/scene-picker/)
- [SuperSplat Selection and Cleanup](https://developer.playcanvas.com/user-manual/supersplat/editor/editing-splats/)

### 5.2 项目侧保留的必要逻辑

项目只实现与巡检业务有关的部分：

- 固定5px、21像素采样模板；
- 世界坐标到local Z-up的统一转换；
- 3×3协方差PCA和法向符号处理；
- 无效、重复和近共线样本拒绝；
- 标签视觉版本、源摘要和选择证据绑定；
- SQLite持久化及标签增删改查；
- 标签Mesh、1m法向线和文字位置；
- SVO碰撞和后端航线规划的数据交接。

这些逻辑没有重新实现Gaussian渲染、Alpha合成、深度测试或LOD调度。

## 6. 是否额外编写了Shader

没有。

当前标签选择链路中不存在项目自写的：

- GLSL选择Shader；
- WGSL选择Shader；
- Gaussian中心投影Shader；
- RGBA选择掩码Shader；
- 自定义GS Render Pass；
- 自定义Chunk Loader；
- 第二套Renderer或GPU上下文。

旧版本曾有一个Centers风格的项目选择Shader，它会投影当前驻留Gaussian中心并生成RGBA布尔掩码。该文件和相关中心纹理、掩码纹理、私有LOD interval适配、缓存清理循环已经从当前实现中删除。

现在标签选择完全进入PlayCanvas官方Picker路径，项目不会维护两套Alpha、深度或Gaussian覆盖逻辑。

## 7. 系统鲁棒性评估

### 7.1 已具备的鲁棒性

当前方案对巡检标注业务是鲁棒的，主要依据如下：

1. **前后表面有统一真值**：同一像素的Alpha和深度由PlayCanvas官方GS Pick Pass决定，不再用项目逻辑猜测。
2. **失败闭合**：中心没有命中GS、有效样本少于3个或样本接近共线时，明确失败并要求重新选择，不保存任意点或任意法向。
3. **单一渲染所有权**：一个Application、Canvas、GraphicsDevice和Picker，不存在双Renderer同步与资源重复。
4. **异步防过期**：拾取期间使用`pickerBusy`防重入；场景加载期间禁止选择；异步结果返回后检查场景generation，过期结果直接丢弃。
5. **标注不干扰GS拾取**：准备Pick Pass时临时隐藏已有标签对象，并精确恢复它们之前的enabled状态；体素调试网格固定`pick=false`。
6. **坐标单一**：位置和法向最终统一转换并保存为local Z-up，渲染坐标不会进入数据库或规划器。
7. **版本闭环**：标签绑定源摘要和活动视觉revision；视觉版本变化后旧标签变为过期，不能无提示继续用于有效航线。
8. **后端二次校验**：创建接口校验固定5px、样本数量、单位法向、PCA特征值、平面度和V2选择来源，前端不能随意伪造另一种选择方式。
9. **生命周期有界**：Picker只创建一次；场景清除和Application销毁采用generation和busy状态保护，避免异步回调访问已销毁对象。
10. **有自动化约束**：测试覆盖平面法向、相机侧符号、退化样本拒绝，以及“不允许恢复自定义GS选择Shader”的架构规则。

当前用户现场验证已经确认，巡检点和法向能够正确获取，这补充了自动化数学测试之外的真实GS场景验证。

### 7.2 必须保留的能力边界

鲁棒不等于把透明GS变成了真实实体表面。当前仍有以下明确边界：

- Picker使用的是“单个Gaussian Alpha达到官方拾取阈值后的最近深度”，不是对最终透明混合颜色做逆向几何重建；
- 5px范围跨越物体轮廓、尖角或两个都真实可见的相邻表面时，样本可能不再属于单一平面，应调整视角或重新点击；
- 法向是局部可见表面的PCA近似，不是源Gaussian的语义法向，也不是测绘级法线；
- 标签几何来自当前活动视觉revision，LOD或视觉版本发生变化时必须遵守版本失效规则；
- 该位置和法向可以产生观察意图，但不能直接证明无人机安全；飞行净空、视线和航段安全必须继续由完整源PLY生成的SVO及后端规划器验证。

因此，准确结论是：

> 当前方案对“交互式获取当前可见GS前表面的巡检点与局部法向”具有清晰、单一且失败闭合的实现链路；它复用了成熟的PlayCanvas GPU拾取能力，没有额外Shader，维护风险较低。它不是碰撞或飞行安全真值，必须继续与SVO安全链路配合。

## 8. 实现位置

- PlayCanvas官方Picker调用、标注隐藏恢复、坐标转换和生命周期：`src/viewer.ts`
- 固定21像素模板、PCA、退化检查和V2证据：`src/gaussian-surface-selector.ts`
- 后端选择证据和输入校验：`server.mjs`
- 标签数据库：`server/label-store.mjs`
- 自动化测试：`scripts/gaussian-surface-selector.test.mjs`
- 更完整的数学、展示和观察方向契约：`docs/LABEL_SELECTION_NORMAL.md`
