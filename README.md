# Spikive GS — PlayCanvas 原始 PLY 基线

这是从零搭建的 `dev` 基线，只验证一件事：使用最新版 PlayCanvas 直接显示原始 Gaussian Splatting PLY。

当前版本明确不包含：

- 数据切片、LOD、SOG 或任何转换；
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
npm run dev
```

浏览器打开终端显示的地址，默认通常是 <http://localhost:5173>。

## 操作

- 左键拖动：旋转
- 中键拖动或 Shift + 左键拖动：平移
- 滚轮：缩放

## 数据说明

当前 `point_cloud.ply` 为二进制 PLY，包含 14,224,203 个 Gaussian，文件大小 967,246,731 字节。浏览器会完整下载并解析该文件；这是刻意保留的无切片、无降采样画质基线，不代表最终的大场景交付方案。

`public/data/*.ply` 不进入 Git，避免把近 1 GiB 的研究数据提交到代码仓库。每台开发机首次运行前只需复制一次。
