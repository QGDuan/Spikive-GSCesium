# Spikive GS Inspector

完全本地部署的 Gaussian Splatting 巡检平台。当前主线以 PlayCanvas 官方能力直接显示 GS，并从同一份不可变 GraphDECO PLY 独立生成碰撞体素；视觉转换不再包含项目自定义切片、格式补丁、预算或 LOD 调参。

当前固定版本：

- `playcanvas@2.21.4`
- `@playcanvas/splat-transform@3.3.0`（官方未修改 Release）

## 快速开始

要求 Node.js `>=22.22.1`，推荐使用最新版 Chrome 或 Edge。

```bash
npm install
npm run dev
```

开发页面默认是 `http://localhost:5173`，API 默认是 `http://localhost:3000`。完整检查：

```bash
npm run verify
npm run audit:data
```

构建客户测试包：

```bash
RELEASE_VERSION=v0.2.0-beta.2 RELEASE_TARGET=macos-arm64 npm run release:customer
RELEASE_VERSION=v0.2.0-beta.2 RELEASE_TARGET=windows-x64 node scripts/build-customer-package.mjs
```

安装包完全本地运行，不需要 Token 或商业云服务，也不包含开发机已有的模型、数据库、标签或航迹。

## 固定系统边界

- PlayCanvas 是唯一 Renderer，只创建一个 Canvas 和一个 `GraphicsDevice`；浏览器优先 WebGPU，不可用时由 PlayCanvas 回退 WebGL2。
- 视觉构建严格采用 splat-transform 官方 Streamed SOG 示例：源 PLY 为 LOD0，再生成 50%、25%、10% 三个 LOD，最后输出 `lod-meta.json`。
- 不向视觉命令附加 Chunk 尺寸、范围、过滤、旋转、格式、GPU、内存预算或项目私有参数；512K Chunk 和 16 m extent 等均来自上游默认值。
- 前端用 PlayCanvas 原生 `gsplat` Asset/Component 加载 `lod-meta.json`，不设置 Gaussian 预算、LOD 范围、距离倍率、贡献阈值、数据格式或自定义 Loader。
- 唯一保留的额外数据生成是从全量源 PLY 独立生成 SVO 与碰撞调试网格。SVO 是拾取、法向量、机体膨胀和航迹碰撞检查的真值，视觉 LOD 不参与这些计算。
- 视觉 revision 与碰撞、标签、任务独立管理。视觉重建失败时旧版本继续服务，不自动换参数。
- 局部 Z-up 米制坐标是数据真值；标签与任务绑定数据集，被任务引用的标签必须先删除任务才能删除。
- 性能面板只读显示 WebGPU/WebGL2、FPS 和资源统计，不反馈或修改引擎配置。
- `var/` 是业务数据，不是构建缓存；禁止随代码清理。

## 文档

- [客户测试使用说明](docs/CUSTOMER_GUIDE.md)
- [系统架构与数据依赖闭环](docs/ARCHITECTURE.md)
- [PlayCanvas 官方 Streamed SOG](docs/PLAYCANVAS_RENDERING.md)
- [API 与删除依赖规则](docs/API.md)
- [长期 WebGPU 路线](docs/WEBGPU_ROADMAP.md)
- [Cesium 历史版本说明](docs/CESIUM_ARCHIVE.md)
- [第三方组件与许可](docs/THIRD_PARTY_NOTICES.md)
