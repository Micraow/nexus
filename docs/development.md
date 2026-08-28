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
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file xdotool openssl appmenu-gtk-module librsvg wl-clipboard xclip
```

`wl-clipboard`（Wayland）和 `xclip`（X11/XWayland）用于桌面端剪贴板的可靠回退；如果系统不使用它们，应用仍会尝试 Tauri 原生剪贴板插件。

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
- Linux 壳层启动前会为未设置的变量补齐 `GTK_IM_MODULE=fcitx`、`QT_IM_MODULE=fcitx`、`XMODIFIERS=@im=fcitx`，适配 Arch Linux + KDE + Wayland + fcitx5；如使用其他输入法，先在启动命令前显式设置对应变量即可覆盖默认值。可用 `env | rg '^(GTK|QT)_IM_MODULE|^XMODIFIERS'` 检查当前终端环境。

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

**AppImage 注意事项**：在 Linux 上推荐使用项目脚本单独构建 AppImage：

```bash
pnpm run build:appimage
```

该脚本设置了 `APPIMAGE_EXTRACT_AND_RUN=1`，因此只有 fuse3 的较新发行版也能运行 linuxdeploy；同时设置 `NO_STRIP=1`，避免 linuxdeploy 内置的旧版 `strip` 无法识别 Arch Linux 新系统库的 `.relr.dyn` 节区。Rust release 二进制仍会由 Cargo 按 release 配置处理，这个变量只跳过 linuxdeploy 对收集到的系统库进行二次 strip。

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

### 5.1 使用扩展

1. 在 DeepSeek 网页端完成登录，并保持 `chat.deepseek.com` 标签页打开。
2. 打开扩展的「Nexus 织知导出工作台」，点击「刷新列表」；首次使用建议点击「加载全部历史」，让页面逐屏触发懒加载。
3. 勾选会话后开始读取。读取中的会话会逐个打开网页并优先使用网络响应缓存，页面结构变化时回退到当前页面内容提取；失败项可单独重试。网络快照会按 `chat_session.id` 绑定，消息顺序优先使用网页返回顺序（有明确顺序或时间戳时校正为升序），不会把相邻会话的消息混入当前会话。
4. 即使部分会话失败，也可以下载 JSON。文件会包含成功会话，以及 `errors` 中的失败原因，导入桌面应用前可先重试失败项。

扩展目前只适配 DeepSeek，不会读取或上传其他网站内容。它有三层适配边界：会话链接路径 `/a/chat/s/<id>`、网页端同源 JSON 响应，以及当前消息展示的 `.ds-markdown`。因此普通的样式调整通常不会影响网络捕获；如果 DeepSeek 更换路由、改用非 JSON 通道、取消这些选择器或改动消息字段，列表或导出可能失效。工作台会显示具体失败原因。遇到页面更新时，请先刷新 DeepSeek 标签页、重新构建并加载 `extension/dist/`，再提交带有浏览器版本、页面地址和失败提示的 issue；不要在 issue 中附带会话内容或 API Key。

### 5.2 扩展调试

- `chrome://extensions` 中点击扩展的「重新加载」，再重新打开工作台；旧工作台页面不会自动加载新脚本。
- 在 DeepSeek 页面开发者工具的 Console 中查看 content script 错误，在扩展详情页打开 service worker 检查后台错误。
- 若列表数量少于网页实际数量，先点击「加载全部历史」并等待提示停止增长；DeepSeek 使用虚拟列表时，扩展必须逐屏滚动才能发现更早会话。

### 5.3 真实 DeepSeek 验收

1. 使用 Chrome/Chromium 登录 `chat.deepseek.com`，确认侧边栏能看到至少两个会话，并保持该标签页打开。
2. 执行 `pnpm build:extension`，在 `chrome://extensions` 重新加载 `extension/dist/`，从扩展按钮打开工作台。
3. 先点「刷新列表」确认当前可见会话，再点「加载全部历史」观察数量是否逐屏增长；勾选会话并执行读取，确认成功项和失败原因均显示。
4. 点击下载后检查 JSON 的 `conversations` 与 `errors`；下载接口不可用时应看到页面下载回退提示。不要把真实会话内容、Cookie 或 API Key 放进日志和 issue。

### 5.4 对话、图谱与阅读片段验收

1. 新建对话后，确认首轮问题和回答位于同一张根卡片；点击回答中的黄色推荐词，确认立即出现独立临时分支和新卡片，未提交前可关闭，提交后不可关闭。
2. 连续追问时检查卡片顶部显示当前阅读片段：首轮必须创建片段，后续响应通过 `unit_id` 复用或明确创建新片段；导入消息没有片段时从任务中心运行全图维护并使用 `unit_create` 补建。
3. API 设置打开“流式传输对话”后，用 OpenAI 兼容 SSE 端点确认当前卡片在任务完成前已出现增量文本；任务结束后再校验完整 JSON 并落库。
4. 图谱首屏只显示真实根主题。单击主题同时打开详情并逐层展开；刷新和重置布局后节点位置稳定，当前节点/路径高亮，阅读片段连线只在悬停时显示。切换到其他菜单后，知识维护浮窗和按钮应自动收起且不残留。

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| `failed to parse the edition key` | Rust 工具链过旧：`rustup update` |
| 编译报 `webkit2gtk` 未找到 | 未装 Tauri 系统依赖，见第 1 节 |
| AppImage 阶段 `failed to run linuxdeploy` | 使用 `pnpm run build:appimage`；脚本同时兼容 fuse3 和 Arch 新系统库的 `.relr.dyn` 节区 |
| 应用内 WASM 无法初始化 / 白屏 | 确认未改动 `tauri.conf.json` CSP 中的 `'wasm-unsafe-eval'` |
| 5173 端口被占用 | 关闭占用进程，或临时改 `vite.config.ts` 的端口并同步 `devUrl` |
| DeepSeek 历史只显示首批 | 在工作台点击「加载全部历史」；扩展使用逐屏滚动适配虚拟列表，连续两轮没有增长后才结束 |
| 导出按钮不可用或文件为空 | 先勾选会话并至少执行一次读取；部分成功和仅失败的结果都可生成 JSON，失败原因会写入 `errors` |
| 导出的会话顺序异常 | 重新构建扩展并在 `chrome://extensions` 重新加载后刷新 DeepSeek 标签页；当前版本按 `chat_session.id` 隔离网络快照，并保留消息的会话内顺序 |
| 扩展更新后仍表现旧行为 | 在 `chrome://extensions` 重新加载扩展，并关闭旧工作台页面后从扩展按钮重新打开 |
