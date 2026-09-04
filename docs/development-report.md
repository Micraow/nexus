# Nexus 织知开发报告

## 1. 项目概述

Nexus 织知是一款本地优先的 AI 对话知识管理桌面应用，目标是把分散在不同会话中的问答内容整理为可检索、可追溯、可继续探索的知识网络。系统以 `Session` 和 `Message` 保存完整原始对话，以 `Concept` 表示可跨会话复用的知识主题，并根据主题层级、内容归属和会话共现关系生成知识图谱。

项目同时提供 Chrome/Chromium 浏览器扩展，用于从 DeepSeek 网页端导出历史会话；桌面端负责导入、整理、搜索、图谱展示、追问和数据导出。整体设计强调本地数据主权：原始数据默认保存在本机，只有用户明确启动 API 任务时才向配置的模型服务发送请求。

## 2. 主要功能

- **对话导入**：扩展从 DeepSeek 页面捕获会话数据，支持懒加载会话列表、部分成功导出和失败项诊断；桌面端导入 JSON 时先校验并保存原始 `Session/Message`。
- **AI 辅助整理**：通过 API 模式或 Prompt 粘贴模式识别会话中的知识主题、主题归属和层级关系。结果先进入本地校验和人工确认流程，再写入业务数据。
- **知识图谱**：以主题为核心展示层级关系、主题共现关系、阅读片段和消息证据，支持缩放、拖拽、悬停高亮、框选以及逐层展开和递归收起。
- **统一搜索**：搜索知识主题、别名、阅读片段和消息，结合字段权重、文本匹配、字符 n-gram 和 SQLite FTS 能力进行排序。
- **对话追问**：从主题、消息或上下文发起新问题，生成独立的会话导航分支；回答通过校验后才持久化为助手消息、阅读片段和导航节点。
- **上下文拼接与导出**：按用户选择的顺序组合跨会话主题、片段和消息，可导出完整知识库、图谱快照、会话或主题 Markdown。
- **知识维护**：支持全图或局部维护，采用渐进式披露减少单次 Prompt 的数据量，并由用户逐条确认模型提出的关系、归属和编辑建议。

## 3. 技术栈与职责

| 层次 | 技术 | 使用方式 |
|---|---|---|
| 桌面应用 | Tauri 2.0、Rust | 提供窗口、文件系统、HTTP、对话框、剪贴板和权限能力；Rust 壳层保持最小化 |
| 前端 | Vue 3、TypeScript、Vite | 页面、组件、类型约束和构建工具 |
| 状态管理 | Pinia | 由 `workspace` store 统一维护业务事实、任务队列和 UI 所需派生状态 |
| 本地数据库 | `sql.js`、SQLite WASM | 在 TypeScript 侧执行 SQLite；桌面运行时持久化到 `nexus.db`，浏览器开发模式使用 IndexedDB 保存数据库字节流 |
| 数据校验 | Zod | 校验导入 JSON、LLM 结构化结果、ID 范围、归属关系和维护动作参数 |
| 图谱可视化 | D3.js | SVG 图谱、力向布局、缩放拖拽、节点交互和视图投影 |
| 异步计算 | Web Worker | 将图谱构建和部分派生计算移出主线程，避免大数据量下阻塞界面 |
| 网络与配置 | Tauri HTTP 插件、原生 `fetch`、`js-yaml` | 桌面端绕过 WebView CORS，浏览器开发端回退原生请求；配置保存为独立 YAML 文件 |
| 扩展 | Chrome Manifest V3、TypeScript | 通过 service worker、MAIN world bridge 和 content script 采集 DeepSeek 会话 |
| 展示辅助 | `highlight.js`、`katex`、`lucide-vue-next` | 代码高亮、数学公式、统一图标和交互控件 |

## 4. 局部实现技巧与设计模式

### 4.1 本地优先与运行时适配

数据库、文件、剪贴板和 HTTP 均通过服务层封装。`services/tauri.ts` 负责识别运行环境，`services/http.ts` 在 Tauri 中使用 `@tauri-apps/plugin-http`，在浏览器开发模式回退原生 `fetch`；导出文件和剪贴板也采用相同的适配思路。这样可以用浏览器快速调试前端和业务逻辑，同时保留桌面端的真实文件和网络能力。

Tauri Rust 层只提供系统边界能力，例如数据库字节流读写、原子文件写入、备份恢复、系统字体读取和 Linux 输入法环境初始化。业务规则仍集中在 TypeScript 中，降低跨语言维护成本。

### 4.2 “事实数据 + 派生视图”模式

`Session`、`Message`、`KnowledgeUnit`、`Concept`、各类归属表和 `ConceptRelation` 是业务事实；`GraphNode`、`GraphEdge`、主题共现边以及节点深度属于图谱派生结果，不单独作为事实表保存。图谱服务根据关系和归属实时投影根主题、可见后代、证据节点及边权重。

所有会影响图谱结果的业务事务提交后才递增 `graph_revision`，缓存以 revision、筛选条件和展开状态作为键。任务轮询、流式文本和普通 UI 状态不会导致图谱缓存失效，从而避免画布闪烁，也保证缓存丢失时可以由数据库重建。

### 4.3 版本化 Prompt 与渐进式披露

`services/prompts.ts` 将固定的 `NEXUS_HARNESS_PROMPT`、任务规格、输出契约和动态数据组合为版本化 Prompt。面对较大的知识图谱，首轮只发送目录项和摘要；模型通过 `disclosure_requests` 请求指定 `refID` 的更多内容，应用本地展开并重新排队同一任务。

