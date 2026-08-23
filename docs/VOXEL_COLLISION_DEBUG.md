# 体素碰撞与调试显示原理

## 1. 目的与边界

系统从不可变的完整 PLY 独立生成两种同版本体素产物：

- `scene.voxel.json` 和 `scene.voxel.bin`：稀疏体素八叉树（SVO），是碰撞查询、机体膨胀和航线规划的唯一空间真值；
- `scene.collision.glb`：用于人工检查体素覆盖的面网格，只是显示调试产物。

GLB 不参与碰撞、法向计算、标签位置或航线有效性判定。隐藏或卸载 GLB 不会改变 SVO 和业务数据。

## 2. 生成流程

体素计算只能在数据已完成视觉切片后由用户点击启动，但其输入仍是完整源 PLY，不是 Streamed SOG 或任何抽稀 LOD。

后端使用固定的官方参数形式：

```text
splat-transform --memory source.ply \
  --voxel-size <用户输入> \
  --voxel-opacity <用户输入> \
  --collision-mesh faces \
  scene.voxel.json
```

其中体素边长默认 `0.20 m`，透明度阈值默认 `0.10`。系统不根据内存、FPS 或失败结果自动改粗体素；资源不足时明确失败，等待操作者调整参数后重试。

新版本必须同时通过：

- SVO 格式、树深、边界、节点数与二进制长度校验；
- GLB 2.0 magic、版本、声明长度和非空校验；
- JSON、BIN 和 GLB 的 SHA-256 校验值记录。

校验后才将完整目录原子发布为新 collision revision。重算失败时继续使用上一个活动版本。

## 3. 显示开关

每个数据卡片有两个独立勾选按钮：

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
   ├─ voxel-debug-entity    青色半透明、不可拾取
   └─ inspection-overlays   标签 Mesh、法向线和文字
```

SOG、GLB 和标签都保存同一个 local Z-up 米制坐标。只在 `scene-root` 统一应用 `render=(x,z,-y)` 和场景居中，避免每类对象各自转换导致偏移。

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
- API 只公布活动 collision revision 的版本化 `debugMeshUrl`、字节数和模式；
- 体素重算不修改视觉 revision、标签坐标或航线数据；
- 永久删除数据集时，GLB 与同版本 SVO 一起按数据集所有权清理；
- 旧 collision revision 不含 GLB 时，只能在用户明确确认后使用卡片当前参数重算，不能静默升级。

## 7. 验收

- 新 collision revision 必须同时包含有效 SVO 和 GLB，缺任何一项都不得激活；
- 应用初始状态为“显示高斯”已勾选、“显示体素”未勾选；
- 四种显示组合都不改变 local 坐标、标签、SVO 或航线状态；
- 体素网格不能被点击，不能遮挡标签 Picker，不能成为路线规划输入；
- 重复勾选、取消、切换场景和清除显示后，Asset、Entity、请求和 GPU 资源不持续增长；
- 大网格必须实机验证加载时间、内存、显存和交互帧率。
