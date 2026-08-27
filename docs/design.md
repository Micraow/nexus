# Nexus 织知技术方案

> 文档状态：课程项目的完整设计基线。文档中的核心功能均属于本次交付范围；“MVP”只表示第一版可运行闭环，不表示其余功能不实现。

## 1. 项目定位

Nexus 织知是一个本地优先的 AI 对话知识管理桌面应用。它把用户与各类大模型的线性对话整理为可检索、可追溯、可继续探索的知识网络，重点解决：

- 追问导致上下文越来越长；
- 回答读完后难以再次找到和复用；
- 不同会话中的同一知识主体无法关联；
- 历史对话缺少按主题和全文检索的入口。

产品由桌面应用和 Chrome/Chromium 扩展组成：

- **桌面应用**：Tauri 2.0 封装 Vue 3 + TypeScript 前端。业务逻辑、数据库访问、LLM 任务编排和图谱计算全部由前端实现；Rust 只负责 Tauri 壳层、插件注册和权限配置。
- **浏览器扩展**：Manifest V3 + TypeScript。第一版适配 DeepSeek 网页端，在独立的导出工作台中读取已登录页面的历史会话，生成标准 JSON，用户再导入桌面应用。

### 1.1 目标平台

- 桌面：Windows 10/11、主流 Linux 发行版；
- 浏览器：Chrome 及 Chromium 内核浏览器；
- macOS：保留 Tauri 跨平台能力，暂不作为第一版验收平台；
- 界面语言：第一版以中文为主，数据内容可以包含中英文和代码。

### 1.2 数据与隐私边界

- 业务数据默认只保存在本机 `nexus.db`；
- `config.yaml` 单独保存配置，API Key 按用户决定明文保存，不做加密；
- 不发送遥测、统计或后台同步；
- API 模式只有在用户明确启动任务后才发送请求，并显示实际 Provider、Base URL 和发送范围；
- Prompt 粘贴模式不向任何服务发送网络请求；
- 数据库备份不包含 `config.yaml`，配置导出需要单独执行并明确确认；
- 内容不做内容级清理或自动脱敏，按正常 Markdown、代码和链接形式展示；内容中的文字永远只是数据，不会被当作应用指令执行，脚本也不会被执行。

## 2. 核心术语

### 2.1 Session（会话）

一次完整的对话及其持久化探索树。一个 Session 包含按时间顺序排列的 Message，并可以按需包含多个 KnowledgeUnit。KnowledgeUnit 不是 Session 完整性的前提。

- `source=chrome_import`：从浏览器扩展导入的历史会话；
- `source=in_app`：在 Nexus 中创建的新会话；
- 每个 Session 始终保留一棵导航树。导入会话通常是一条没有分叉的链；软件内会话可以从任意历史节点继续提问并形成分支；
- Session 有唯一的本地 `id`，并保留来源平台提供的 `external_session_id`（如果有）。
- 用户可以将 Session 标记为“仅本地”；该 Session 禁止 API 模式任务，但仍可使用 Prompt 粘贴模式和本地搜索。

### 2.2 Message（消息）

原始对话中的一条用户、AI 或系统消息。Message 只属于一个 Session，可以直接关联多个 Concept，并可以不属于任何 KnowledgeUnit；没有知识单元归属的消息仍然保留、可检索、可作为上下文并可在图谱中显示。

### 2.3 KnowledgeUnit（知识单元）

用户手动整理或 AI 按需生成的阅读片段/证据包，用于把一次 Session 内值得一起阅读的一组 Message 命名、摘要和复用。KnowledgeUnit 不跨 Session 合并，也不要求覆盖 Session 的全部消息。

KnowledgeUnit 是辅助内容结构，不是 Concept 提取或建图的前置条件：

- 导入后默认直接分析 Session/Message，不先强制分段；
- 没有 KnowledgeUnit 的 Session/Message 仍可直接关联多个 Concept；
- 用户可以从所选消息创建 KnowledgeUnit，AI 也可以在整理、分享或阅读需要时提出创建建议；
- `title` 不超过 30 个中文字符，表达这组证据独有的讨论角度；
- `summary` 不超过 120 个中文字符，概括主要结论、比较对象或关键问题；
- 关联的多个 Concept 不区分强制的主次概念。

当前版本不删除 KnowledgeUnit：它作为可选证据包承载标题、摘要、上下文选择和旧数据兼容；产品界面不把它呈现为“知识主题”的第二层。没有单元的 Message 仍可直接归属主题、检索、加入上下文和进入图谱，后续如需彻底移除必须先完成数据库导出/迁移及上下文选择替代方案。

例如：

```text
title：ECN 标记在 RDMA 拥塞控制中的作用
summary：讨论交换机如何通过 ECN 标记反馈拥塞，并比较 ECN、PFC 与 DCQCN 的作用边界。
Concept：RDMA 的拥塞控制、RDMA、拥塞控制、ECN、PFC、DCQCN
来源：某个具体 Session
```

### 2.4 Concept（概念）

跨 Session 复用、可聚合 Session、Message 和可选 KnowledgeUnit 的稳定知识主体。Concept 可以是单一概念，也可以是有明确语义的复合概念，例如：

```text
RDMA
拥塞控制
RDMA 的拥塞控制
ECN
PFC
```

同一个 Concept 可以关联多个 Session、Message 和 KnowledgeUnit；同一个 Session、Message 或 KnowledgeUnit 也可以同时关联多个 Concept。Concept 有名称、别名、用户笔记、父子关系和相关关系。

Concept hierarchy 不限制为固定层数，而是一个可有多个父节点的有向无环图（DAG）；`depth` 只是从根 Concept 计算出的派生值，不是数据模型的层数上限。KnowledgeUnit 和 Message 不会因为当前界面只显示根节点而被删除或改写。

`topic` 不再作为独立字段或独立实体使用。KnowledgeUnit 使用 `title` 表示本次具体讨论；Concept 表示可跨会话复用的主体。

### 2.5 ConceptAlias（概念别名）

Concept 的其他名称，例如 `RDMA Congestion Control`、`远程直接内存访问`。别名不是独立图谱节点，但参与搜索和归一化匹配。

### 2.6 ConceptRelation（概念关系）

Concept 之间有两种不同语义的关系：

- `hierarchy`：父 Concept → 子 Concept；允许一个子 Concept 有多个父 Concept；
- `related`：相关概念，是无向关系，不表达层级、父子顺序或根节点归属。

只有 `hierarchy` 参与根节点、祖先路径、展开深度和父子布局约束；`related` 不能用来判断一个 Concept 是否为根，也不能把节点从根投影中排除。父子关系整体禁止形成环；LLM 提出的不确定关系可以先为 `proposed`，用户确认后变为 `confirmed`。

例如：

```text
RDMA ──hierarchy──> RDMA 的拥塞控制 <──hierarchy── 拥塞控制
```

### 2.7 NavTreeNode（导航树节点）

记录 Session 中的一次探索动作，而不是 Concept 层级或分段结果。节点通过 `parent_id` 自引用形成持久化树；已有数据继续通过 `NavTreeNodeUnit` 关联一个或多个 KnowledgeUnit。没有 KnowledgeUnit 的导入会话仍按 Message 顺序浏览，软件内追问仍按提问/回答动作创建导航节点；后续扩展直接内容引用时不得为了创建导航树而伪造 KnowledgeUnit。

- 导入的线性会话：按原始消息顺序退化为链式浏览；已有 KnowledgeUnit 时可以作为阅读定位点；
- 软件内追问：一次用户提问及其回复形成一个节点，即使回复被分成多个 KnowledgeUnit；
- `trigger_concept_id` 可记录这次探索从哪个 Concept 发起；导入的节点可以为空；
- 返回旧节点再提问会创建新分支，不覆盖旧分支；
- 关闭应用后树结构仍可恢复。

