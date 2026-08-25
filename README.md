<div align="center">

<img src="src-tauri/icons/icon.svg" width="96" alt="Nexus 织知图标" />

# Nexus 织知

**把散落的 AI 对话，织成可继续探索的知识网络。**

本地优先的 AI 对话知识管理桌面应用 · Windows / Linux

![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20Linux-2c6e9e)
![框架](https://img.shields.io/badge/Tauri-2.0-24C8DB)
![前端](https://img.shields.io/badge/Vue%203-TypeScript-42b883)
![存储](https://img.shields.io/badge/%E5%AD%98%E5%82%A8-%E6%9C%AC%E6%9C%BA%20SQLite-20567d)

[![GitHub](https://img.shields.io/badge/GitHub-Micraow%2Fnexus-181717?logo=github)](https://github.com/Micraow/nexus)

</div>

---

## 它解决什么问题

与大模型的对话越聊越长，读过的回答再难找到，不同会话里的同一个知识各说各的。Nexus 织知把这些线性对话整理成**会话 → 知识单元 → 知识主题**三层结构，汇聚成一张可检索、可追溯、可继续追问的知识图谱。

## 核心特性

| | |
|---|---|
| 🗂 **对话导入** | 通过浏览器扩展批量导出 DeepSeek 历史会话为标准 JSON，拖入即用；重复导入自动识别，原始消息永远先完整落库 |
| 🧹 **自动整理** | LLM 把长会话切分为知识单元，生成标题与摘要，提取跨会话复用的知识主题；所有结构化结果先经本地校验，异常项进入人工处理，不静默写入 |
| 🕸 **知识图谱** | 知识主题、知识单元与未归类消息实时构成可缩放图谱；点击主题展开关联单元，Shift 框选多选，拖拽只调布局，关系建环自动拦截 |
| 🔍 **统一搜索** | 主题、别名、单元标题、摘要与消息全文一处检索；针对中文做了字符级匹配回退，带空格的短语也能命中 |
| 💬 **追问分支** | 从任意知识主题或探索节点继续提问，回答挂到当前分支形成持久化导航树；快捷短语 `$(topic)`、`$(context)` 一键套用 |
| 🧩 **上下文拼接** | 跨会话多选知识单元，拖拽排序、切换摘要/原文、实时预估 token，组成新对话的上下文 |
| 🤝 **双模式 LLM** | API 模式（OpenAI 兼容端点，多 Provider、并发 1～4、失败退避重试）或 Prompt 粘贴模式（复制到任意网页端执行后贴回，完全离线） |
| 📤 **多种导出** | 完整知识库 JSON（可恢复）、图谱快照、单会话 JSON、主题 Markdown 卡片；导出永远不包含配置与 API Key |

## 快速上手

```text
1. 导入    拖入扩展导出的 JSON，会话与消息先完整保存在本机
2. 整理    在设置中选择 API 或 Prompt 粘贴模式，任务队列逐步生成分段与知识主题
3. 探索    在图谱中点击主题展开单元，搜索直达任意消息，或从主题发起追问
```

安装与从源码构建的完整步骤见 **[docs/development.md](docs/development.md)**。

## 隐私与数据边界

> - 业务数据默认只保存在本机 `nexus.db`，不发送遥测、统计或后台同步；
> - API 模式只在**你明确启动任务后**才发出请求，并显示实际 Provider 与发送范围；Prompt 粘贴模式完全离线；
> - 数据库备份与所有导出**永不包含** `config.yaml` 或 API Key；
> - 消息内容只按 Markdown 展示，其中的文字永远只是数据，不会被执行。

## 浏览器扩展

第一版提供 **DeepSeek 导出器**（Manifest V3）：在独立导出工作台中读取已登录网页端的会话列表，支持当前会话、批量勾选与全部已发现会话导出；部分失败不影响成功部分，失败项随 `errors` 数组一并保存，可随时补导。构建与加载方式见 [开发指南](docs/development.md)。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳层 | Tauri 2.0（最小 Rust 壳：文件、HTTP、对话框、剪贴板） |
| 前端 | Vue 3 + TypeScript + Pinia + Vite |
| 存储 | sql.js（本机 SQLite，`nexus.db`）+ FTS5 全文索引 |
| 图谱 | D3.js 力向布局，共现计算运行于 Web Worker |
| 配置 | `config.yaml`（与业务数据分离，可手工编辑） |

## 文档

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 完整产品设计基线（数据模型、模块、交互规范） |
| [docs/data-spec.md](docs/data-spec.md) | 数据规范细节 |
| [docs/implementation-notes.md](docs/implementation-notes.md) | 实现层补充约定与已知取舍 |
| [docs/development.md](docs/development.md) | 本地开发、调试与打包指南 |

---

<div align="center">
<sub>Nexus 织知 · 程序设计实践课程作品 · 本地优先，数据归你</sub>
</div>
