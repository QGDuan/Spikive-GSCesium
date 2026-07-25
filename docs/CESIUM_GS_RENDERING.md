# Cesium GS Reveal 渲染架构决策

本文回答初始化透明度/种子成长效果是否应合并进 Cesium 常驻 Shader，以及当前方案是否存在双渲染器、重复数据和长期维护风险。该决策适用于当前锁定的 `cesium 1.143.0` / `@cesium/engine 26.1.0`。

## 1. 最终决策

保留“Cesium 原生基线 Shader + 仅初始化阶段使用的 Reveal Shader 变体”，不改成一个永久包含 Reveal 分支的常驻 Shader，也不引入 Luma、Three.js 或第二个 WebGL Renderer。

这不是两套渲染系统。运行时拓扑始终是：

```text
一个 Cesium Viewer
  └─ 一个 Cesium3DTileset
      └─ 一个 GaussianSplatPrimitive（聚合当前 LOD 已选中的 splat）
          └─ 一个 DrawCommand
              └─ 当前阶段唯一活动的 ShaderProgram
                   ├─ 初始化阶段：Reveal 变体
                   └─ 普通浏览：Cesium 原生基线版本
```

Reveal 与基线 Program 不会在同一帧重复绘制同一批 Gaussian。切换时先建立新 DrawCommand，旧 Program 引用和必要的旧 VertexArray 进入一帧退休队列，下一帧才归还 Cesium ShaderCache 引用或释放资源。

## 2. “两个 Shader”的准确含义

代码库没有复制维护两份完整 Gaussian Shader。唯一上游主体仍是 Cesium 的 `GaussianSplatVS`；Reveal 代码通过两个受校验的 GLSL 锚点生成一个差量变体：

```text
GaussianSplatVS
  ├─ 原样使用                         → 基线 Program cache key
  └─ 注入种子尺寸、Alpha/Solid 波逻辑 → Reveal Program cache key
```

因此需要维护的是“一份上游 Shader + 一份小型、版本锁定的差量”，而不是两个会独立漂移的渲染实现。GPU/ShaderCache 在一次初始化生命周期中可能先后见到两个 cache key，但 GS 纹理、排序索引、Tile、Primitive、VertexArray 和 DrawCommand 槽位都不会复制成两套常驻系统。

## 3. 方案比较

| 方案 | 普通浏览成本 | 故障隔离 | 维护性 | 结论 |
|---|---|---|---|---|
| 阶段性 Reveal 变体（当前） | Reveal 结束后回到原生路径，无 Reveal uniform、分支或距离计算 | 效果失败可立即退回基线 Shader | 维护一份差量和精确版本锚点 | **采用** |
| 一个永久组合 Shader | 每个 Gaussian 顶点长期执行或携带 Reveal 分支和 9 个 uniform；驱动是否完全消除分支不可保证 | Reveal GLSL 错误会影响所有普通 GS 浏览 | 表面上少一次切换，实际扩大私有改动面 | 不采用 |
| 第二个 Luma/Three/WebGL Renderer | 双上下文、双相机、双排序、双显存/内存数据及合成成本 | 两套生命周期和透明排序容易失配 | 依赖和调试面最大 | 禁止 |
| Cesium 官方公共 GS Reveal/Custom Shader 扩展 | 取决于官方实现 | 最佳 | 最佳 | 官方能力成熟后迁移 |

阶段性变体只付出每个数据集初始化时至多一次 Reveal Program 编译/获取和一次回到基线 DrawCommand 的重建。对大场景而言，普通浏览持续数分钟或数小时，避免永久的逐 Gaussian 运算比省掉一次阶段切换更重要。

## 4. 性能边界

初始化阶段额外成本仅发生在已经被 Cesium LOD 选中并加载的 Gaussian 上：

- 顶点侧增加中心距离、两个平滑波前、协方差轴长度与插值运算；
- 每个 DrawCommand 增加 9 个 uniform 读取；
- 全场固定投影尺度种子增加少量小面积透明片元；
- 相机更新限制为最高 30 FPS，连续慢帧会提前终止效果；
- 不增加 Tile 请求副本、GS 属性纹理副本、排序器副本、Canvas 或 WebGL context。

