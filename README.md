# Spikive GS Inspector

自托管的 AHoLo Gaussian Splatting 巡检平台：上传 GraphDECO PLY，生成 AHoLo Chunk LOD 与独立碰撞 SVO，手动拾取巡检标签，并依据标签、表面法向和碰撞约束生成无人机候选航迹。

当前 `main` 只使用 AHoLo，不安装、加载或运行 Cesium。迁移前的完整 Cesium/AHoLo 共存版本已永久保存在分支 `archive/cesium-final` 和标签 `v0.1.0-cesium-final`，详见 [Cesium 归档说明](docs/CESIUM_ARCHIVE.md)。

> 客户测试请按电脑使用 GitHub Release 中的 `macos-apple-silicon.zip` 或 `windows-x64.zip`，按照包内《使用说明》安装。项目经理可直接在使用说明预留位置补充操作截图。

## 客户使用

- [客户测试使用说明：前置条件、启动和业务使用](docs/CUSTOMER_GUIDE.md)
- 客户安装包不包含仓库 `var/` 中的模型、数据库、标签或航迹；首次启动会建立独立数据目录。
- 默认生产入口为 `http://localhost:3000`，同一个服务同时提供页面和 API。

## 开发运行

要求 Node.js `>=22.22.1`、WebGL2 浏览器，以及 AHoLo 转换工具可用的本机 GPU。

```bash
npm install
npm run dev
```

开发页面默认访问 `http://localhost:5173`，API 默认访问 `http://localhost:3000`。生产检查执行：

```bash
npm run verify
npm run audit:data
```

构建 Apple Silicon Mac 和 Windows x64 客户测试包：

```bash
RELEASE_VERSION=v0.1.0-beta.3 RELEASE_TARGET=macos-arm64 npm run release:customer
RELEASE_VERSION=v0.1.0-beta.3 RELEASE_TARGET=windows-x64 node scripts/build-customer-package.mjs
```

输出位于 `release/`，该目录仅保存本地发布产物并被 Git 忽略。完整支持目标为 Apple Silicon Mac 和 Windows x64；Intel Mac 与 Windows ARM64 当前不在交付范围。

大场景可通过 `COLLISION_CACHE_BYTES` 设置已发布 SVO 的服务端 LRU 字节预算，默认 512 MiB；它不改变碰撞构建精度。

`var/` 包含 SQLite、受管源 PLY、处理中间产物和已发布数据，不属于构建缓存，禁止随代码清理。模型、标签和任务的永久删除只能通过对应 API 或界面执行。

## 固定系统边界

- AHoLo 是 `main` 唯一前端 Renderer；不再保留 Renderer 切换、双 Canvas 或隐式降级。
- 显示 GS 与碰撞模型分离；透明 GS 的前端深度不作为飞行安全依据。
- 源数据固定为 GraphDECO、局部 Z-up、米制坐标；显示时只在适配层映射为 AHoLo 坐标。
- AHoLo LOD、预算和调度参数只影响当前浏览器会话，不改变碰撞、标签或航迹。
- 标签和任务始终绑定数据集；被任务引用的标签不可删除。
- 巡检标签及关联观察航点为红点，算法途经点为蓝点；内部 `hj_<标签名>` 只保留关联语义，不重复显示文字。
- 碰撞内存超限只给人工调参建议，不自动改变体素精度。
- 规划结果是候选路线，真实飞行前必须完成现场与机型安全复核。

## 文档

- [系统架构与数据管理闭环](docs/ARCHITECTURE.md)
- [AHoLo 渲染、Chunk LOD 与生命周期](docs/AHOLO_RENDERING.md)
- [API 与删除依赖规则](docs/API.md)
- [Cesium 冻结版本与回退说明](docs/CESIUM_ARCHIVE.md)
- [第三方组件与许可](docs/THIRD_PARTY_NOTICES.md)
- [客户测试使用说明](docs/CUSTOMER_GUIDE.md)
