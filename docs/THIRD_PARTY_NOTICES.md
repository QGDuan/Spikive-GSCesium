# 第三方组件与许可说明

本文件列出当前主线中与 GS 显示和碰撞直接相关的核心组件。完整传递依赖及精确许可文本以 `package-lock.json`、安装包随附文件和发布时的软件物料清单为准。

## PlayCanvas Engine

- 包：`playcanvas@2.21.4`
- 仓库：<https://github.com/playcanvas/engine>
- 许可：MIT
- 用途：生产浏览器的单 Renderer；提供 WebGPU/WebGL2 设备、官方 Streamed SOG、GS 排序、相机、场景和资源生命周期。

## PlayCanvas Splat Transform

- 包：`@playcanvas/splat-transform@3.3.0`
- 仓库：<https://github.com/playcanvas/splat-transform>
- 许可：MIT
- 用途：服务端按官方示例生成 Streamed SOG，并从同一源 PLY 独立生成碰撞 SVO。
- 使用未修改的官方 Release；仓库没有转换器补丁、fork 或私有 CLI 参数。

## 已退役与研究参考

Cesium/AHoLo/Reveal/Luma 历史实现不属于当前 `main` 的运行时或构建依赖。Cesium 历史版本见 [CESIUM_ARCHIVE.md](CESIUM_ARCHIVE.md)。

`non_diff_mechanism` 及未来语义相关项目目前不属于代码依赖或分发内容。任何未来 WGSL 实现必须独立开发，并在引入前逐文件复核许可证、数据权利与可能存在的 Inria/研究用途/非商业限制；不能仅依据仓库根许可证作结论。