对话答案中的主题标记使用 `[[nexus:existing:主题名称]]原文[[/nexus]]` 和 `[[nexus:suggested:主题名称]]原文[[/nexus]]`。已有主题以蓝色下划线呈现并可点击打开详情，建议探索主题以黄色下划线呈现；标记只影响展示，不改变事实归属。

### 2.10 会话保留与内容形态判断

原始 Session 和 Message 是不可丢失的事实层。导入、分段或 AI 判断失败都不能删除、覆盖或因为“不像知识”而隐藏这些内容；用户仍可检索、导出、查看原始会话，并在后续对话中把它们作为上下文来源。

导入后可创建一个 `session_triage` 任务，对会话给出 `knowledge`（知识）、`discussion`（探讨）、`procedure`（流程）、`mixed`（混合）和置信度。这个判断只是可修正的展示元数据，不是归档或删除依据。所有类型都保留原始会话；`mixed` 会话必须继续执行 Session/Message 级 Concept 提取，从探讨内容中识别稳定知识，不能因为整体不是知识文章而跳过。

图谱默认聚焦知识主题；“探讨与流程会话”选项打开后，才显示被判断为可保留的非主题会话。打开“消息与会话链”后，同一 Session 的原始消息按 `order_in_session` 连接成链；这是网页聊天树结构在当前数据模型下的可解释退化，未来可通过分支元数据恢复更细的树边。

### 2.8 ContextReference（上下文来源）

记录新 Session 的首条 prompt 使用了哪些旧 Session 的 KnowledgeUnit 或 Message。新 Session 产生的内容仍归属于新 Session，但可以追溯上下文来源。

### 2.9 LLMTask（LLM 任务）

一次可追踪、可重试、可人工接管的 LLM 调用。任务记录输入快照、Prompt 版本、模型、原始响应、校验结果和最终采用的结构化结果。

### 2.11 图谱派生视图

Concept、Session、Message 和 KnowledgeUnit 是图谱的节点类型，但 `GraphNode` 和 `GraphEdge` 不作为事实数据表保存。图谱节点和大部分边由业务表实时计算或从缓存生成；用户手动创建的特殊边、节点位置和视口状态单独保存。

图谱采用渐进式披露：默认只投影 active hierarchy 的根 Concept；用户点击 Concept 主体后逐层显示其直接子节点。展开祖先路径后，路径上的节点保持可见；收起某个祖先会递归收起其后代，后代的事实关系仍保留在数据库中。`related` 显示不参与层级展开；Session/KnowledgeUnit/Message 开关控制附加节点，不能被 Concept 展开绕过。

## 3. 数据模型

### 3.1 实体关系

```text
Session 1──N Message
Session 1──N KnowledgeUnit
KnowledgeUnit 1──N Message（Message.unit_id 可为空）
Session N──N Concept（SessionConcept）
Message N──N Concept（MessageConcept）
KnowledgeUnit N──N Concept（UnitConcept）
Concept 1──N ConceptAlias
Concept N──N Concept（ConceptRelation；hierarchy 为有向 DAG，related 为无向）
Session 1──N NavTreeNode
NavTreeNode 1──N NavTreeNode（parent_id 自引用）
NavTreeNode N──N KnowledgeUnit（NavTreeNodeUnit）
Session N──N Session/KnowledgeUnit/Message（ContextReference）
LLMTask、QuickPhrase、ManualGraphEdge、GraphLayout 独立记录
```

### 3.2 Session

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | Nexus 内部 ID |
| source | TEXT | `chrome_import` / `in_app` |
| platform | TEXT | `deepseek` / `qwen` / `glm` / `doubao` / `local` 等 |
| model | TEXT NULL | 来源或当前使用的模型 |
| external_session_id | TEXT NULL | 来源平台原始会话 ID |
| title | TEXT | 来源标题、用户标题或 LLM 生成标题 |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | 最近修改时间 |
| message_count | INTEGER | 可缓存的统计值，实际数量以 Message 为准 |
| unit_count | INTEGER | 可缓存的统计值，实际数量以 KnowledgeUnit 为准 |
| revision | INTEGER | Session 内容版本，编辑时递增 |
| local_only | INTEGER | 1=禁止 API 任务，0=遵循当前 LLM 模式 |
| deleted_at | TEXT NULL | 软删除时间，默认为空 |

`platform + external_session_id` 用于重复导入识别；没有可靠原始 ID 时使用标题、时间和消息内容指纹辅助判断。

### 3.3 Message

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| session_id | TEXT FK → Session | 必填，消息实际所属的 Session |
| unit_id | TEXT FK → KnowledgeUnit NULL | 尚未划分时为空 |
| role | TEXT | `user` / `assistant` / `system` |
| content | TEXT | 原始内容，按来源保留 |
| order_in_session | INTEGER | 全局顺序，从 0 开始 |
| timestamp | TEXT NULL | 来源平台提供时记录 |
| metadata | TEXT NULL | 平台字段、附件引用等 JSON |

### 3.4 KnowledgeUnit

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| session_id | TEXT FK → Session | 必填，知识单元实际产生的 Session |
| title | TEXT NULL | 不超过 30 个中文字符；生成失败时可暂为空 |
| summary | TEXT NULL | 不超过 120 个中文字符 |
| order_in_session | INTEGER | 按首条消息顺序排序 |
| status | TEXT | `pending` / `ready` / `needs_review` |
| revision | INTEGER | 消息边界或用户编辑时递增 |
| created_at | TEXT | |
| updated_at | TEXT | |

知识单元包含哪些消息目前由 `Message.unit_id` 表达。一个 Message 最多属于一个 KnowledgeUnit，但可以不属于任何 KnowledgeUnit；这个兼容约束只限制可选阅读片段，不限制 Message 通过 `MessageConcept` 同时归属多个知识主题。

### 3.5 Concept

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| name | TEXT UNIQUE | 归一化后的主名称 |
| normalized_name | TEXT UNIQUE | 用于本地匹配的规范形式 |
| summary | TEXT | ≤120 个中文字符的导航摘要，可为空 |
| notes | TEXT | 用户笔记，允许 Markdown |
| status | TEXT | `active` / `archived` / `merged` |
| merged_into_id | TEXT FK → Concept NULL | 合并追溯目标 |
| created_at | TEXT | |
| updated_at | TEXT | |
| deleted_at | TEXT NULL | 删除/撤销支持 |

删除 Concept 只解除关联和关系，不删除任何 Session、Message 或 KnowledgeUnit。归档 Concept 不参与默认图谱和搜索，但数据仍保留。

### 3.6 ConceptAlias

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| concept_id | TEXT FK → Concept | |
| alias | TEXT UNIQUE | 别名原文 |
| normalized_alias | TEXT UNIQUE | 规范形式 |
| source | TEXT | `llm` / `manual` / `maintenance` / `merge` / `import` |
| created_at | TEXT | |

### 3.7 UnitConcept

| 字段 | 类型 | 说明 |
|---|---|---|
| unit_id | TEXT FK → KnowledgeUnit | |
| concept_id | TEXT FK → Concept | |
| source | TEXT | `llm` / `manual` / `maintenance` / `merge` / `import` |
| created_at | TEXT | |

PRIMARY KEY 为 `(unit_id, concept_id)`。不设置强制的 `primary` 角色；一个 KnowledgeUnit 的多个 Concept 平等关联。

#### 3.7.1 SessionConcept / MessageConcept

