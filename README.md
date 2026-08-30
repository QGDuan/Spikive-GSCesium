# 面向建运一体化转型的实景三维多场景孪生应用底座系统

当前 `dev` 版本只使用一个 PlayCanvas Renderer。用户可以上传 Gaussian Splatting PLY，通过场景卡片完成首次切片、查看、体素碰撞计算/重新计算和永久删除。

系统只保存和使用 PLY 的本地 Z-up 米制工程坐标，不计算经纬度，也不引入 Cesium、AHoLo 或第二个 GPU 上下文。

详细原理文档：

- 巡检点与法向获取的独立实现说明、成熟能力复用及鲁棒性边界：[`docs/INSPECTION_POINT_NORMAL_IMPLEMENTATION.md`](docs/INSPECTION_POINT_NORMAL_IMPLEMENTATION.md)；
- 巡检点圆选、PCA 法向、空间标签与观察方向：[`docs/LABEL_SELECTION_NORMAL.md`](docs/LABEL_SELECTION_NORMAL.md)；
- SVO 体素真值、GLB 调试网格和高斯/体素勾选开关：[`docs/VOXEL_COLLISION_DEBUG.md`](docs/VOXEL_COLLISION_DEBUG.md)；
- React 标签管理、SQLite CRUD 与业务边界：[`docs/LABEL_MANAGEMENT.md`](docs/LABEL_MANAGEMENT.md)；
- 起点唯一约束、标签后端鲁棒性与历史图片扩展：[`docs/LABEL_HISTORY_MEDIA_DESIGN.md`](docs/LABEL_HISTORY_MEDIA_DESIGN.md)；
- React UI 设计系统、容器原语与后续开发规范：[`docs/UI_SYSTEM.md`](docs/UI_SYSTEM.md)。
- 飞行路线、观察节点、SVO 膨胀避障与数据库闭环：[`docs/FLIGHT_ROUTE_PLANNING.md`](docs/FLIGHT_ROUTE_PLANNING.md)。
- Web 前后端生产构建、服务器启动与数据备份：[`docs/WEB_DEPLOYMENT.md`](docs/WEB_DEPLOYMENT.md)。

系统以 Web 方式部署：后端同时提供 API、前端静态资源与版本化场景数据，浏览器通过同一地址访问，不需要 Electron 或桌面安装器。

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
- `react@19.2.8` / `react-dom@19.2.8`

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
3. 点击“上传并创建数据”，等待场景卡片生成。

上传采用流式写盘，不会把完整 PLY 读入服务端 JavaScript 内存。源文件保存在 `var/local-datasets/<数据集ID>/source.ply`，并记录 SHA-256。

### 设置分级并切片

1. “切片分级”默认是 5，可设置 1–20 的整数；
2. 页面会在切片前显示实际比例；
3. 上传完成后，在对应场景卡片中点击“切片”；
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

1. 只有“已切片”的场景卡片会启用“计算体素”；
2. 体素边长默认 `0.20 m`，透明度阈值默认 `0.10`，可在卡片中手动修改；
3. 点击“计算体素”，等待卡片显示“体素已就绪”；
4. 已完成的数据可以点击“重新计算体素”。新版本校验通过前，上一版始终保留。

体素化读取不可变的完整源 PLY，而不是抽稀 LOD。它调用 `splat-transform 3.3.0` 官方 WebGPU 并行体素化，生成 `scene.voxel.json` 与 `scene.voxel.bin` 稀疏体素八叉树，同时用官方 `--collision-mesh faces` 生成同版本的 `scene.collision.glb` 调试面网格。系统不执行 floor/external fill、carve 或自动调参；航线避障所需的计算真值始终是 SVO，GLB 只负责让人检查体素覆盖是否合理。

`splat-transform` 将 PLY 标记为绕 Z 轴旋转 180° 的 PLY 坐标约定，而 `.voxel.json`/碰撞 GLB 会烘焙到工具的 identity 坐标。数据库与界面继续保存源 PLY 局部坐标；SVO 查询入口和调试 GLB 节点统一执行 `voxel=(-source.x,-source.y,source.z)`，路线算法内部始终只接触源 PLY 坐标。这个适配是刚性旋转，不改变距离、法向长度或膨胀半径。

如果分辨率导致资源不足，任务会失败并给出错误，系统不会自行改粗体素。用户调整卡片参数后重新计算。

### 调试显示体素

