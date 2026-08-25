# 本地开发与打包指南

面向在本机开发、调试和打包 Nexus 织知的开发者。产品介绍见仓库根目录 `README.md`，设计基线见 `design.md`，实现层约定见 `implementation-notes.md`。

## 1. 环境准备

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 前端构建与脚本 |
| pnpm | ≥ 9 | 包管理（`corepack enable` 或 `npm i -g pnpm`） |
| Rust 工具链 | 稳定版，需支持 edition 2021 | 通过 [rustup](https://rustup.rs) 安装；过旧会在构建时报 edition 错误，执行 `rustup update` 即可 |
| Tauri 系统依赖 | 见下 | 仅桌面模式与打包需要 |

Linux（Debian/Ubuntu）需要安装 Tauri 依赖：

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Arch Linux：

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file xdotool openssl appmenu-gtk-module librsvg
```

Windows 10/11 自带 WebView2 运行时，另需安装 Visual Studio Build Tools（C++ 工作负载）即可。

## 2. 安装依赖

```bash
git clone https://github.com/Micraow/nexus.git nexus && cd nexus
pnpm install
```

## 3. 本地运行与调试

### 3.1 浏览器开发模式（最快）

```bash
pnpm dev          # 打开 http://127.0.0.1:5173
```

- 数据保存在浏览器 `localStorage`，与桌面端 `nexus.db` 互不相通；
- 没有 Tauri 壳层：导出退化为浏览器下载、剪贴板走 Web API，适合纯界面与业务逻辑调试和单元验收。

### 3.2 桌面开发模式（以 Tauri 为中心）

```bash
pnpm tauri dev
```

- 首次运行会编译 Rust 壳层，耗时数分钟，之后有缓存；
- 前端改动即时热更新；Rust 侧改动会自动重新编译；
- 业务数据与配置保存在应用数据目录：
  - Linux：`~/.local/share/com.nexus.weave/`（`nexus.db` + `config.yaml`）；
  - Windows：`%APPDATA%\com.nexus.weave\`；
- 设置页可以切换自定义数据库位置（切换前自动备份）。

### 3.3 调试技巧

- **WebView 开发者工具**：桌面调试构建中在页面里右键选择“检查”（Inspect）即可打开检查器；`console.log` 会同时出现在终端。
- **查看数据库**：应用关闭后用 `sqlite3 ~/.local/share/com.nexus.weave/nexus.db` 直接查询；运行中拷贝一份再打开，避免与写入竞争。
- **重置数据**：设置 → 本地数据 → 「清空知识库」，或直接删除数据目录下的 `nexus.db`。
- **配置错误**：`config.yaml` 解析失败时应用会保留原文件、显示常驻警告并沿用上一次有效配置，按提示修复 YAML 即可。
- **单元测试与类型检查**：

```bash
pnpm test          # vitest 全量单测
pnpm test:watch    # 监听模式
pnpm typecheck     # vue-tsc
```

## 4. 打包为可执行文件

### 4.1 桌面应用

```bash
pnpm tauri build
```

产物位置（Linux）：

| 产物 | 路径 |
|---|---|
| 可执行文件（裸二进制） | `src-tauri/target/release/nexus-weave` |
| deb 包 | `src-tauri/target/release/bundle/deb/Nexus 织知_<版本>_amd64.deb` |
| rpm 包 | `src-tauri/target/release/bundle/rpm/Nexus 织知-<版本>-1.x86_64.rpm` |
| AppImage | `src-tauri/target/release/bundle/appimage/Nexus 织知_<版本>_amd64.AppImage` |

Windows 上同一命令产出 `msi`/`nsis` 安装包（位于 `bundle/msi` 或 `bundle/nsis`）。

**AppImage 注意事项**：AppImage 打包需要运行 `linuxdeploy` 工具。如果宿主机只有 fuse3（例如较新的 Arch），linuxdeploy 无法直接执行，请改用：

```bash
APPIMAGE_EXTRACT_AND_RUN=1 pnpm tauri build --bundles appimage
```

deb 与 rpm 由 Tauri 纯 Rust 实现，不需要系统安装 `dpkg-deb`/`rpmbuild`。

### 4.2 版本号同步

发布前需要同步三处版本号：

1. `src-tauri/tauri.conf.json` 的 `version`；
2. `src-tauri/Cargo.toml` 的 `version`；
3. 浏览器扩展 `extension/manifest.json` 的 `version`（扩展独立发版时）。

### 4.3 更新应用图标

```bash
# 编辑 src-tauri/icons/icon.svg 后，渲染 1024px 源图并重新生成整套图标
rsvg-convert -w 1024 -h 1024 src-tauri/icons/icon.svg -o /tmp/icon-1024.png
pnpm tauri icon /tmp/icon-1024.png
```

## 5. Chrome 扩展（DeepSeek 导出器）

```bash
pnpm build:extension      # 产物在 extension/dist/
```

在 Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/dist/`。使用方式：保持一个已登录的 DeepSeek 标签页，在扩展导出工作台中勾选会话批量导出 JSON，再把 JSON 导入桌面应用。

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| `failed to parse the edition key` | Rust 工具链过旧：`rustup update` |
| 编译报 `webkit2gtk` 未找到 | 未装 Tauri 系统依赖，见第 1 节 |
| AppImage 阶段 `failed to run linuxdeploy` | 用 `APPIMAGE_EXTRACT_AND_RUN=1` 重试，或安装 fuse2 |
| 应用内 WASM 无法初始化 / 白屏 | 确认未改动 `tauri.conf.json` CSP 中的 `'wasm-unsafe-eval'` |
| 5173 端口被占用 | 关闭占用进程，或临时改 `vite.config.ts` 的端口并同步 `devUrl` |
| 桌面端与浏览器端数据不一致 | 两套存储本就独立（SQLite vs localStorage），属预期行为 |