Session 和 Message 直接归属于 Concept 的多对多关联表。两者都以“目标 ID + Concept ID”为复合主键，`source` 与 UnitConcept 使用相同枚举。

直接归属是 Concept 树的主要证据入口，不要求先存在 KnowledgeUnit。Session 级归属表达“这场会话涉及哪些主题”，Message 级归属表达“哪些原始消息直接支撑这些主题”；两者是独立事实，不能把 Session 归属自动复制为所有 Message 的归属。

### 3.8 ConceptRelation

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| parent_concept_id | TEXT FK → Concept | `hierarchy` 时为父节点；`related` 时为关系一端 |
| child_concept_id | TEXT FK → Concept | `hierarchy` 时为子节点；`related` 时为另一端 |
| relation_type | TEXT | `hierarchy` / `related` |
| source | TEXT | `llm` / `manual` / `maintenance` / `merge` / `import` |
| status | TEXT | `proposed` / `confirmed` / `rejected` |
| created_at | TEXT | |
| updated_at | TEXT | |

`hierarchy` 关系建立前必须做环检测。别名不建立 ConceptRelation。

### 3.9 NavTreeNode 与 NavTreeNodeUnit

`NavTreeNode`：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| session_id | TEXT FK → Session | |
| parent_id | TEXT FK → NavTreeNode NULL | 根节点为空 |
| trigger_concept_id | TEXT FK → Concept NULL | 发起该探索的 Concept |
| label | TEXT | 默认由标题生成，可手动编辑 |
| depth | INTEGER | 根节点为 0 |
| created_at | TEXT | |

`NavTreeNodeUnit`：

| 字段 | 类型 | 说明 |
|---|---|---|
| node_id | TEXT FK → NavTreeNode | |
| unit_id | TEXT FK → KnowledgeUnit | |
| order_in_node | INTEGER | 一个探索动作产生多个单元时保持顺序 |

PRIMARY KEY 为 `(node_id, unit_id)`。

### 3.10 ContextReference

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| target_session_id | TEXT FK → Session | 新建 Session |
| source_session_id | TEXT FK → Session | 来源 Session |
| source_unit_id | TEXT FK → KnowledgeUnit NULL | 来源知识单元 |
| source_message_id | TEXT FK → Message NULL | 可选的具体消息 |
| order_in_context | INTEGER | 用户选择的上下文顺序 |
| include_full_content | INTEGER | 0=摘要，1=原文 |

### 3.11 ManualGraphEdge 与 GraphLayout

`ManualGraphEdge` 只保存用户明确创建的额外关系，节点使用 `(node_type, ref_id)` 多态引用；不保存自动计算的共现边。

`GraphLayout` 保存 `(node_type, ref_id)` 的位置、固定状态和布局版本，以及每个用户的缩放/平移视口。删除或合并 Concept 时对应布局可以清理或迁移。

### 3.12 LLMTask

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| type | TEXT | `concept_extraction` / `origin_concepts` / `conversation` / `maintenance`，以及兼容或按需使用的 `segmentation` / `title` / `summary` |
| mode | TEXT | `api` / `prompt_paste` |
| provider_id | TEXT NULL | 实际使用的连接配置 |
| model | TEXT NULL | 实际模型 |
| prompt_version | TEXT | 内置或覆盖模板版本 |
| input_revision | TEXT | 输入数据版本或哈希 |
| prompt | TEXT | 完整 Prompt |
| response | TEXT NULL | LLM 原始回复 |
| parsed_result | TEXT NULL | 校验通过的结构化 JSON |
| validation_errors | TEXT NULL | 校验错误 JSON |
| status | TEXT | `pending` / `running` / `success` / `failed` / `needs_review` / `stale` / `cancelled` |
| retry_count | INTEGER | |
| error_message | TEXT NULL | |
| created_at | TEXT | |
| updated_at | TEXT | |

任务输入版本不匹配时，旧结果不得覆盖新数据，任务标记为 `stale`。

### 3.13 QuickPhrase 与 SchemaMeta

`QuickPhrase` 保存 `$(topic)`、`$(context)` 模板及用户自定义短语。`SchemaMeta` 保存数据库 schema 版本、`graph_revision` 和迁移信息。

## 4. 持久化、配置与迁移

### 4.1 数据库

- 默认数据库文件保存在应用数据目录的 `nexus.db`；高级用户可以在配置中指定其他路径，变更路径前必须确认并自动备份；
- 所有导入、任务结果、Concept 编辑、关系编辑和追问结果在事务提交后自动保存；
- 应用退出时再次保存；
- 写入采用临时文件 + 原子替换，避免应用崩溃留下半写文件；
- 启动时检查数据库完整性；
- 每次 schema 迁移前自动备份，迁移失败自动恢复备份并提示用户；
- `schema_version` 递增迁移，不使用破坏性的全量重建。

### 4.2 `config.yaml`

配置与业务数据库分离，位于同一应用数据目录。用户可以直接编辑，应用启动时读取；设置页修改会立即写回。YAML 解析失败时保留原文件，使用上一次有效配置并提示错误。

示例结构：

```yaml
llm:
  mode: prompt_paste
  default_provider: deepseek
  concurrency: 2
  token_budget: 32000
  providers:
    - id: deepseek
      name: DeepSeek
      base_url: https://api.deepseek.com/v1
      model: deepseek-chat
      api_key: ""
  task_overrides: {}
prompts:
  override_dir: ""
ui:
  theme: system
  reduced_motion: false
  graph:
    show_units: false
    show_messages: false
storage:
  database_path: ""
```

`token_budget` 是用户可调的估算输入上限，设置页允许手动输入不小于 `1000` 的有限安全整数，不设置产品级最大值。它同时用于长 Session 的运行时窗口切分和新对话上下文的超限校验；`8000` 仅是首次启动或配置值无效时的默认值，不是固定限制。修改后立即写回 `config.yaml`，只影响之后创建的窗口和对话任务。

API Key 按用户选择以明文存储；设置页必须明确提示能够读取该文件的本机用户也能看到 Key。配置文件不进入数据库备份和业务导出。

首次启动时不预设 API 或 Prompt 粘贴模式。用户选择一种模式后才允许启动 LLM 整理；在选择之前仍可导入、浏览、搜索和导出本地数据。当前版本不做自动敏感信息脱敏，用户需要自行决定哪些 Session 允许 API 任务。

### 4.3 Prompt 覆盖

Prompt 模板由程序内置、带版本号；高级用户可以通过 `prompts/` 目录覆盖。普通设置页不直接暴露模板编辑器，避免误改结构化契约。每个 `LLMTask` 记录实际模板版本和完整 Prompt。

### 4.4 数据库备份与导出

- 数据库备份：备份完整 `nexus.db`，用于精确恢复；
- 完整知识库 JSON：包含 Session、Message、KnowledgeUnit、Concept、别名、关系、导航树、上下文引用和必要的任务结果，可以重新导入；
- 图谱快照 JSON：只包含图谱节点、关系和显示信息，用于分享或外部分析，不承诺完整恢复；
- Concept 卡片 Markdown：导出单个 Concept 的名称、别名、笔记、关联单元和关系；
- 所有导出都带 `export_version` 和导出时间，永不包含 `config.yaml` 或 API Key。

## 5. LLM 接入与任务队列

### 5.1 统一接口

API 模式使用 OpenAI 兼容 Chat Completions 适配层，支持多个命名 Provider、全局默认配置和按任务覆盖。第一版提供 DeepSeek、OpenAI、通义千问兼容端点、智谱兼容端点和自定义 Base URL。

Prompt 粘贴模式生成同一份 Prompt，用户复制到任意网页端，再把回复粘贴回任务中心。两种模式对上层返回相同的结构化结果。