- 场景卡片提供“显示高斯”和“显示体素”两个独立勾选按钮；载入场景时默认显示高斯、不显示体素，也可以只显示体素、同时显示或同时隐藏；
- 勾选“显示体素”后，系统才会按需下载并显示半透明青色面网格；取消勾选会移除 Entity、卸载 Asset 并释放对应 GPU 资源；
- 调试网格与 GS 共用当前 PlayCanvas Application、Canvas、GraphicsDevice 和场景坐标，不创建第二个 Renderer；它不可拾取，也不改变巡检点选择与碰撞查询；
- 大场景调试网格可能达到数百 MiB，默认不加载。卡片会显示真实文件大小，达到 256 MiB 时加载前会再次确认；
- 旧体素版本若没有 `scene.collision.glb`，点击“显示体素”会明确询问是否使用卡片中的当前参数重算；系统不会静默重算或修改体素参数。

### 场景卡片管理

- “查看”：加载已经切片的场景；
- “切片”：只出现在尚未切片的数据上；
- “计算体素/重新计算体素”：只在切片成功后可用；
- “显示高斯”/“显示体素”：勾选式独立开关，分别控制 GS 和当前体素版本的调试网格；
- “删除”：永久删除源 PLY、视觉版本、体素版本和失败的工作目录，操作前必须确认。

场景卡片只管理数据与构建状态，不再内嵌标签下拉列表。顶部“标签”是独立 React 页签，按当前已加载场景及其切片版本管理标签的初始化、编辑、删除、列表和类型查询。标签页不能切换所属场景；必须先在“场景”页查看目标场景。React 只负责业务管理界面；PlayCanvas 继续作为唯一三维 Renderer、Canvas 和 GPU 上下文。

标签类型固定为：起点、缺陷点、常态化巡检点、关键巡检点、一般巡检点。每个场景可以没有起点，但最多只能有一个。标签被任务/航线引用时不能删除；必须先删除引用。详细数据与 API 契约见 [`docs/LABEL_MANAGEMENT.md`](docs/LABEL_MANAGEMENT.md)。

### 添加巡检点

1. 数据只需完成视觉切片，不要求先计算体素；
2. 先在“场景”页查看目标场景，再打开“标签”页，点击“在当前场景新建标签”；
3. 移动鼠标会显示固定直径 10px 的圆形光标，即固定半径 5px；
4. 单击 GS 后，PlayCanvas Picker 先确认中心像素属于当前 GS 场景；
5. PlayCanvas 原生 `Picker(depth=true)` 在同一个 `GraphicsDevice` 上执行官方 GS 拾取 Pass；Gaussian 屏幕覆盖、Alpha 阈值和深度共同决定每个像素最前方的可见结果，前墙会挡住后墙；
6. 中心像素的官方深度结果成为巡检点位置，5px 圆内固定 21 个像素模板读取前表面深度，并通过 PCA 拟合局部整体法向；
7. 圆选后在标签页填写名称、说明并选择五种类型之一，确认后才写入 SQLite；起点为场景内可选唯一类型；
8. 保存后场景创建小型红色 PlayCanvas Sphere Mesh，并从球心沿持久化单位法向绘制一条 1 m 橙色方向线；世界空间 Text Element 的锚点位于法向线末端外侧 0.12 m，并始终朝向相机。点击球体或法向线会选中该标签并打开标签页详情。

该交互不是可拖动的画笔，而是一次单击触发的固定 5px 前表面采样，界面不提供半径调参。该流程不读取原始 PLY、不枚举私有 LOD、不创建第二份源点索引，也不使用体素决定标签位置或法向量；体素 SVO 只服务后续避障和航线安全计算。标签记录源摘要、活动视觉 revision、前表面采样数量和 PCA 统计。切换视觉 revision 后，旧标签会显示为过期，必须在新视觉版本上重新选择。

顶部“航线”是与场景、标签平级的独立页签，只绑定当前已加载场景。每条航线必须指定唯一的起点标签、至少一个有序巡检标签，以及飞行速度、无人机膨胀系数、观察距离和最大/最小点间距。起点沿自身法向固定起飞 1.5m，不使用观察距离；巡检标签才由位置、法向和观察距离生成观察节点。巡检视线只允许在标签法向外侧最多四个体素内跳过保守体素化形成的表面厚度，并以第一个自由采样点作为视线终点，不能穿透任意厚度的实体。后端使用当前 SVO 依次执行起飞通道检查、直线膨胀扫掠、26 邻域 A*、安全快捷化、间距细分和最终逐段复检。完整规则和 API 见 [`docs/FLIGHT_ROUTE_PLANNING.md`](docs/FLIGHT_ROUTE_PLANNING.md)。

