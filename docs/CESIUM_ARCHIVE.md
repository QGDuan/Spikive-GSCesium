# Cesium 冻结版本与回退说明

Cesium 架构已从当前 `main` 退役，不再作为运行时依赖或故障回退。迁移前的完整代码已冻结：

- 分支：`archive/cesium-final`
- 标签：`v0.1.0-cesium-final`
- 提交：`7da45a8efa5d779dd8b3895f08da27a5ae4f7924`

该归档包含当时的 Cesium Gaussian 3D Tiles、AHoLo 候选 Renderer、Reveal Shader 补丁及对应文档，可用于历史问题复现和紧急版本回退。归档不会随 `main` 的 AHoLo 方案继续演进。

## 回退原则

回退属于显式发布行为，不是在新版本运行中自动切换 Renderer。应在单独工作目录检出标签并使用备份数据验证：

```bash
git switch --detach v0.1.0-cesium-final
npm ci
npm run verify
```

不要在承载当前 `var/` 的生产目录直接切换历史代码。先停止服务并完整备份 `var/`，再用副本完成数据库与产物兼容验证。

## 历史产物

升级到 AHoLo-only `main` 时，系统不会自动删除 `var/published/<dataset>/` 中的历史 Cesium Tiles。这些字节不再被当前 API 发布，也不计入当前 AHoLo revision；保留它们可支持冻结版本回退。确需回收磁盘时，必须先完成独立备份和依赖核对，再由运维人员执行，不得把清理混入代码升级或普通“清除显示”。