每次任务记录实际 Provider、模型、Prompt 版本、请求参数和结果。默认 API 并发数为 2，设置允许 1～4；Prompt 粘贴任务始终串行。遇到超时、网络错误或 429 时按退避策略重试，并保留暂停、继续、取消和单任务重跑。

### 5.2 导入与任务队列

导入阶段只做本地工作：校验 JSON、创建 Session 和 Message、写入数据库。LLM 整理进入待处理队列，用户确认后开始；“导入后自动整理”是可选设置，默认由用户选择，不隐式产生网络请求。开始前显示待处理会话数、任务数和预计调用次数。

任务中心显示：

- 待处理、运行中、成功、失败、需要检查和已过期任务；
- 当前进度、预计任务数量、实际 Provider、失败原因；
- 暂停、继续、取消、重试和查看原始响应；
- 失败或不确定项目的人工处理入口。

原始 Session/Message 永远先落库。校验通过的正常结果自动写入 KnowledgeUnit、Concept 和派生图谱；只有校验失败、版本冲突或模型明确不确定的项目进入待处理列表。LLM 失败不会阻塞阅读，也不会导致原始数据丢失。

### 5.3 长会话分块

短会话一次提交；超过可配置 token 预算的会话按消息顺序分块。分块只控制请求大小，不代表一个分块就是一个 KnowledgeUnit。

```text
全局消息 0～49 → 分块 1
全局消息 45～99 → 分块 2
全局消息 95～149 → 分块 3
```

相邻分块保留少量重叠消息。LLM 在每个分块中返回多个单元，并使用整个 Session 的全局消息索引。分块完成后，对边界候选单元执行合并复核；冲突无法判断时进入 `needs_review`。

## 6. Prompt Contract 与本地校验

每个 Prompt 都像一个带输入输出契约的工具调用，固定包含：

1. 角色与任务目标；
2. Nexus 术语定义；
3. 输入 JSON；
4. 输出 JSON Schema；
5. 必须满足的约束；
6. 禁止行为；
7. 正确和错误示例。

API 服务支持结构化输出时，同时使用接口级 JSON Schema；Prompt 粘贴模式依赖同一份契约和本地校验。结构化校验使用 TypeScript 的 schema 校验器（例如 Zod/JSON Schema），不得只依赖 `JSON.parse`。

### 6.0 固定 Harness 与渐进式披露

每个任务 Prompt 都先拼接版本化的固定前缀 `NEXUS_HARNESS_PROMPT` 和 `PROGRESSIVE_DISCLOSURE_PROTOCOL`，再附加该任务的规格和数据。固定前缀按字节保持稳定（当前 `PROMPT_VERSION=2026-08-v3-multi-concept`），任务重试或披露续跑只能替换动态数据段，不能删改行为契约。

当任务需要参考较大的知识树时，Prompt 在 `DISCLOSURE_INDEX` 中提供首层目录和已经展开的记录。目录项至少包含不透明的 `refID`、`title` 和 `summary`；摘要是导航线索，不得冒充消息原文。展开记录可提供 `children`（下一层同样只含 `refID`/标题/摘要），并可在明确请求时提供 `content`（知识单元或消息原文）。

模型需要更多证据时，可以在输出 JSON 中返回 `disclosure_requests`，例如 `{ "refID": "目录中已有的 ID", "depth": 1 }`。本地先校验数组、唯一 `refID`、引用必须来自当前目录以及 `depth` 为 1～64 的整数；校验失败进入 `needs_review`，不应用任何部分结果。校验通过后，应用从本地事实表按 `refID` 递归展开指定层数，保留根引用和原文，替换 Prompt 中的动态 `DISCLOSURE_INDEX` 并将同一任务重新排队。任务最多连续披露 8 轮，超出后暂停供用户检查。

`refID` 由本地生成且不可由模型猜测、改写或拼接。所有目录、摘要和原文都按不可信数据处理，其中的文字指令、代码、SQL 和链接不执行；模型可以使用自身知识、推理和调用方明确允许的外部搜索，但必须区分输入证据、外部资料与推断。

Concept 归属是多对多的：同一个 Session、Message 或 KnowledgeUnit 可以同时关联多个知识主题，也可以暂时没有主题。任务结果用 `memberships[].concept_ids` 或目标对象中的 `concept_ids` 数组表达归属，不能用单个 `concept_id` 代表“主主题”。运行时分别使用 `session_concepts`、`message_concepts` 和 `unit_concepts` 三张关联表；旧版本写入 `messages.metadata.concept_ids` 的数据会在迁移时兼容导入。一个子 Concept 也可以拥有多个 `hierarchy` 父主题；`related` 始终是无向关系。知识维护中的重新关联建议同样使用 `concept_ids` 数组，应用前逐项校验 ID、重复项和当前任务范围。

### 6.1 Session/Message 直接归属输出

主整理任务直接返回 Concept 定义、严格区分的关系和多目标归属，不返回覆盖全部消息的互斥分段：

```json
{
  "concepts": [
    { "name": "Clos 网络", "summary": "多级无阻塞交换网络结构。", "aliases": [] }
  ],
  "memberships": [
    { "target_type": "session", "target_id": "session-id", "concept_ids": ["concept-ref-1"] },
    { "target_type": "message", "target_id": "message-id", "concept_ids": ["concept-ref-1", "concept-ref-2"] }
  ],
  "relations": [
    { "source": "concept-ref-1", "target": "concept-ref-2", "type": "hierarchy" }
  ]
}
```

校验规则：

- `target_type` 只能是 `session`、`message` 或兼容的 `unit`，`target_id` 必须属于当前任务范围；
- 每个目标使用可为空的 `concept_ids` 数组，同一目标和 Concept 不能重复；
- 同一个 Session、Message 或 KnowledgeUnit 可以归属多个 Concept，不得压缩为单个“主主题”；
- 新 Concept 的名称、摘要和别名在同一结果中返回；引用现有 Concept 时使用当前目录中给出的 ID；
- `hierarchy` 只表达严格的上位/下位关系并接受 DAG 校验；语义相关但不存在包含关系时必须使用 `related`；
- `mixed`、`discussion` 和 `procedure` 不得成为跳过 Message 级知识识别的理由，没有稳定知识的目标可以返回空数组。

长 Session 可以使用带重叠上下文的窗口分批提取候选，但窗口只是运行时处理机制：每个窗口保留全局 Message ID，最后进行 Session 级去重、归一化、关系校验和归属合并。窗口边界不得持久化为 KnowledgeUnit，也不得被视为知识边界。

### 6.2 Concept 提取与归一化

LLM 返回 Concept 名称、别名和建议关系。系统按以下顺序寻找候选：

1. 名称/别名归一化后的精确匹配；
2. 本地字符 n-gram、前缀和倒排检索；
3. 将新 Concept、候选 Concept、当前 Session/Message 证据以及可选 KnowledgeUnit 标题/摘要交给 LLM 语义判断。

第一版不使用本地 embedding 模型。候选检索只是召回，不能直接决定合并。无法确定时产生 `proposed` 维护建议，用户确认后才变更。

归一化规则：英文统一大写、清理首尾空格、统一标点和空白、保留原始显示名称。系统不使用简单编辑距离作为最终合并依据。

### 6.3 摘要、起源 Concept 和可选 KnowledgeUnit

