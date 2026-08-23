# 长期 WebGPU 与 GaussianBackend 路线

## 决策

长期路线是“PlayCanvas 引擎外壳 + 可替换 `GaussianBackend`”，不是从零自研浏览器三维引擎。

PlayCanvas 持续负责：

- WebGPU/WebGL2 设备创建与故障恢复；
- Canvas、相机、输入、场景树和帧生命周期；
- 标签、航点、路线与 UI 投影；
- Asset、请求取消、GPU 资源登记和销毁。

自研边界只覆盖 Gaussian 数据上传、可见性/LOD、排序、投影和混合 Render Pass。Backend 必须注入并共享当前 PlayCanvas `GraphicsDevice`，不得创建第二个 Canvas、第二个 GPUDevice 或第二套相机。

```ts
interface GaussianBackend {
  load(manifest: RenderManifest, signal: AbortSignal): Promise<void>;
  update(camera: CameraState, settings: GaussianRuntimeSettings): void;
  render(pass: GaussianRenderPassContext): void;
  diagnostics(): GaussianDiagnostics;
  destroy(): void;
}
```

以上仅是未来接口方向，本期未加入生产 API。当前实现只使用 PlayCanvas 公共 GSplat 与官方 Streamed SOG 能力。

## 分阶段路线

### 阶段 0：当前基线

- PlayCanvas 2.21.4 单 `GraphicsDevice`；
- WebGPU 优先、WebGL2 回退；
- PlayCanvas 官方 Streamed SOG、原生 Renderer 和原生 LOD；
- SVO 独立承担拾取、法向和碰撞规划；
- 不设置项目自定义预算、LOD、贡献阈值、数据格式、Loader 或 Shader。

只有官方基线完成代表性画质、性能、白边、射线一致性和生命周期门禁后，才允许进入下一阶段。

### 阶段 1：公共接口适配层

在不改变画面的前提下，把现有 GSplat 调用收口为内部 Backend adapter。验收重点是相机、坐标、监控和 destroy 契约，不引入自研 Shader。

### 阶段 2：只替换瓶颈 Render Pass

只有性能剖析证明 PlayCanvas 公共 GS Pass 是稳定瓶颈，且上游无法满足时，才用 WGSL 实现最小替换：Chunk residency、GPU culling/sort 或 splat projection 中的一个。每次只替换一个边界，与 PlayCanvas 基线进行同数据、同相机、同预算 A/B 对照。

禁止重写相机、输入、DOM/UI、标签、路线、设备创建和资源生命周期。公共接口不足时优先贡献上游或维护薄补丁；最后才维护项目内 Gaussian Render Pass。

### 阶段 3：可选高级能力

达到大场景稳定性和维护成本门禁后，再研究时间序列、语义选择或专用渲染算法。所有新能力都必须保持 SVO 安全真值与现有业务契约。

## 语义研究边界

语义目前只是路线储备，不是已实现功能。本期明确不存在：

- semantic 数据库字段或表；
- Sidecar 文件、上传端点或发布产物；
- 语义查询、选择、高亮、标签建议；
- WGSL 语义推理、训练或反向传播。

未来若立项，浏览器只研究前向推理与可视化；训练、微调和反向计算保留在离线 CUDA/PyTorch 流程。WebGPU 是未来语义能力的唯一浏览器后端，WebGL2 只保证基础巡检回退。

候选数据契约是与不可变源 Gaussian 行严格对齐的 `32D float16` Sidecar，并至少绑定源 PLY SHA-256、行数、特征维度、模型/生成器版本和许可 provenance。进入视觉分块时必须产生可验证的行映射或共同重排清单，不能靠文件名猜测对齐关系。这只是候选契约，不应提前出现在当前 schema 或 API。

`non_diff_mechanism` 只作为算法研究线索。任何未来 WGSL 必须独立实现，禁止直接复制 CUDA kernel；立项前要复核项目许可证、数据许可证、模型权利及其引用代码的来源。即使仓库根许可证宽松，也必须逐文件检查可能继承的 Inria/研究用途或非商业限制。

## 进入自研的门禁

只有同时满足以下条件才进入自研 Render Pass：

1. 代表性 PLY 与生产 SOG 的画质差异已排除数据和转换问题；
2. Chrome Tracing、PlayCanvas stats 和宿主监控证明瓶颈位于可替换 GS Pass；
3. PlayCanvas 公共接口、上游修复和参数优化均不能满足目标；
4. 能以同一 `GraphicsDevice` 接入且不影响标签/航线；
5. 有 WebGPU/WebGL2 回退、设备丢失、内存上限和资源销毁测试；
6. 团队接受 WGSL、浏览器兼容性和上游版本升级的长期维护成本。

未满足门禁时，继续维护 PlayCanvas 原生实现，不以“自研”本身作为优化目标。
