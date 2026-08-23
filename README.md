# Spikive GS — PlayCanvas 官方 Streamed SOG 基线

这是从零搭建的 `dev` 基线，只验证 PlayCanvas 官方的两条最小路径：直接显示原始 Gaussian Splatting PLY，以及加载官方 Streamed SOG 切片。

当前版本明确不包含：

- 体素、碰撞检测和航线规划；
- 标签、数据库、后端服务；
- Cesium、AHoLo、React 或第二个渲染器；
- 自定义 Gaussian Shader、透明度修正、点数预算或画质参数。

## 环境

- Node.js 22.22.1 或更高版本
- 支持 WebGPU 或 WebGL2 的现代浏览器
- 原始数据：`/Users/duanqg/Downloads/point_cloud.ply`

项目固定使用 `playcanvas@2.21.4`。程序优先请求 WebGPU；若不可用，由 PlayCanvas 自身回退到 WebGL2。

## 首次启动

```bash
cp /Users/duanqg/Downloads/point_cloud.ply public/data/point_cloud.ply
npm install
npm run build:lod
npm run dev
```

浏览器打开终端显示的地址，默认通常是 <http://localhost:5173>。

## 重新生成官方 Streamed SOG

```bash
npm run build:lod
```

该命令只编排官方 `splat-transform@3.3.0` 的标准流程：

1. 从原始 PLY 独立生成 90%、75%、60%、40%、20%、10% 六份抽稀 PLY；
2. 将原始 PLY 标记为 LOD0，将六份抽稀数据标记为 LOD1–6；
3. 输出 `public/data/point_cloud-lod/lod-meta.json`。

没有传入 Chunk 数量、Chunk 尺寸、过滤、格式、GPU、内存或项目自定义参数。输出目录已存在时脚本会停止，避免静默覆盖测试结果。

## 操作

- 左键拖动：旋转
- 中键拖动或 Shift + 左键拖动：平移
- 滚轮：缩放

## 数据说明

当前 `point_cloud.ply` 为二进制 PLY，包含 14,224,203 个 Gaussian，文件大小 967,246,731 字节。它继续保留为无切片、无降采样画质基线；Streamed SOG 的 LOD0 也以它作为完整细节输入。

本次官方产物包含七层，密度依次为 100% / 90% / 75% / 60% / 40% / 20% / 10%，实际数量为 14,224,203 / 12,801,783 / 10,668,152 / 8,534,522 / 5,689,681 / 2,844,841 / 1,422,420 Gaussian。七层共 56,185,602 个跨层条目、106 个空间 Chunk、637 个文件，磁盘占用约 650 MiB。前端直接加载 `lod-meta.json`，没有设置任何项目自定义的 LOD 距离、预算或画质参数。

PlayCanvas 2.21.4 的默认 LOD 距离为 `lodBaseDistance = 5`、`lodMultiplier = 3`，第 `i` 个切换距离按 `5 × 3^i` 计算并由相机 FOV 补偿。当前七层大致对应 5 / 15 / 45 / 135 / 405 / 1215 米的切换边界。需要单独验证距离策略时，可在 GS 实体创建后设置 `splat.gsplat.lodBaseDistance` 和 `splat.gsplat.lodMultiplier`；本基线暂不覆盖官方默认值，以便先隔离验证增加密度层是否解决中距离清晰度问题。

`public/data/*.ply` 不进入 Git，避免把近 1 GiB 的研究数据提交到代码仓库。每台开发机首次运行前只需复制一次。