- Concept 的名称、摘要、别名和归属在同一次提取结果中返回，避免标题与摘要来自互不知情的任务；
- 起源 Concept 任务输入整个 Session，返回多个核心 Concept 候选以及 Session/Message 多归属，不限制为单个主题；
- KnowledgeUnit 只在用户手动选择消息或明确启动按需整理时创建；其标题、摘要和关联 Concept 可以在同一元数据任务中生成；
- KnowledgeUnit 标题不超过 30 个中文字符，摘要不超过 120 个中文字符，并只描述所选证据；
- 可选元数据生成失败不阻塞 Session/Message 的导入、直接 Concept 归属或图谱生成。

### 6.4 维护任务

维护任务由用户手动触发，可选择当前 Concept、当前 Session 或一组 Concept/KnowledgeUnit。默认只发送 Concept 名称、别名、关系、关联单元标题/摘要和来源信息；用户明确选择后才附带原始消息。

LLM 只返回建议变更：合并、别名、父子关系、相关关系、重新关联和标题修订。系统先展示影响数量与差异，用户逐条或批量确认后以可撤销事务应用。

## 7. 功能模块

### M1 数据导入

输入为带版本的 JSON 文件：

```json
{
  "schema_version": 1,
  "platform": "deepseek",
  "exported_at": "2026-08-21T10:00:00Z",
  "conversations": [
    {
      "external_session_id": "原始会话 ID",
      "title": "会话标题",
      "model": "deepseek-chat",
      "created_at": "2026-08-20T15:30:00Z",
      "messages": [
        { "role": "user", "content": "...", "timestamp": "..." },
        { "role": "assistant", "content": "...", "timestamp": "..." }
      ]
    }
  ]
}
```

流程：

1. 校验 schema、必填字段和消息角色；
2. 使用 `platform + external_session_id` 和内容指纹识别重复；
3. 先创建 Session/Message 并自动保存；
4. 显示新增、未变化和内容变化的会话数量；
5. 内容变化的会话由用户选择更新、作为新会话导入或跳过；
6. 用户确认后把整理任务放入队列。

重复导入默认跳过完全相同的会话，不静默覆盖用户编辑过的标题、Concept、摘要或导航树。覆盖前自动备份数据库。

### M2 会话判断与直接知识提取

读取一个 Session 及其 Message，先记录可修正的内容形态判断，再直接创建 Session/Message 级 Concept 提取任务。`knowledge`、`discussion`、`procedure` 和 `mixed` 都完整保留；`mixed` 必须继续识别其中稳定的知识。

默认整理不创建 `segmentation` 任务，也不等待 KnowledgeUnit、标题或摘要任务。长会话只在任务执行时按带重叠的窗口处理，并在 Session 级合并候选；窗口不写入业务表。

旧数据库中的 KnowledgeUnit、`Message.unit_id`、`NavTreeNodeUnit` 和历史 `segmentation`/标题/摘要任务继续可读、可编辑和导出。旧待处理分段任务可以完成、取消或转为人工处理，但新主流程不能依赖它们。

### M3 Concept 提取与塔式层级

一次任务可以创建/复用多个 Concept，并为 Session、Message 和可选 KnowledgeUnit 分别返回 `concept_ids[]`。关联分别写入 SessionConcept、MessageConcept 和 UnitConcept；同一目标可以同时支撑多个主题。

新 Concept 的名称、摘要和别名在同一结果中返回。`hierarchy` 只用于可证明的上位/下位关系并通过 DAG 校验；一般关联使用无向 `related`。明显关系可标记为 LLM 来源，无法确定的关系进入 `proposed`，不能为了让塔形更满而强行补父子边。

### M4 知识图谱

图谱是全局派生视图，节点类型为：

| 节点 | 含义 | 默认显示 |
|---|---|---|
| Concept | 跨会话聚合的知识主体 | 是 |
| KnowledgeUnit | 可选的阅读片段/证据包 | 否，仅在显示开关打开时显示 |
| Message | 直接支撑主题或用户主动展开的原始消息 | 否 |

自动关系：

- Concept-Concept 共现边：同一 Session 内共同出现的次数越多，边越粗；同一 Session 对同一 Concept 对最多贡献一次；
- Concept-Session / Concept-Message 归属边：直接来自 SessionConcept 和 MessageConcept，是没有 KnowledgeUnit 时的主要证据边；
- Concept-KnowledgeUnit 关联边：表示该单元涉及该 Concept；
- ConceptRelation hierarchy：父子关系，带方向；
- ConceptRelation related：相关关系；
- ManualGraphEdge：用户明确创建的额外边。

默认只显示 active hierarchy 的根 Concept 和已确认关系。根是“没有可见 hierarchy 父节点”的 Concept；`related` 边永远不参与根判断。`showProposed=false` 时 proposed hierarchy/related 均不参与根、祖先、展开和投影；侧边栏可以切换 KnowledgeUnit、Message、父子边、共现边、相关/手动边、待确认关系和保留的探讨/流程会话。

层级展开不设固定深度：

- `expandedConceptIds` 记录用户明确展开的节点，点击 Concept 主体同时更新详情并增加或移除它本身；有子节点时单击/Enter/Space 切换展开状态，叶节点单击只打开详情；
- 一个节点展开后显示其直接子节点，继续点击子节点才显示下一层；显式展开的后代会自动带上祖先路径；
- 收起祖先时递归清理该祖先的后代展开状态，后代回到折叠投影，但不改变事实关系；
- `expandedConceptDepth` 只用于需要确定性批量预展开的调用方，`0` 表示根节点，不能替代无限层级模型。

折叠层级下仍保留数据密度：隐藏 Concept 通过 hierarchy 向上投影到最近的可见祖先。每个 Session 汇总其直接、消息级和 KnowledgeUnit 级归属；同一 Session 对每一对可见代表 Concept 只贡献一次共现权重，多个单元、消息或隐藏叶节点落在同一对代表节点时不会重复计数，不同 Session 才会累加。KnowledgeUnit 节点仅在全局开关打开时出现，Message 节点仅按消息开关或保留会话筛选出现；这些局部披露不改变 Concept 的层级可见性。

`related` 是独立的无向边：可以在可见节点之间绘制，也可以随筛选隐藏，但从不触发祖先路径、子节点展开、根节点计算或 hierarchy 布局约束。待确认关系只有在 `showProposed=true` 时进入派生图谱。

交互：

- 单击 Concept 主体：同时打开详情；有子节点时逐层显示直接子节点，或递归收起该节点的后代；叶节点只打开详情；
- Concept 节点支持 Enter/Space 执行与单击相同的详情/展开语义，并暴露 `aria-expanded`；图谱上不提供独立的 `+/-` 展开控件；
- 单击 KnowledgeUnit：打开详情面板；
- Ctrl/Cmd 单击或框选：多选 KnowledgeUnit；
- 右侧上下文面板：排序、移除和发起新对话；
- 新对话工作区把持久化探索树放在回答内容右侧；小屏幕降为回答内容上方的单列导航，避免挤压消息阅读宽度；
- 主题详情的“包含消息”提供一个顶部全屏入口，跨 Session 汇总消息并按页浏览，不在每条消息旁重复放置全屏按钮；
- 拖拽只用于平移、缩放和调整布局，不用于隐式建边；
- 创建父子/相关关系通过操作菜单或多选命令，并在确认面板中明确显示关系方向（`related` 不显示父子方向）；
- 删除关系不删除节点；建立 hierarchy 前检查成环；
- 点击“重置布局”才重新计算力向布局，普通页面切换保留位置和视口。

### M5 对话与追问

点击 Concept 或导航树节点后，用户可以使用快捷短语或自定义问题。Prompt 可包含：相关 KnowledgeUnit 摘要、用户笔记、当前 Concept 层级、当前导航路径和用户问题。回复解析后创建新的 Session 内 KnowledgeUnit，并在当前 NavTreeNode 下创建一个新的探索子节点；一次回复若分成多个单元，全部通过 NavTreeNodeUnit 关联到同一个节点。

