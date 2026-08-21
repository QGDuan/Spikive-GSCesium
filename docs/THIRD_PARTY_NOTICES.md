# 第三方组件与许可说明

本文件列出当前 AHoLo-only 主线中与 GS 显示和碰撞处理直接相关的核心第三方组件。完整传递依赖以 `package-lock.json` 和各安装包随附许可为准。

## AHoLo Viewer

- 包：`@manycore/aholo-viewer@1.8.1`
- 仓库：<https://github.com/manycoretech/aholo-viewer>
- 许可：MIT
- 用途：浏览器端 WebGL2 Gaussian、Chunk LOD、相机、点线和 Sprite 渲染。

## AHoLo Splat Transform

- 包：`@manycore/aholo-splat-transform@1.7.4`
- 仓库：<https://github.com/manycoretech/aholo-viewer>
- 许可：MIT
- 用途：服务端把 GraphDECO PLY 分块为无损 PLY Chunk，并转换为高精度 ESZ v2。
- 该包包含平台相关的可选原生依赖；当前客户交付目标为 macOS arm64 与 Windows x64。

## PlayCanvas Splat Transform

- 包：`@playcanvas/splat-transform@3.1.6`
- 仓库：<https://github.com/playcanvas/splat-transform>
- 许可：MIT
- 用途：服务端生成 SVO 和 collision GLB，供标签表面解析和航迹碰撞计算使用。
- 它不作为浏览器 Renderer，不进入 AHoLo 前端绘制链。

## 已退役参考

旧 Cesium/Reveal/Luma 研究代码不属于当前 `main` 的运行时或构建依赖。其历史实现只保存在冻结标签 `v0.1.0-cesium-final`，详见 [Cesium 归档说明](CESIUM_ARCHIVE.md)。