普通浏览阶段恢复 Cesium 原始 Shader 源码和 uniform 集，Reveal 顶点运算与条件分支为零。Shader Program 本身的临时缓存占用远小于 GS 属性纹理；引用在安全退休后归还 ShaderCache，由 Cesium 在自己的帧末回收策略中最终删除。

## 5. 系统影响与隔离

| 系统 | 影响 |
|---|---|
| 非 Gaussian 3D Tiles、地球、影像、Entity | 不经过 `GaussianSplatPrimitive`，不受影响 |
| 未开启 Reveal 的 Gaussian Tileset | 使用 Cesium 原始 Shader；不会执行 Reveal 运算 |
| 同页多个 Viewer/Tileset | Reveal 状态绑定各自 Tileset；ShaderCache 绑定各自 WebGL Context，不共享可变动画状态 |
| LOD、Tile 下载、聚合、排序 | 继续由 Cesium 原生逻辑负责，Reveal 只读取已聚合 splat 的局部坐标和投影协方差 |
| 标签、碰撞、航迹、上传和数据库 | 完全位于渲染链之外，不读取 Reveal 状态，不受透明度变化影响 |

引擎补丁中资源退休逻辑会覆盖该 Cesium bundle 内的全部 Gaussian Primitive，因为它同时修复正常排序、快照替换和销毁时的 DrawCommand 资源所有权问题；它不作用于非 Gaussian Primitive。这是当前方案比视觉算法更需要重点回归的私有引擎边界。

## 6. 安全结论与剩余风险

当前方案在以下约束下是可控且适合继续使用的：

1. 精确锁定 `@cesium/engine 26.1.0`；版本或源码锚点变化时构建失败，不静默套用补丁。
2. React 只写 Tileset 上的 `spikiveGaussianSplatReveal` 命名状态，不访问私有 Primitive。
3. 任意正常结束、超时、慢帧、切场景、删除、渲染错误或卸载都关闭 Reveal，并确认活动标志清零。
4. DrawCommand、ShaderProgram 和 VertexArray 统一走一帧退休队列，避免当前帧仍引用已销毁对象。
5. Reveal 不参与拾取和航迹安全判断；碰撞模型仍是唯一几何查询依据。

它不是“零风险公共 API 方案”。剩余风险主要是 Cesium Gaussian 本身仍属实验路径，以及版本升级可能改变 Primitive、Shader、ShaderCache 或排序生命周期。该风险通过版本钉死、差量补丁、失败关闭、代表性 GPU 验收和普通路径恢复来控制，不能靠单元测试完全消除。

## 7. 何时允许改成一个 Shader

只有同时满足以下条件才重新评估永久组合 Shader：

- Cesium 官方提供稳定的 Gaussian Custom Shader、透明度/协方差样式钩子或等价公共扩展；
- 能证明禁用状态由编译期 specialization 消除，而不是数百万顶点上的运行期分支；
- 普通浏览 GPU 基准、Shader 编译失败隔离和 context restore 均不劣于当前方案；
- 不再需要私有 DrawCommand 重建和资源所有权补丁，或相应逻辑已由 Cesium 官方修复。

在此之前，“一个常驻 Shader”不是简化，而是把一次性的视觉成本变成永久成本，并让初始化效果故障扩大到标准浏览。

## 8. 发布与升级检查

- `npm run check:cesium-patch` 必须通过，且生产/开发使用同一补丁版本。
- `npm run check:rendering-architecture` 必须通过；它拒绝前端第二渲染器依赖、额外 WebGL context，以及同时提交基线/Reveal Shader 的结构漂移。
- 补丁版本必须同时驱动控制器能力判断和 Vite 依赖优化缓存目录；不得让就地补丁后的 Cesium 源码与旧的预打包 Bundle 混用。
- 前端依赖树不得加入 Luma/Three 渲染器；服务端转换工具的传递依赖不进入 WebGL 运行时。
- 用代表性 GS 验证 Reveal 开始、完成、中止和场景切换，确认每帧只有一个 GS DrawCommand 路径。
- 检查初始化结束后的活动标志、ShaderCache 引用、退休队列和 GPU 内存趋于稳定。
- 近距离缩放、跨 LOD 移动、快速切换/清除数据集时不得出现 `object was destroyed` 或持续 Program/VA 增长。
- Cesium 升级必须重新审计 `GaussianSplatPrimitive`、原始 GLSL 锚点、ShaderCache 引用计数和 DrawCommand 提交顺序。
