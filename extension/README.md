# Nexus 织知 Chrome 扩展（DeepSeek 导出）

Manifest V3 扩展，把已登录 `chat.deepseek.com` 的历史会话导出为桌面端可导入的标准 JSON（`schema_version=1`，`platform=deepseek`）。

## 构建与安装

```bash
pnpm add -D @types/chrome   # 首次
node extension/build.mjs    # 产物输出到 extension/dist/
```

Chrome 打开「扩展程序 → 加载已解压的扩展程序」，选择 `extension/dist/`。点击工具栏图标会打开独立导出工作台页面。

## 使用流程

1. 保持一个已登录的 DeepSeek 标签页；
2. 在工作台点击「加载全部历史」滚动读取侧边栏（支持懒加载去重）；
3. 搜索、勾选要导出的会话（或直接导出当前打开的会话）；
4. 导出过程显示进度，可暂停 / 继续 / 重试失败项；
5. 「下载导出 JSON」生成文件；成功部分始终可导出，失败项写入顶层 `errors` 数组，只有全部失败时才不生成文件。

## 实现说明

- `bridge.js` 注入 MAIN world，包装 `fetch`/`XHR`，把 DeepSeek 自身 API 返回的 JSON 通过 CustomEvent 转发给 content script —— 消息正文优先取自接口数据，不受 CSS 类名变化影响；
- content script 同时保留 DOM 兜底（`.ds-markdown` 结构 + 侧边栏锚点），接口未命中时按 DOM 顺序提取用户/AI 消息；
- 不修改原页面的视觉与交互；不发送任何网络请求到第三方。
