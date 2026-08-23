# Spikive GS — PlayCanvas 本地数据管理与体素管线

当前 `dev` 版本只使用一个 PlayCanvas Renderer。用户可以上传 Gaussian Splatting PLY，通过数据卡片完成首次切片、查看、体素碰撞计算/重新计算和永久删除。

系统只保存和使用 PLY 的本地 Z-up 米制工程坐标，不计算经纬度，也不引入 Cesium、AHoLo 或第二个 GPU 上下文。

巡检点圆选、PCA 法向、空间标签与观察方向的详细原理见 [`docs/LABEL_SELECTION_NORMAL.md`](docs/LABEL_SELECTION_NORMAL.md)。

## 1. 前置条件及环境配置

- macOS 或 Windows；
- Node.js 22.22.1 或更高版本；
- 支持 WebGPU 或 WebGL2 的现代 Chrome / Edge；
- 切片和体素化需要足够的本地磁盘、内存与 WebGPU 能力。层数越多，生成的中间 PLY 与最终 SOG 越大。

安装依赖：

```bash
npm install
```

项目固定使用：

- `playcanvas@2.21.4`
- `@playcanvas/splat-transform@3.3.0`

## 2. 如何启动

开发模式：

```bash
npm run dev
```

浏览器打开 <http://localhost:5173>。

生产模式：

```bash
npm run build
npm start
```

如需修改端口，可设置 `SPIKIVE_PORT`。例如 macOS：

```bash
SPIKIVE_PORT=8080 npm run dev
```

Windows PowerShell：

```powershell
$env:SPIKIVE_PORT=8080
npm run dev
```

## 3. 业务使用

### 上传 PLY

1. 点击左上角“选择 PLY”；
2. 选择本机 `.ply` 文件；
3. 点击“上传并创建数据卡片”，等待进度完成。

上传采用流式写盘，不会把完整 PLY 读入服务端 JavaScript 内存。源文件保存在 `var/local-datasets/<数据集ID>/source.ply`，并记录 SHA-256。

### 设置分级并切片

1. “切片分级”默认是 5，可设置 1–20 的整数；
2. 页面会在切片前显示实际比例；
3. 上传完成后，在对应数据卡片中点击“切片”；
4. 构建结束后，点击卡片中的“查看”。

固定公式为：

```text
第 i 层百分比 = ceil(100 × (n - i) / n)，i = 0 ... n - 1
```

示例：

- 5 层：`100% / 80% / 60% / 40% / 20%`
- 6 层：`100% / 84% / 67% / 50% / 34% / 17%`
- 10 层：`100% / 90% / 80% / 70% / 60% / 50% / 40% / 30% / 20% / 10%`

LOD0 直接使用完整源 PLY，不执行抽稀。其余层串行调用官方 `splat-transform --decimate`，最终只通过官方 `--tag-lod` 生成 Streamed SOG。SOG 编码显式启用官方 worker pool，线程数为 `min(4, CPU 逻辑核数 - 1)`；单个任务内部多核工作，但重任务之间保持串行，避免多个大场景同时争用内存。

切片成功后视觉版本锁定，不提供重新切片。系统不会在失败后自动改变层数或参数。

### 计算体素碰撞数据

1. 只有“已切片”的数据卡片会启用“计算体素”；
2. 体素边长默认 `0.20 m`，透明度阈值默认 `0.10`，可在卡片中手动修改；
3. 点击“计算体素”，等待卡片显示“体素已就绪”；
4. 已完成的数据可以点击“重新计算体素”。新版本校验通过前，上一版始终保留。

体素化读取不可变的完整源 PLY，而不是抽稀 LOD。它调用 `splat-transform 3.3.0` 官方 WebGPU 并行体素化，生成 `scene.voxel.json` 与 `scene.voxel.bin` 稀疏体素八叉树。当前阶段不生成 GLB 碰撞网格，也不执行 floor/external fill、carve 或自动调参；这些操作会增加大场景可变网格内存，而且航线避障所需的计算真值是 SVO 本身。

如果分辨率导致资源不足，任务会失败并给出错误，系统不会自行改粗体素。用户调整卡片参数后重新计算。

### 数据卡片管理

- “查看”：加载已经切片的场景；
- “切片”：只出现在尚未切片的数据上；
- “添加巡检点”：进入 GS 表面拾取模式，再单击场景创建红色巡检点；
- “计算体素/重新计算体素”：只在切片成功后可用；
- “删除”：永久删除源 PLY、视觉版本、体素版本和失败的工作目录，操作前必须确认。

每个数据场景的卡片下方都有独立的“场景巡检点”列表。列表不会把不同数据集的点混在一起；点击列表项会加载所属场景、选中对应点并打开详情，点击右侧 `×` 可删除未被业务引用的点。后端拒绝删除时，前端会保留点位并显示原因。

