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
| 📥 **对话导入** | 通过浏览器扩展导出 DeepSeek 历史会话，拖入应用即可导入；自动识别重复内容，原始对话始终完整保留 |
| 🧹 **自动整理** | 大模型把长对话划分为一个个知识单元，生成标题与摘要，提炼出可跨会话复用的知识主题；整理结果会先经过检查，拿不准的交给你确认，不会悄悄改动知识库 |
| 🕸 **知识图谱** | 知识主题与知识单元汇成一张可缩放的图谱，点击主题即可展开它关联的讨论；支持框选多选、自由调整布局 |
| 🔍 **统一搜索** | 一个搜索框直达知识主题、知识单元和任意一条消息，中文短语也能准确命中 |
| 💬 **追问分支** | 从任意主题或探索节点继续提问，回答自动挂到当前分支，形成随时可以回看的探索树；常用问法可存为快捷短语 |
| 🧩 **上下文拼接** | 跨会话挑选多个知识单元，调整顺序、选择摘要或原文，作为新对话的背景资料 |
| 🤝 **两种整理模式** | API 模式接入 DeepSeek、OpenAI 等常见大模型服务；或使用 Prompt 粘贴模式——把提示词复制到任意网页端执行后贴回，完全离线 |
| 📤 **多种导出** | 完整知识库、图谱快照、单个会话、主题卡片 Markdown，随时带走你的数据 |

## 快速上手

```text
1. 导入    拖入浏览器扩展导出的对话文件，原始内容先完整保存在本机
2. 整理    在设置中选择整理模式，任务队列会逐步生成分段、标题与知识主题
3. 探索    在图谱中点击主题展开单元，搜索直达任意消息，或从主题发起追问
```

安装与构建的完整步骤见 **[docs/development.md](docs/development.md)**。

## 隐私与数据边界

> - 业务数据默认只保存在本机数据库，不发送遥测、统计或后台同步；
> - API 模式只在**你明确启动任务后**才发出网络请求，并明确告知发送范围；Prompt 粘贴模式完全离线；
> - 备份与导出**永不包含**配置文件和 API Key；
> - 消息内容只按正常 Markdown 展示，其中的文字永远只是数据，不会被执行。

## 浏览器扩展

提供 **DeepSeek 导出器**浏览器扩展：在独立的导出工作台中读取已登录网页端的会话列表，支持导出当前会话或批量勾选；个别会话失败不影响其他结果，可以随时补导。构建与安装方式见 [开发指南](docs/development.md)。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳层 | Tauri 2.0 |
| 前端 | Vue 3 + TypeScript + Pinia |
| 存储 | 本机 SQLite 数据库（nexus.db）+ 全文索引 |
| 图谱 | D3.js 力向布局 |
| 配置 | YAML 配置文件（与业务数据分离） |

## 文档

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 完整产品设计文档 |
| [docs/data-spec.md](docs/data-spec.md) | 数据规范 |
| [docs/implementation-notes.md](docs/implementation-notes.md) | 实现细节记录 |
| [docs/development.md](docs/development.md) | 本地开发、调试与打包指南 |

---

<div align="center">
<sub>Nexus 织知 · 程序设计实践课程作品 · 本地优先，数据归你</sub>
</div>