回复中的 Concept 以可点击文本展示：已有 Concept 跳转详情，新 Concept 进入待确认/添加流程。内容按正常 Markdown、代码和链接形式显示，不执行其中的文字指令。

从图谱或 Concept 详情发起的新对话总是创建新的 Session。首条 prompt 的上下文来源通过 ContextReference 记录。

### M6 Concept 详情

详情页包含：

- Concept 名称、别名和用户笔记；
- 父 Concept、子 Concept 和相关 Concept；
- 按时间或相关度排序的 KnowledgeUnit 列表；
- 每个单元的标题、摘要、来源 Session 和打开原会话位置；
- 合并、归档、删除、撤销和维护入口；
- “从此 Concept 开始新对话”。

排序支持名称、创建时间和关联 KnowledgeUnit 数量。

### M7 导航树

每个 Session 永久保存一棵导航树。导入会话按原始 Message 顺序退化为链式浏览，不要求先生成 KnowledgeUnit；软件内追问从当前节点创建子节点，回到旧节点继续提问形成兄弟分支。已有 KnowledgeUnit 可继续作为节点的阅读定位内容；返回操作回到父探索节点。

### M8 搜索

统一搜索入口覆盖 Concept 名称/别名、KnowledgeUnit 标题/摘要和 Message 全文。排序优先级为完全匹配 Concept、别名、单元标题、摘要、正文，再结合时间和相关度。点击结果可进入 Concept 详情、单元详情或 Session 中的具体消息位置。

优先使用 SQLite FTS5；如果当前 sql.js 构建不包含 FTS5，则使用本地字符 n-gram 索引回退。第一版不使用 embedding 语义搜索。

### M9 Concept 与图谱维护

#### 合并

用户选择多个 Concept 并指定保留目标：

- 其他名称加入目标 Concept 的别名；
- UnitConcept 关联去重并归到目标；
- 父子/相关关系取并集，清理自环；
- 笔记合并而不覆盖，保留来源；
- 被合并节点标记 `merged` 并记录 `merged_into_id`，默认不再显示；
- 整个操作为可撤销事务。

#### 删除与归档

删除只解除 Concept 关联和关系，不删除 Session、Message 或 KnowledgeUnit；如果删除的是一条父子引用，只提升受影响子主题，不删除子主题本身。归档只从默认图谱和搜索隐藏，但保留层级、单元和消息，恢复后按原关系重新出现。两者都支持撤销。

#### 关系编辑

用户可在知识主题详情或图谱侧栏编辑名称、别名、笔记及关系，增加子主题、设置或更换父主题、删除单条 hierarchy/related 关系，并查看影响范围。设置父主题前必须做 DAG 成环校验；`related` 的两端可互换，不能被当作父子关系。

删除一个父子引用只删除该条 hierarchy 事实，不删除子主题：若子主题仍有其他父主题，则保留其他路径；若已没有父主题，则提升为根节点（界面也提供“提升为根节点”以一次移除全部父引用）。收起或删除图谱中的可见节点同样不能删除其后代事实。LLM 建议关系显示为 `proposed`，支持批量确认、拒绝、修改和撤销。

#### 手动关联

用户可以在 KnowledgeUnit 或历史消息详情中增加/删除 Concept 关联，source 记录为 manual，立即生效且不触发无关的 LLM 任务。

### M10 上下文拼接

用户在图谱或详情页多选 KnowledgeUnit，右侧上下文面板显示选择顺序、来源 Session、摘要/原文开关和预计 token 数。用户可以拖动调整顺序、移除单元或切换为完整消息。

默认注入标题、摘要、关联 Concept 和来源 Session 标题；完整原文需要用户明确勾选。超出模型上下文上限时不得静默截断，必须提示用户移除单元、改用摘要或手动编辑上下文。实际使用的来源写入 ContextReference。

上下文面板默认只展示根引用的摘要；用户可以逐层展开 Concept 的子主题、KnowledgeUnit 及其 Message 原文，再把任意层级的选中项加入上下文。这个 UI 展开与 Prompt 的 `DISCLOSURE_INDEX` 使用同一组 `refID`，但不会绕过本地权限或事实表校验。

### M11 快捷短语

内置和自定义模板使用 `$(topic)`、`$(context)` 占位符。`$(topic)` 替换为当前 Concept，`$(context)` 替换为当前路径中可用的另一个 Concept；缺少上下文时给出可编辑提示，不生成空问题。

### M12 导出

支持完整知识库 JSON、图谱快照 JSON、单个 Session JSON 和 Concept Markdown。完整导出可以重新导入；快照只用于分享或分析。所有格式包含版本号，不包含配置和 API Key。

## 8. Concept 维护任务

维护由用户手动触发，范围可以是：当前 Concept、当前 Session、选中的 Concept 集合或选中的 KnowledgeUnit 集合。

默认输入为结构化摘要：Concept 名称/别名、层级和相关关系、关联单元标题/摘要、来源 Session 和统计信息。用户明确勾选后才附带完整 Message。

LLM 返回建议而不是直接修改，包括：

- 重复 Concept 合并候选；
- 别名候选；
- 新的父子或相关关系；
- KnowledgeUnit 重新关联建议；
- 标题或摘要修订建议。

界面显示每条建议的差异、影响的单元数量和来源。用户可以逐条或批量确认；确认、拒绝和撤销均记录在操作日志中。

## 9. Chrome/Chromium 扩展

### 9.1 第一版平台

第一版只适配 DeepSeek 网页端，使用平台适配器实现 DOM 读取，不修改原页面的视觉和交互。

### 9.2 独立导出工作台

点击扩展后打开独立的扩展页面作为导出工作台。用户保持一个已登录的 DeepSeek 标签页作为数据源。content script 与工作台通信，逐步读取侧边栏懒加载的历史会话和会话消息。

工作台支持：

- 当前会话导出；
- 搜索和勾选多个会话批量导出；
- 选择全部已发现会话；
- 进度、暂停、继续和失败重试；
- 成功与失败会话分别统计；
- 成功部分仍生成 JSON，失败项写入 `errors` 数组；
- 只有没有成功或失败结果（例如尚未选择或尚未读取任何会话）时才不生成文件；只有失败项时仍生成诊断 JSON。

扩展不得假设侧边栏一次包含全部会话；需要记录已发现的原始会话 ID 并去重。页面结构变化、登录失效或懒加载失败时显示明确原因和恢复操作。

## 10. 数据流

### 10.1 导入整理

```text
扩展导出 JSON
  → 桌面端校验 schema 和重复项
  → 事务写入 Session + Message
  → 用户确认任务队列
  → Session triage（只记录内容形态）
  → 直接提取 Session/Message 的 Concept 候选与多归属（长会话可使用临时重叠窗口）
  → Session 级归一化、去重和本地完整性校验
  → 写入 SessionConcept / MessageConcept
  → 建立或提议严格 hierarchy 与独立 related 关系
  → 按原始消息顺序提供链式浏览
  → 用户按需从所选消息创建 KnowledgeUnit 阅读片段
  → 刷新图谱派生缓存
```

旧数据中已经存在的 KnowledgeUnit 和导航树关联照常参与浏览与图谱；迁移不会删除或重切旧单元。旧 `segmentation` 任务保留审计记录，但不再阻塞新的直接 Concept 提取流程。

### 10.2 追问分支

```text
用户从 Concept 或导航节点发起问题
  → 选择快捷短语/自定义问题
  → 构造上下文和 Prompt
  → API 或 Prompt 粘贴模式执行
  → 校验回复结构
  → 在当前 Session 创建一个或多个 KnowledgeUnit
  → 创建一个 NavTreeNode 并关联这些单元
  → 提取 Concept、刷新图谱和高亮
```