卡片分别显示切片状态、体素状态与巡检点，使“上传 → 首次切片 → 体素计算 → 打点/管理 → 重算或删除”形成闭环。

### 添加巡检点

1. 数据只需完成视觉切片，不要求先计算体素；
2. 点击数据卡片中的“添加巡检点”；
3. 移动鼠标会显示固定直径 10px 的圆形光标，即固定半径 5px；
4. 单击 GS 后，PlayCanvas Picker 先确认中心像素属于当前 GS 场景；
5. 同一个 PlayCanvas `GraphicsDevice` 执行一次 SuperSplat centers 风格的离屏 GPU 掩码，并按当前 active placement interval 快照过滤，只保留真正正在显示的 Streamed SOG LOD Gaussian 中心；
6. 离点击中心投影最近的 Gaussian 中心成为巡检点位置，5px 圆内全部已选中心通过 PCA 拟合表面法向；
7. 保存后场景创建小型红色 PlayCanvas Sphere Mesh，并从球心沿持久化单位法向绘制一条 1 m 橙色方向线；世界空间 Text Element 的锚点位于法向线末端外侧 0.12 m，并始终朝向相机。点击球体、法向线或卡片列表项会选中该标签并打开详情。

该交互不是可拖动的画笔，而是一次单击触发的固定 5px 圆形多选，卡片不提供调参。该流程不读取原始 PLY、不创建第二份源点索引，也不使用体素来决定标签位置或法向量；体素 SVO 只服务后续避障和航线安全计算。标签记录源摘要、活动视觉 revision、实际驻留 LOD、参与拟合的 Gaussian 数量和 PCA 统计。切换视觉 revision 后，旧标签会显示为过期，必须在新视觉版本上重新选择。

巡检点 Mesh、法向线与文字使用正常深度关系，不使用始终置顶的 HTML/Sprite 标记，所以被建筑遮挡时不会穿墙显示。文字位置沿法向移到模型表面外侧，文字平面继续朝向相机以保持可读性。法向线完全由标签保存的局部 Z-up 单位法向生成，只用于表达表面朝向；观察点可优先沿法向外侧搜索，观察方向应朝回标签，并仍需通过 SVO 膨胀碰撞与视线复检。场景切换时会先停止新的拾取；正在进行的 GPU 读回完成前不会销毁选择纹理，随后再释放旧 LOD 缓存、Mesh、法向线、Text Element 与拾取映射。

GPU 圆形多选对每个当前驻留 Gaussian 产生一个布尔选择结果，以 RGBA8 每像素打包 4 个结果并异步读回。第一次选择某个 Chunk 时会为其中心创建临时 RGBA32F GPU 纹理；Chunk 离开当前 LOD 后释放，场景清除时全部释放。选中的中心集合只用于计算位置和 PCA 法向，不再创建额外的 Gaussian 调试高亮。选择 Pass 不修改 PlayCanvas 官方 GS 渲染 Shader、LOD 加载器或 SOG 数据。

### 查看与性能监控

- 左键拖动：旋转；
- 中键拖动或 Shift + 左键拖动：平移；
- 滚轮：缩放；
- 数据卡片“查看”：切换已经完成的数据集。

右上角显示实际 PlayCanvas 后端（WebGPU 或 WebGL2）、FPS、帧时间、应用/系统/服务 CPU、系统/浏览器/服务内存、可见 Gaussian、Draw Calls、GPU 时间以及 PlayCanvas 跟踪的 GPU 资源估算。

浏览器标准 API 不提供可靠的整机 GPU 利用率和物理显存占用，因此这两项明确显示“浏览器未开放”，不会用估算值冒充。GPU 时间也只有设备支持时间戳查询时才显示。

## 数据组织

```text
var/local-datasets/<dataset-id>/
├── dataset.json
├── labels.json
├── source.ply
├── visual-revisions/<revision>/
│   ├── lod-meta.json
│   └── <chunk>/...
├── collision-revisions/<revision>/
│   ├── scene.voxel.json
│   ├── scene.voxel.bin
│   └── collision-manifest.json
├── work/<revision>/
└── collision-work/<revision>/
```

- `dataset.json`：视觉与体素的独立状态、参数、摘要和活动版本；
- `source.ply`：不可变的完整细节真值；
- `visual-revisions`：构建校验通过后原子发布的 SOG；
- `collision-revisions`：校验通过后原子发布的官方 SVO；
- `work`、`collision-work`：中间文件。成功后自动清理；失败时保留用于诊断。

版本化 Chunk 与体素文件使用长缓存。体素重算失败不会覆盖已经激活的体素版本。

## 开发检查

```bash
npm test
npm run build
```

保留的命令行切片入口默认也生成 5 层：

```bash
npm run build:lod
```

指定层数：

```bash
npm run build:lod -- --levels 10
```

该入口读取 `public/data/point_cloud.ply`，输出到 `public/data/point_cloud-lod`。输出目录已存在时会停止，避免静默覆盖。
