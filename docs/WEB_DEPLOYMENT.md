# 面向建运一体化转型的实景三维多场景孪生应用底座系统——Web 部署说明

系统采用前后端同源的 Web 部署方式。后端进程同时提供管理界面、API 和场景资源，不使用桌面安装器。

## 一、前置条件及环境配置

- 操作系统：macOS、Windows 10/11 x64，或常见 x64/arm64 Linux；
- Node.js `22.22.1` 或更高版本；
- 建议内存 16 GB 以上，并为原始 PLY、可视化产物和体素产物保留足够磁盘空间；
- 场景可视化使用访问者浏览器的 WebGPU/WebGL2；服务端体素计算还需要部署机可用的 WebGPU 适配器与显卡驱动。

默认端口为 `5173`，默认监听 `0.0.0.0`。局域网其他电脑访问时，需要在防火墙中允许该端口。

## 二、构建与启动

### 1. 在开发机生成 Web 安装包

```bash
npm ci
npm run package:web
```

命令会先生成 `release/web/` 部署目录，再生成：

- `release/packages/面向建运一体化转型的实景三维多场景孪生应用底座系统-<版本号>.zip`；
- `release/packages/SHA256SUMS.txt`；
- `release/packages/release-manifest.json`。

将 ZIP 复制到目标电脑并解压。压缩包不包含工程 TS/TSX、测试、Source Map、PLY、SQLite 或已有业务数据；客户后续上传的数据也保存在安装目录之外。

### 2. macOS / Linux 启动

```bash
cd web
./start.sh
```

### 3. Windows 启动

在资源管理器中双击 `start.cmd`，或在 PowerShell/CMD 中执行：

```bat
cd web
start.cmd
```

启动后，本机访问 `http://localhost:5173`；局域网访问使用 `http://服务器IP:5173`。服务在前台运行，按 `Ctrl+C` 停止。

### 4. 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `SPIKIVE_HOST` | `0.0.0.0` | 监听地址；仅本机使用可设为 `127.0.0.1` |
| `SPIKIVE_PORT` | `5173` | HTTP 端口 |
| `SPIKIVE_DATA_ROOT` | 用户数据目录 | PLY、SOG、体素、SQLite 和任务数据根目录 |

默认数据位置：

- macOS/Linux：`~/.spikive-gs/data/`；
- Windows：`%LOCALAPPDATA%\Spikive GS\data\`。

### 5. 校验安装包

macOS/Linux 可在 `release/packages/` 中执行：

```bash
shasum -a 256 -c SHA256SUMS.txt
```

Windows PowerShell 可执行：

```powershell
Get-FileHash -Algorithm SHA256 '.\面向建运一体化转型的实景三维多场景孪生应用底座系统-0.1.0.zip'
```

输出值应与 `SHA256SUMS.txt` 一致。

## 三、业务使用与运维

1. 浏览器打开服务地址，在“场景”页上传 PLY 并执行切片；
2. 切片完成后可查看场景，再按需生成体素；
3. 在当前场景的“标签”页创建巡检点，在“航线”页生成和复核路线；
4. 备份时先停止服务，然后完整复制 `SPIKIVE_DATA_ROOT` 目录；
5. 标签被航线引用时不能删除；永久删除场景会删除其切片、体素、标签和航线，不可恢复。

### 安全边界

当前系统没有内置公网身份认证，默认只适合本机或可信局域网。不得将 `5173` 端口直接暴露到公网。如需公网或多用户使用，应在前置网关增加 HTTPS、身份认证、访问控制、上传限制和审计。
