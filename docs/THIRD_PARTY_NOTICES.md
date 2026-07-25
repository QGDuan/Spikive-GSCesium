# 第三方算法参考说明

## Luma WebGL Library

- 官方示例：[`lumalabs/luma-web-examples`](https://github.com/lumalabs/luma-web-examples)
- npm 包：[`@lumaai/luma-web`](https://www.npmjs.com/package/@lumaai/luma-web)
- 审计版本：`@lumaai/luma-web@0.2.2`
- 许可：MIT（以其仓库随附 `LICENSE` 为准）
- 使用方式：研究公开的 `particleRevealEnabled` 配置，并审计该版本发布包中的 Reveal/Solid/Alpha Shader 行为；本项目没有安装、复制运行或嵌入 Luma 的 Three/WebGL 渲染器。

本项目在 Cesium Gaussian Primitive 的坐标、协方差和生命周期模型中独立实现种子尺寸到完整椭球的插值。实现代码受本项目自己的 Cesium 精确版本保护、自动化测试和退出恢复约束。
