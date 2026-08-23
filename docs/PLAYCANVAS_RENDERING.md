# PlayCanvas 官方 Streamed SOG 基线

## 1. 决策

视觉链只使用官方未修改的 `@playcanvas/splat-transform@3.3.0` 和 PlayCanvas `2.21.4`。仓库不补丁转换器，不维护第二套切片算法，不在官方输出后重新编码或改写 Chunk，也不向运行时接入历史画质策略。

这是一条“官方原样基线”。SOG 的编码、空间树、Chunk 划分、LOD 误差、细化与替换行为均由当前固定上游版本负责。以后若要做画质实验，必须建立独立可回滚 revision，不能暗改这条基线。

## 2. 官方转换流程

输入是不可变 GraphDECO PLY。命令语义与官方 Streamed SOG 文档示例一致：

```bash
splat-transform source.ply --decimate 50% lod-1.ply
splat-transform source.ply --decimate 25% lod-2.ply
splat-transform source.ply --decimate 10% lod-3.ply
splat-transform \
  source.ply --tag-lod 0 \
  lod-1.ply --tag-lod 1 \
  lod-2.ply --tag-lod 2 \
  lod-3.ply --tag-lod 3 \
  sog/lod-meta.json
```

平台不追加以下视觉参数：

- `--lod-chunk-count` 或 `--lod-chunk-extent`；
- 过滤、裁剪、旋转、缩放或坐标变换；
- 自定义细/粗层格式；
- GPU 选择、内存预算、Scale Boost 或项目私有环境变量。

因此当前上游默认值 512K Chunk、16 m extent 和原生 SOG payload 只是构建报告中的来源记录，不是平台传给 CLI 的策略。

构建只校验来源摘要、官方元数据结构、引用文件存在、层级计数单调和碰撞 revision 绑定。它不对官方 SOG 做逐属性无损门禁，也不以产物大小推断画质。

## 3. 原生运行时

前端直接创建 `gsplat` Asset 指向版本化 `lod-meta.json`，加载完成后将该 Asset 交给原生 `gsplat` Component。平台不设置：

- `splatBudget`；
- `lodRangeMin` / `lodRangeMax`；
- LOD 基准距离、距离倍率或整场自适应预算；
- underfill、min contribution、foveation、pixel size 或数据格式；
- 自定义 Chunk Loader、父子替换器或私有 Shader。

WebGPU 优先与 WebGL2 回退通过 PlayCanvas 官方设备创建路径完成。右上角面板只读取引擎统计，不修改渲染状态。

## 4. 体素业务链

体素是唯一额外生成能力，并且直接读取全量源 PLY，不读取任何视觉 LOD：

```text
source.ply
 ├─ 官方 Streamed SOG → 浏览显示
 └─ splat-transform .voxel.json → SVO、.voxel.bin、collision GLB
```

`voxelSize`、`voxelOpacity`、室内 seed 与室内/室外 fill 属于明确的碰撞业务输入，不属于视觉配置。若工具报告可变网格超限，系统只给出人工选择建议，不自动改变分辨率。

标签拾取、法向、膨胀扫掠与航迹规划继续只使用 SVO。任何 GS 可见性、透明度或 LOD 状态都不改变安全计算结果。

## 5. 发布与生命周期

新 revision 在工作目录完成并校验后才原子激活；失败时继续使用旧视觉。版本化 SOG 文件长缓存，活动 manifest 与 `lod-meta.json` 禁止旧缓存。

切换或清除场景时，先中止加载和业务射线请求，再解绑输入与帧监听，移除 GS Asset/Entity，最后销毁 Application。过期异步回调不得访问已销毁对象。