这种方式把“模型可见范围”变成显式授权边界：目录中的 `refID` 必须来自本地生成的 ID，只有已经披露且带有结构化 `content` 的实体才能被写入结果，披露轮数也受到上限约束。

### 4.4 本地校验与原子提交

LLM 返回值不会直接写入数据库。系统依次检查 JSON 结构、字段长度、当前任务范围、重复 ID、Concept 归属、层级 DAG 环和维护动作白名单；失败结果保留原始响应并进入 `needs_review`。最终通过校验的结果与 `accept_validated_result` 状态转换在同一事务中提交，避免出现“任务成功但业务事实只写入一部分”的状态。

Concept 关系建立前使用 `wouldCreateHierarchyCycle` 检测环；Concept 合并、批量确认和知识库恢复也通过事务和操作记录支持撤销或回滚。

### 4.5 事件驱动的任务状态机

`services/task-state.ts` 使用 `transitionTaskState(from, event)` 作为唯一状态转换入口，事件包括 `start`、`retry`、`continue_disclosure`、`accept_validated_result`、`reject_validation`、`fail_transport`、`cancel` 和 `invalidate`。页面不根据按钮是否显示、流式文本是否为空或临时布尔值判断完成状态，而是从持久化的 `LLMTask.status + phase` 推导展示。

API 任务通过 `runQueue -> executeTask -> applyTaskResult` 执行，使用 `AbortController` 支持超时和取消，并按配置限制并发；流式响应按 `taskId` 绑定到对应对话卡片，最终结果仍以完整 JSON 校验为准。

### 4.6 扩展的多级降级采集

扩展优先在 MAIN world 中包装 `fetch/XHR`，捕获同源 JSON 响应并通过 `CustomEvent` 转发；content script 再从响应对象中提取消息。网络数据不足时回退读取 IndexedDB，页面结构变化或接口捕获失败时再回退 DOM 提取。会话列表采用增量滚动，连续多次无新增节点后才判定扫描结束，以适应虚拟列表和懒加载页面。

## 5. 业务分层架构

项目采用“视图层、状态编排层、领域服务层、持久化与系统适配层”的分层方式。主要调用关系如下：

```text
Vue 视图与组件
        |
        v
Pinia workspace store（业务用例、事务编排、任务队列）
        |
        +--> 领域服务：prompts / validation / graph / search / conversation
        |                         / markdown / task-state / config
        |
        +--> 数据访问：services/db.ts（SQLite schema、迁移、查询、持久化）
        |
        +--> 系统适配：tauri / http / files / clipboard
                         |
                         +--> Tauri 2 Rust 壳层或浏览器 API
```

各层职责如下：

1. **视图层**：`App.vue` 负责模块布局、用户意图和页面状态；`GraphCanvas.vue`、`ConceptTree.vue`、`ConversationTree.vue`、`ReadingUnitsView.vue` 等组件负责局部展示与交互，不直接操作数据库或修改任务状态。
2. **状态编排层**：`stores/workspace.ts` 是主要业务入口，负责导入、任务创建和执行、对话分支、关系维护、导出、事务提交、队列暂停/重试/取消以及数据刷新。
3. **领域服务层**：Prompt 构造、结构化校验、任务状态转换、图谱投影、搜索排序、对话分支判定、Markdown 安全渲染等逻辑保持为相对独立的纯函数或服务，便于单元测试和复用。
4. **数据访问层**：`services/db.ts` 定义 SQLite 表结构、索引、迁移、备份和恢复。数据库是真相来源，配置文件单独由配置服务和 Tauri 文件命令管理。
5. **系统适配层**：Tauri 插件和浏览器 API 被封装在 `tauri.ts`、`http.ts`、`files.ts`、`clipboard.ts` 等模块中，向上层提供统一接口。
6. **外部输入边界**：浏览器扩展输出版本化 JSON；LLM 输出必须经过 Prompt 契约和本地校验；消息正文、链接、Markdown 和模型返回内容都按不可信数据处理。

数据流可以概括为：

```text
DeepSeek 扩展导出
  -> JSON 校验
  -> Session / Message 落库
  -> session_triage 与 Concept 任务
  -> Prompt / API 执行
  -> 本地校验与人工确认
  -> Concept 归属、关系和可选 KnowledgeUnit
  -> 图谱、搜索、主题详情和追问上下文
```

其中，`KnowledgeUnit` 是可选的阅读片段或证据包，不是导入、主题提取或图谱展示的前置条件；`Concept` 的多对多归属和多父层级 DAG 才是知识组织的核心。

## 6. 测试与工程质量

项目使用 Vitest、TypeScript 类型检查和针对关键界面的测试覆盖以下内容：导入与迁移、搜索排序、中文匹配、Markdown 安全渲染、图谱投影、渐进式披露、任务状态机、对话分支恢复、消息分页、扩展发现与导出，以及维护动作契约。文档记录的当前验收规模为 274 项单元测试，并辅以 headless Chromium 的界面冒烟验收和真实脱敏数据验证。

工程实现重点关注三类风险：原始对话不能因 LLM 失败而丢失，未经校验的模型结果不能污染知识库，图谱缓存和任务状态不能脱离数据库事实。桌面端还需要在真实环境中继续验证备份恢复、不同平台打包、WebView 权限和用户自定义 Provider 的兼容性。

## 7. 总结

Nexus 织知的核心实现不是简单地把聊天记录展示出来，而是建立了一条从原始对话、结构化主题、证据归属到可继续探索图谱的本地业务链。项目通过 Tauri 的跨平台桌面能力、Vue/TypeScript 的业务实现、SQLite 的本地持久化、D3 的派生图谱和严格的 LLM 校验流程，兼顾了可用性、数据可追溯性和实现可维护性。