巡检点 Mesh、法向线与文字使用正常深度关系，不使用始终置顶的 HTML/Sprite 标记，所以被建筑遮挡时不会穿墙显示。文字位置沿法向移到模型表面外侧，文字平面继续朝向相机以保持可读性。法向线完全由标签保存的局部 Z-up 单位法向生成，只用于表达表面朝向；观察点可优先沿法向外侧搜索，观察方向应朝回标签，并仍需通过 SVO 膨胀碰撞与视线复检。场景切换时会先停止新的拾取；正在进行的 GPU 读回完成前不会销毁选择纹理，随后再释放旧 LOD 缓存、Mesh、法向线、Text Element 与拾取映射。

可见性和 Alpha 计算完全复用 PlayCanvas 官方 GPU Picker，项目不再维护中心纹理、RGBA 选择掩码、WGSL/GLSL 选择 Shader 或 active-placement 私有适配。CPU 只对最多 21 个前表面点计算 3×3 PCA，不修改 PlayCanvas 官方 GS 渲染 Shader、Alpha 参数、LOD 加载器或 SOG 数据。

### 查看与性能监控

- 左键拖动：旋转；
- 中键拖动或 Shift + 左键拖动：平移；
- 滚轮：缩放；
- 场景卡片“查看”：切换已经完成的场景。

顶部以更醒目的字号显示系统全称，并显示当前图形模式。场景管理、标签管理和飞行路线三个入口直接位于左侧卡片标题区，不再占用顶部栏或重复显示页面标题。左侧工作区可以折叠为导航标题栏；右下角性能卡片也可以折叠，且折叠不会清空表单、停止采样或改变三维场景。

右下角紧凑性能卡片只显示帧率、可见高斯点、系统处理器、系统内存和图形资源估算。选中巡检点后，详情与编辑卡片独立显示在右上角。

管理界面采用统一的 SuperSplat 风格设计系统：左侧卡片标题区保留场景管理/标签管理/飞行路线三个主入口，颜色、字体、间距、圆角、阴影和布局尺寸集中在 `src/ui/theme.css`，所有面板和卡片通过 `UiContainer` 变体管理。React 根节点本身不拦截视口事件，只有可见面板接收指针，因此空白三维区域仍由 PlayCanvas 相机、GS 圆选和标签 Mesh 拾取处理。窄屏会收紧面板并扩大触摸目标；键盘焦点使用橙色高可见轮廓。具体扩展规则见 [`docs/UI_SYSTEM.md`](docs/UI_SYSTEM.md)。

浏览器标准 API 不提供可靠的整机 GPU 利用率和物理显存占用，因此界面只显示 PlayCanvas 可核算的 GPU 资源估算，不用估算值冒充整机显存。

## 数据组织

```text
var/
├── labels.sqlite
└── local-datasets/<dataset-id>/
    ├── dataset.json
    ├── labels.json             # 仅启动迁移读取，不再业务读写
    ├── source.ply
    ├── visual-revisions/<revision>/
    │   ├── lod-meta.json
    │   └── <chunk>/...
    ├── collision-revisions/<revision>/
    │   ├── scene.voxel.json
    │   ├── scene.voxel.bin
    │   ├── scene.collision.glb
    │   └── collision-manifest.json
    ├── work/<revision>/
    └── collision-work/<revision>/
```

- `dataset.json`：视觉与体素的独立状态、参数、摘要和活动版本；
- `labels.sqlite`：标签、航线、顺序标签、航点、类型/空间索引和业务引用的唯一数据库真源；
- `labels.json`：旧版标签的幂等迁移来源，迁移不删除文件，也不会覆盖数据库中后续编辑；
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

生成可直接复制到 macOS、Linux 或 Windows 服务器的 Web 部署目录：

```bash
npm run deploy:web
```

产物输出到 `release/web/`，包含压缩后的前端、单文件后端、必要的官方转换运行时和跨平台启动脚本；不包含业务 `var/`、PLY、SQLite、TS/TSX 或 Source Map。详见 [`docs/WEB_DEPLOYMENT.md`](docs/WEB_DEPLOYMENT.md)。

生成可交付客户的 Web 安装包：

```bash
npm run package:web
```

安装包输出到：

```text
release/packages/面向建运一体化转型的实景三维多场景孪生应用底座系统-0.1.0.zip
```

同时生成 `release/packages/SHA256SUMS.txt` 和 `release/packages/release-manifest.json`。客户解压后进入 `web/` 目录：macOS/Linux 执行 `./start.sh`，Windows 执行 `start.cmd`。运行要求、端口、数据位置、备份与安全边界见 [`docs/WEB_DEPLOYMENT.md`](docs/WEB_DEPLOYMENT.md)。

保留的命令行切片入口默认也生成 5 层：

```bash
npm run build:lod
```

指定层数：

```bash
npm run build:lod -- --levels 10
```

该入口读取 `public/data/point_cloud.ply`，输出到 `public/data/point_cloud-lod`。输出目录已存在时会停止，避免静默覆盖。