### 10.3 Concept 合并

```text
用户选择 Concept
  → 指定保留目标
  → 预览别名、关联、关系和笔记差异
  → 事务合并
  → 被合并 Concept 标记 merged
  → graph_revision + 1
  → 支持撤销
```

## 11. 图谱缓存与性能

### 11.1 派生缓存

业务表是真相，图谱节点和自动边是派生视图。内存缓存按查询范围、筛选条件、`showUnits`/`showMessages`/`showProposed`/`showRetainedSessions`、`expandedConceptIds`（排序后）和 `expandedConceptDepth` 以及 `graph_revision` 缓存快照。导入、Session/Message/KnowledgeUnit 的 Concept 关联、按需创建或编辑 KnowledgeUnit、合并、删除和关系编辑事务提交后递增 `graph_revision`，相关缓存自动失效。

缓存不持久化为第二套事实数据。`GraphLayout` 只保存节点位置、固定状态和视口。未来若 profiling 证明需要，再增加持久化聚合表。

### 11.2 计算与渲染

- 共现边计算在 Worker 中执行，避免阻塞主线程；
- 图谱首次打开生成快照，缩放/平移/布局调整复用快照；
- 仅改变筛选条件时尽量从快照裁剪；
- 50 条以上的长列表使用虚拟滚动或分段加载；
- 任务进度超过 300ms 显示进度或 skeleton；
- 目标是交互操作反馈小于 100ms、稳定状态 60fps；
- 初始目标规模为约 500 个 Session、2 万条 Message，并为更大数据保留扩展余量。

### 11.3 任务并发

API 模式默认并发 2，设置可调为 1～4；同一 Session 的依赖任务保持顺序。Prompt 粘贴任务串行。遇到 429、超时和临时网络错误按退避策略重试。

## 12. 界面与交互规范

Nexus 采用克制的知识工作台风格，优先信息层级、可读性和长期使用舒适度，不使用装饰性渐变、光球或过重阴影。

### 12.1 布局

- 大屏：左侧主导航，中间工作区，右侧详情/筛选/上下文面板；
- 小窗口：右侧面板可折叠为抽屉，核心内容优先；
- “新对话”是默认首页，采用单一的大型对话输入区作为第一操作入口：问题、知识主题、快捷短语和上下文都在同一 composer 内完成，导入、最近会话和图谱入口作为辅助区域；
- 主工作区使用可用宽度和高度，避免把主要内容缩成几张悬浮小卡片；桌面端首页对话区和辅助区保持约 1000px 的舒适阅读宽度，其他工作页默认占满内容列；
- 知识图谱优先分配剩余空间，画布随视口高度伸展，显示选项作为窄侧栏保留；会话、知识主题和任务的空状态也占据主要面板，避免空库时页面只剩背景；
- 不依赖悬停完成关键操作；所有操作有可见按钮或菜单；
- 图标使用统一的 SVG 图标库，图标按钮提供 tooltip 和 aria-label；
- 主要按钮、输入框和列表行保留至少 44px 的可操作高度；
- 搜索、筛选、选中状态不能只靠颜色表达。

### 12.2 颜色、文字和内容

- 使用语义色 token，而不是在组件中散落原始色值；
- Concept、KnowledgeUnit、Message 使用不同颜色和图例，同时配合形状/线型；
- 正文基准字号 16px，行高 1.5～1.75；
- 中文优先系统字体，避免跨平台字体缺失；
- 正文、标题和链接满足 WCAG AA 对比度；
- 消息按正常 Markdown、代码和链接形式渲染，不执行其中的脚本或文字指令；
- 长文本默认换行，完整内容通过展开或详情面板查看，不用过度截断。

### 12.3 动画

- 普通展开/收起 160～220ms；
- 侧边面板 220～280ms；
- 图谱节点展开/收起 250～400ms；
- 使用 transform/opacity 和稳定尺寸，避免布局跳动；
- 进入使用 ease-out，退出略快于进入；
- 动画可中断，不锁住操作；
- `prefers-reduced-motion` 开启时改为近乎即时切换；
- 动画表达空间关系和因果，不添加无意义装饰动画。

### 12.4 图谱交互

- 滚轮/触控板缩放，拖拽平移和调整节点位置；
- Concept 主体点击同时打开详情并逐层显示直接子 Concept；叶节点只打开详情；Enter/Space 与单击一致，并在收起祖先时递归收起后代；图谱不绘制独立 `+/-` 控件；
- 全局力向布局对 hierarchy 关系增加吸引约束，使子 Concept 倾向于靠近父 Concept；一个子 Concept 有多个父节点时，布局在多个父节点之间取折中位置；
- Ctrl/Cmd 单击和框选用于多选；
- 关系创建使用菜单/确认面板，拖拽不创建关系；
- 详情面板和上下文面板从触发位置平滑展开；
- “重置布局”是显式操作，普通导航保留布局和视口。

## 13. 错误处理与恢复

| 场景 | 处理 |
|---|---|
| JSON 格式错误 | 指出文件位置和缺失字段，不写入部分业务数据 |
| 重复导入 | 显示新增/未变化/变化数量，由用户选择处理 |
| LLM 返回非 JSON | 结构化解析、局部提取、修复 Prompt，仍失败进入人工任务 |
| Concept 归属引用越界/重复/未知 ID | 不应用部分结果，显示具体目标和字段错误 |
| 旧版或按需分段遗漏/重复/越界 | 不应用部分结果，保留原始消息并显示具体索引错误 |
| Concept 候选不确定 | 生成 proposed 建议，不自动合并 |
| LLM API 超时/429 | 退避重试、暂停、继续和单任务重跑 |
| Prompt 粘贴结果缺失 | 保留任务和已粘贴内容，提示继续或重新粘贴 |
| 任务输入版本过期 | 标记 stale，禁止覆盖当前数据 |
| 数据库写入失败 | 回滚事务，保留原始文件和错误日志 |
| 数据库迁移失败 | 恢复迁移前备份并提示用户 |
| YAML 格式错误 | 保留原文件，使用上一次有效配置并提示修复 |
| 扩展懒加载/登录失效 | 保留已成功会话，显示失败原因和重试入口 |
| Concept 合并/删除 | 可撤销事务，不删除原始 Session/Message/KnowledgeUnit |

## 14. MVP 与完整交付范围

本项目是程序设计实践课程的完整作品，也面向个人长期使用和后续推广。文档定义的功能全部属于本次交付范围。MVP 只表示第一版先跑通可用闭环。

### 14.1 第一版可运行闭环

- DeepSeek 扩展导出工作台与标准 JSON 导出；
- JSON 导入、校验、重复处理和原始数据落库；
- Session triage、直接 Session/Message 多主题提取、归一化、别名和起源 Concept；
- Concept 层级与多归属校验、任务队列和人工接管；
- Concept/Session/Message/KnowledgeUnit 派生图谱、缩放、筛选和点击展开；
- Concept 详情、统一搜索、全文搜索；
- API 模式和 Prompt 粘贴模式；
- 完整知识库 JSON、图谱快照 JSON、Session JSON 和 Concept Markdown 导出；
- `nexus.db` 自动保存、备份、恢复和 schema 迁移。

### 14.2 完整功能交付

