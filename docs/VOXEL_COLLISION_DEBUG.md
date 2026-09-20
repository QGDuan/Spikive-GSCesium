# 体素碰撞与调试显示原理

## 1. 目的与边界

系统从不可变的完整 PLY 生成碰撞数据，并按需附加调试网格。test 分支采用分区流水线，详见 [低资源构建](LOW_RESOURCE_BUILD.md)：

- `scene.voxel.json` 和 `scene.voxel.bin`：稀疏体素八叉树（SVO），是碰撞查询、机体膨胀和航线规划的唯一空间真值；
- `scene.collision.glb`：独立按需生成的面网格，只是显示调试产物；分区版每次检查一个非空分区（含缓冲）。

GLB 不参与碰撞、法向计算、标签位置或航线有效性判定。隐藏或卸载 GLB 不会改变 SVO 和业务数据。

## 2. 生成流程

体素计算只能在数据已完成视觉切片后由用户点击启动，但其输入仍是完整源 PLY，不是 Streamed SOG 或任何抽稀 LOD。

后端使用固定的官方参数形式：

```text
splat-transform --memory source.ply \
  --voxel-size <用户输入> \
  --voxel-opacity <用户输入> \
  scene.voxel.json
```

其中体素边长默认 `0.20 m`，透明度阈值默认 `0.10`。系统不根据内存、FPS 或失败结果自动改粗体素；资源不足时明确失败，等待操作者调整参数后重试。

碰撞版本必须通过所有分区的：

- SVO 格式、树深、边界、节点数与二进制长度校验；
- JSON、BIN 的 SHA-256 校验值记录；
- 全局网格与核心区完整覆盖、无重叠校验。

校验后才将完整目录原子发布为新 collision revision。重算失败时继续使用上一个活动版本。

调试网格另行用同一个贡献集和碰撞参数执行官方 `--collision-mesh faces`；只有新 SVO 二进制与原版一致、GLB 2.0 文件有效时才挂载。网格失败不影响原碰撞版本。官方 mutable-grid 保护不修改，资源失败不会自动改精度。

## 3. 显示开关

每个场景卡片有两个独立勾选按钮：

| 开关 | 默认 | 作用 |
|---|---:|---|
| 显示高斯 | 勾选 | 只启用或禁用当前 GS Entity |
| 显示体素 | 不勾选 | 按需加载或释放当前 collision revision 的 GLB |

两个开关可以任意组合：只显示 GS、只显示体素、同时显示或同时关闭。巡检点、法向线和文字位于共享坐标根节点，不会因关闭 GS 而被连带隐藏。进入“添加巡检点”时会明确重新开启 GS，因为圆选必须作用于当前可见 LOD。

## 4. PlayCanvas 场景层级

系统仍只有一个 `Application`、`Canvas` 和 `GraphicsDevice`：

```text
Application root
└─ scene-root   共享 local Z-up 到 PlayCanvas Y-up 变换与居中
   ├─ gs-entity             高斯开关只控制该节点
   ├─ voxel-source-frame    体素 identity → 源 PLY 的 Rz(180°) 适配
   │  └─ voxel-debug-entity 青色半透明、不可拾取
   └─ inspection-overlays   标签 Mesh、法向线和文字
```

持久化标签和航线使用源 PLY 的 local Z-up 米制坐标。官方工具内部把 PLY 定义为绕 Z 轴 180° 的格式坐标，SOG 保持 PLY 空间，而 voxel/GLB 输出烘焙为 identity 空间。因此碰撞存储边界固定采用自逆变换：

```text
voxel = (-source.x, -source.y, source.z)
source = (-voxel.x, -voxel.y, voxel.z)
```

SVO 的点、球、航段和射线查询均在入口执行该变换；半径和距离不变。GLB 放在独立 `voxel-source-frame` 下执行同样的 `Rz(180°)` 后，再与 GS、标签共同经过 `scene-root` 的 `render=(x,z,-y)` 和场景居中。业务层不得直接使用 voxel identity 坐标。

体素 MeshInstance 固定 `pick=false`，开启深度测试但不写入深度，用于与 GS 叠加查看覆盖边界，不能拦截巡检点点击。

## 5. 按需加载与资源释放

GLB 默认不请求。用户勾选后才从版本化 URL 加载，服务支持 HTTP Range、`model/gltf-binary` 和不变版本的长缓存。当网格达到 256 MiB 时，前端必须在加载前确认资源开销。

取消勾选、切换数据集、重算体素、清除显示或销毁应用时，按以下顺序处理：

1. 递增加载 generation，使过期异步回调无效；
2. 移除体素 Entity；
3. 卸载并从 Asset Registry 移除 GLB Asset；
4. 只在所有加载和拾取结束后销毁共享 Application。

异步 GLB 加载完成时必须同时校验数据集 generation、体素 generation 和当前场景引用，过期结果只能卸载，不得访问已销毁节点。

## 6. 数据依赖闭环

- collision manifest 记录源 PLY 摘要、参数、坐标系、统计、调试网格模式和全部校验值；
- 新 manifest 明确记录 `sourceToVoxelTransform=rotate-z-180`；旧活动版本由同一固定运行时适配读取，无需重算体素；
- API 只公布活动 collision revision 的版本化 `debugMeshUrl`、字节数和模式；
- 体素重算不修改视觉 revision 或标签坐标；新碰撞版本激活后，旧航线失效并等待重新规划；
- 永久删除数据集时，GLB 与同版本 SVO 一起按数据集所有权清理；
- 没有 GLB 时用户点“显示体素”或“生成该区调试网格”，沿用活动碰撞参数生成独立附件，不重建或切换碰撞版本。

## 7. 验收

- 新 collision revision 的 SVO 必须全部有效且覆盖完整，GLB 不再是激活前提；
- 应用初始状态为“显示高斯”已勾选、“显示体素”未勾选；
- 四种显示组合都不改变 local 坐标、标签、SVO 或航线状态；
- 视觉树范围与体素范围按 `Rz(180°)` 变换后必须一致，固定空间锚点的 SVO 占用与 GLB 覆盖必须和 GS 重合；
- 体素网格不能被点击，不能遮挡标签 Picker，不能成为路线规划输入；
- 重复勾选、取消、切换场景和清除显示后，Asset、Entity、请求和 GPU 资源不持续增长；
- 大网格必须实机验证加载时间、内存、显存和交互帧率。
