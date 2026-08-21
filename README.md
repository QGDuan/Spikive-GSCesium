# Spikive GS Inspector

自托管的 React Gaussian Splatting 巡检平台：上传 GraphDECO PLY，生成 Cesium Gaussian 3D Tiles、候选 AHoLo Chunk LOD 与独立碰撞 SVO，手动拾取场景标签，并由标签和碰撞约束生成无人机候选航迹。

> 客户测试请优先使用 GitHub Release 中的 `Spikive-GS-Inspector-*-customer.zip`，按照包内《使用说明》安装。项目经理可直接在使用说明预留位置补充操作截图。

## 客户使用

- [客户测试使用说明：前置条件、启动和业务使用](docs/CUSTOMER_GUIDE.md)
- 客户安装包不包含仓库 `var/` 中的模型、数据库、标签或航迹；首次启动会建立独立数据目录。
- 默认生产入口为 `http://localhost:3000`，同一个服务同时提供页面和 API。

## 开发运行

要求 Node.js `>=22.22.1`，本机需具备转换工具可识别的 GPU。

```bash
npm install
npm run dev
```

前端默认访问 `http://localhost:5173`，API 默认访问 `http://localhost:3000`。生产检查执行：

```bash
npm run verify
npm run audit:data
```

构建客户测试包：

```bash
RELEASE_VERSION=v0.1.0-beta.1 npm run release:customer
```

输出位于 `release/`，该目录仅保存本地发布产物并被 Git 忽略。

大场景可通过 `COLLISION_CACHE_BYTES` 设置服务端已发布 SVO 的 LRU 字节预算，默认 512 MiB；它不改变碰撞构建精度。

`var/` 包含 SQLite、受管源 PLY、处理中间产物和已发布数据，不属于构建缓存，禁止随代码清理。模型、标签和任务的永久删除只能通过对应 API/界面执行。

## 固定边界

- 显示 GS 与碰撞模型分离；前端透明深度不作为飞行安全依据。
- 标签和任务始终绑定数据集；被任务引用的标签不可删除。
- 航线任务显示建立/碰撞计算状态并支持逐条重新计算和永久删除；地图上标签观察点为红色、算法途经点为蓝色。
- 航线起点可使用自由空间 Home，也可绑定一个巡检标签；标签模式仍会先生成碰撞安全的自由空间起点，并在任务结束时返回该点。
- Luma 风格 Reveal 只在 Cesium 单一 GS 渲染链初始化阶段运行，解锁后恢复原生 Shader。
- `/renderer-lab` 使用独立 AHoLo 单 Renderer 验证本地大场景；生产场景在 Cesium/AHoLo 间互斥挂载，绝不双 Canvas 叠加。AHoLo 视图复用后端 SVO 拾取、法向与规划真源，并提供会话级 LOD/minLevel/预算调参。
- 碰撞内存超限只给人工调参建议，不自动改变体素精度。
- 规划结果是候选路线，真实飞行前必须完成现场与机型安全复核。

## 文档

- [系统架构、数据闭环与碰撞分区边界](docs/ARCHITECTURE.md)
- [GS LOD 与初始化展示策略](docs/LOD_AND_INTRO.md)
- [Cesium GS Shader 生命周期决策](docs/CESIUM_GS_RENDERING.md)
- [AHoLo Renderer 迁移与验收](docs/AHOLO_RENDERER_MIGRATION.md)
- [API 与删除依赖规则](docs/API.md)
- [第三方参考与许可](docs/THIRD_PARTY_NOTICES.md)
- [客户测试使用说明](docs/CUSTOMER_GUIDE.md)