- 追问循环、分叉导航树和持久化恢复；
- 快捷短语和自定义模板；
- Concept 添加、编辑、别名、归档、删除、合并、撤销；
- 父子/相关关系维护和 proposed 建议确认；
- 图谱多选 KnowledgeUnit 和跨会话上下文拼接；
- 手动关系和手动 Concept 关联；
- Concept/KnowledgeUnit 维护任务；
- DeepSeek 扩展的当前、批量和全部已发现会话导出；
- 完整错误恢复、任务历史和操作记录。

### 14.3 实现里程碑

1. **数据基础**：数据库、迁移、导入、消息/Session 展示、备份和导出；
2. **自动整理**：Session triage、直接 Concept 多归属、层级校验、任务中心；KnowledgeUnit 按需生成；
3. **知识浏览**：图谱、Concept 详情、搜索和派生缓存；
4. **主动探索**：双 LLM 模式、追问、导航树和高亮；
5. **人工维护**：Concept 编辑/合并/删除、关系编辑、撤销；
6. **扩展与复用**：上下文拼接、DeepSeek 批量导出、完整错误恢复。

每个里程碑都保持应用可运行，并用真实的脱敏历史数据验证；最终功能以 14.1 和 14.2 为准。

## 15. 测试与验收文档

开发阶段需要编写单元测试和本文档中的验收场景；端到端验收由项目负责人在 Windows 和 Linux 上执行。

### 15.1 必须覆盖的单元测试

- JSON schema 校验、缺失字段和重复导入判断；
- 分段结果的索引范围、重复、遗漏和 `unassigned_message_indices` 覆盖校验；
- Concept 名称/别名归一化和本地 n-gram 候选检索；
- ConceptRelation 成环检测、无限层级、多父节点，以及 `related` 不改变根节点/祖先路径；
- UnitConcept 去重和手动关联；
- Concept 合并、删除、归档、软删除追溯和撤销；
- KnowledgeUnit revision 与 LLMTask stale 防覆盖；
- 导航树父子关系和 NavTreeNodeUnit 顺序；
- ContextReference 顺序和跨 Session 来源；
- 图谱根节点默认投影、逐层展开/递归收起、显式后代的祖先路径、折叠祖先的 KnowledgeUnit 共现权重聚合，以及展开参数和 `graph_revision` 的缓存失效；
- Prompt 固定 harness、`refID` 目录解析、递归 `disclosure_requests`、非法引用/深度拒绝和披露续跑上限；
- 搜索排序、FTS5/ n-gram 回退；
- YAML 解析、默认值、错误恢复和多 Provider 选择；
- schema 迁移、备份恢复和导出版本校验；
- 任务队列暂停、重试、取消和并发限制。

### 15.2 端到端验收场景（由项目负责人执行）

使用约 200 个 Session、3000 条 Message 的脱敏数据，重点检查原始消息不丢失、错误结果不静默写入、用户修改可持久化、图谱关系可追溯/撤销、完整导出可恢复，以及 DeepSeek 扩展的部分成功和失败重试。

## 16. 技术栈

| 层 | 技术 |
|---|---|
| 桌面封装 | Tauri 2.0；最小 Rust 壳层，仅注册插件、权限和窗口能力 |
| 前端 | Vue 3 + TypeScript + Vite |
| 状态管理 | Pinia |
| 路由 | Vue Router |
| 数据库 | sql.js（SQLite WASM，前端运行） |
| 校验 | TypeScript schema 校验（Zod/JSON Schema） |
| 图谱可视化 | D3.js |
| 任务计算 | Web Worker + 可取消任务队列 |
| HTTP | `@tauri-apps/plugin-http` |
| 文件系统 | `@tauri-apps/plugin-fs` |
| 对话框/剪贴板 | Tauri 官方插件 |
| 配置 | YAML 文件 |
| Chrome 扩展 | Manifest V3 + TypeScript |
| 图标 | 统一 SVG 图标库（如 Lucide） |

## 17. 设计决策记录

| # | 决策 | 理由 |
|---|---|---|
| 1 | Windows/Linux 优先，macOS 放缓 | 兼顾课程交付和推广范围 |
| 2 | Tauri 保留最小 Rust 壳层 | 可靠使用文件系统、HTTP 和权限，同时业务仍由 TS 实现 |
| 3 | sql.js 本地 SQLite | 本地优先，避免业务 Rust 化 |
| 4 | `nexus.db` 与 `config.yaml` 分离 | 数据备份不泄露配置，配置可编辑 |
| 5 | API Key 明文保存 | 方便用户迁移和修改，由设置页明确风险 |
| 6 | Session 永久拥有导航树 | 导入链和软件内分支都可恢复 |
| 7 | KnowledgeUnit 不跨 Session 合并 | 保留一次具体讨论的来源和边界 |
| 8 | Concept 跨 Session 聚合 | 表达可复用的知识主体 |
| 9 | KnowledgeUnit 不强制 primary Concept | 多个主体可以平等关联，避免人为强选主次 |
| 10 | ConceptRelation 是允许多父节点的 DAG | 表达复合 Concept 的多重父主题 |
| 11 | GraphNode/GraphEdge 为派生视图 | 避免事实数据和图谱缓存不一致 |
| 12 | 图谱使用 revision 缓存 | 兼顾性能和一致性，缓存可丢弃重建 |
| 13 | 不使用 embedding | 规模可控，依赖少，先用本地文本候选 + LLM 判定 |
| 14 | 导入先落库，LLM 任务由用户确认 | 防止配置错误、费用和网络问题影响原始数据 |
| 15 | Prompt 是版本化契约 | 提升结构化输出稳定性和可追踪性 |
| 16 | 本地校验优先于 LLM 结果 | 防止遗漏、重复和越界数据静默写入 |
| 17 | 维护任务先建议后确认 | 避免 LLM 直接改变知识结构 |
| 18 | Concept 合并可撤销 | 降低批量维护误操作风险 |
| 19 | 图谱拖拽只调整视图 | 建关系通过明确菜单，避免误操作 |
| 20 | DeepSeek 扩展使用独立导出工作台 | 不改原页面，支持懒加载和批量处理 |
| 21 | 部分导出成功仍生成文件 | 单个会话失败不阻塞其他历史数据 |
| 22 | 完整 JSON 与图谱快照分开 | 区分可恢复备份和可分享数据 |
| 23 | 动画统一、可中断、支持减少动态 | 保证长期使用的流畅性和可访问性 |

## 18. 术语表

| 术语 | 定义 |
|---|---|
| Session | 一整串对话及其持久化探索树 |
| Message | Session 中的一条原始消息 |
| KnowledgeUnit | Session 中语义连续的一段具体讨论 |
| Concept | 可跨 Session 聚合 KnowledgeUnit 的稳定知识主体 |
| ConceptAlias | Concept 的别名，不是独立节点 |
| ConceptRelation | Concept 的父子或相关关系 |
| UnitConcept | KnowledgeUnit 与 Concept 的多对多关联 |
| NavTreeNode | 一次探索/追问动作的导航节点 |
| NavTreeNodeUnit | 导航节点与一个或多个 KnowledgeUnit 的关联 |
| ContextReference | 新 Session 使用旧内容的来源记录 |
| LLMTask | 一次可追踪、可校验、可重试的 LLM 调用 |
| proposed | LLM 提出的、尚未由用户确认的关系或维护建议 |
| stale | 输入版本过期、结果不得覆盖当前数据的任务 |
| co-occurrence | 两个 Concept 在同一 Session 中共同出现的聚合关系 |
| ManualGraphEdge | 用户明确创建并持久化的图谱额外边 |
| Prompt 粘贴模式 | 生成 Prompt，用户在网页端执行并粘贴回复 |
| API 模式 | 通过用户配置的 OpenAI 兼容端点执行任务 |
| graph_revision | 影响图谱派生结果的业务数据版本号 |
