# Nexus 织知数据规范

> 本文件是数据层的权威规范。`docs/design.md` 描述产品行为；数据库 schema、TypeScript 类型、导入校验器、图谱派生逻辑和单元测试必须遵守本文件。字段名在数据库中使用 `snake_case`，在 TypeScript 中使用 `camelCase`。

## 1. 基本原则

1. 原始 Session 和 Message 先落库，任何 LLM 失败都不能删除或覆盖原始内容。
2. KnowledgeUnit 是一次 Session 内的具体讨论，不跨 Session 合并。
3. Concept 是跨 Session 复用的稳定知识主体；同一个 Concept 可以关联多个 Session 的多个 KnowledgeUnit。
4. Message 最多属于一个 KnowledgeUnit，也可以暂时不属于任何 KnowledgeUnit。
5. 一个 KnowledgeUnit 可以平等关联多个 Concept，不要求 `primary_concept_id`。
6. Concept 的父子关系允许多父节点，但必须是有向无环图。
7. `GraphNode`/`GraphEdge` 是派生视图，不是自动图谱事实表；缓存可以被删除并重建。
8. 所有用户可见数据修改必须能持久化；有风险的批量操作必须能撤销。
9. LLM 结果永远先经过本地 schema 和完整性校验，再进入业务表。
10. 所有跨实体关系使用内部 ID；来源平台 ID 只用于导入去重和追溯。

## 2. 命名与格式

### 2.1 ID

- 所有 ID 为非空 TEXT；
- ID 在应用内唯一，推荐格式为 `<entity>_<timestamp>_<random>`；
- 导入数据中的 `external_session_id` 不能直接作为本地 Session 主键；
- 关系表的复合唯一键必须防止重复关联。

### 2.2 时间

- 所有持久化时间使用 ISO 8601 UTC 字符串，例如 `2026-08-24T10:00:00.000Z`；
- 来源时间解析失败时保存为 `NULL`，不能伪造来源时间；
- `created_at` 创建后不可修改；
- `updated_at` 在用户可见数据或关系变更时更新。

### 2.3 文本

- 数据库保存原始文本，不做自动脱敏或内容级清理；
- 空白归一化只用于匹配字段，不覆盖用户看到的原文；
- Markdown、代码和链接作为内容展示，不执行其中的脚本或指令；
- `KnowledgeUnit.title` 不超过 30 个中文字符；
- `KnowledgeUnit.summary` 不超过 120 个中文字符；
- 超长标题/摘要不能静默截断：LLM 结果应标记校验错误，手动输入应显示长度提示。

### 2.4 归一化

`normalizeText` 仅用于索引和匹配：

1. Unicode NFKC 归一化；
2. 去除首尾空白；
3. 连续空白折叠为一个空格；
4. 统一中英文标点的可匹配形式；
5. 英文转大写；
6. 保留原始名称用于展示。

归一化结果不能替代原始 `name`/`alias`。别名和主名称的规范值必须全局唯一。

## 3. 实体定义

### 3.1 Session

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `source` | TEXT | 是 | `chrome_import`、`in_app`、`local` |
| `platform` | TEXT | 是 | 来源平台或 `local` |
| `model` | TEXT | 否 | 来源或当前模型 |
| `external_session_id` | TEXT | 否 | 与 `platform` 联合用于去重 |
| `title` | TEXT | 是 | 允许用户编辑，不为空 |
| `created_at` | TEXT | 是 | ISO 8601 |
| `updated_at` | TEXT | 是 | ISO 8601 |
| `message_count` | INTEGER | 是 | 可缓存统计值，不能为负 |
| `unit_count` | INTEGER | 是 | 可缓存统计值，不能为负 |
| `revision` | INTEGER | 是 | 从 1 开始，数据编辑时递增 |
| `local_only` | INTEGER | 是 | `0` 或 `1`，禁止 API 任务但不禁止 Prompt 粘贴 |
| `deleted_at` | TEXT | 否 | 软删除时间 |

不变量：

- `message_count` 应等于该 Session 的 Message 数量；显示时可以使用缓存，但维护任务应能重算；
- `unit_count` 应等于该 Session 的 KnowledgeUnit 数量；
- 删除 Session 必须级联或事务删除其 Message、KnowledgeUnit、NavTreeNode 和关联记录；
- Session 软删除后默认不出现在列表、搜索和图谱中；
- `platform + external_session_id` 相同的导入数据必须进入重复导入判定，不得静默创建第二条同源记录。

### 3.2 Message

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `session_id` | TEXT | 是 | 外键 → Session |
| `unit_id` | TEXT | 否 | 外键 → KnowledgeUnit；最多一个 |
| `role` | TEXT | 是 | `user`、`assistant`、`system` |
| `content` | TEXT | 是 | 可以为空字符串，但不能为 NULL |
| `order_in_session` | INTEGER | 是 | 从 0 开始，Session 内唯一、递增 |
| `timestamp` | TEXT | 否 | 来源时间 |
| `metadata` | JSON TEXT | 否 | 平台字段、附件引用等 |

不变量：

- `session_id` 必须与 `unit_id` 指向的 KnowledgeUnit.session_id 相同；
- 同一 Session 不能有两个 Message 使用同一 `order_in_session`；
- Message 删除属于高风险操作，默认只允许从 KnowledgeUnit 解绑，不删除原始消息；
- 尚未分配的 Message 必须可以被搜索和人工分配。

### 3.3 KnowledgeUnit

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `session_id` | TEXT | 是 | 外键 → Session，必填 |
| `title` | TEXT | 否 | ≤30 中文字符 |
| `summary` | TEXT | 否 | ≤120 中文字符 |
| `order_in_session` | INTEGER | 是 | 按首条 Message 顺序排序 |
| `status` | TEXT | 是 | `pending`、`ready`、`needs_review` |
| `revision` | INTEGER | 是 | 从 1 开始 |
| `created_at` | TEXT | 是 | |
| `updated_at` | TEXT | 是 | |

不变量：

- 一个 KnowledgeUnit 至少包含一条 Message 才能标记为 `ready`；
- 一个 KnowledgeUnit 的所有 Message 必须来自同一个 Session；
- 修改消息边界时 `revision + 1`，受影响标题、摘要和 Concept 任务变为 `stale`；
- KnowledgeUnit 可以没有任何 Concept，显示为待关联内容；
- KnowledgeUnit 不跨 Session 合并；维护任务只能提出“重新关联”，不能把两个 Session 的单元合并成一个。

### 3.4 Concept

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `name` | TEXT | 是 | 展示名称，全局唯一 |
| `normalized_name` | TEXT | 是 | 归一化名称，全局唯一 |
| `notes` | TEXT | 是 | 默认空字符串，可编辑 Markdown |
| `status` | TEXT | 是 | `active`、`archived`、`merged` |
| `merged_into_id` | TEXT | 否 | 合并追溯目标 |
| `created_at` | TEXT | 是 | |
| `updated_at` | TEXT | 是 | |
| `deleted_at` | TEXT | 否 | |

不变量：

- `name` 和 `normalized_name` 不能为空；
- `merged` Concept 必须有 `merged_into_id`，且目标不能是自身；
- `archived` Concept 不参与默认图谱和搜索，但不能从历史导出中丢失；
- 删除 Concept 只解除 UnitConcept 和 ConceptRelation，不删除 Session、Message 或 KnowledgeUnit；
- 合并是可撤销事务：关联、别名、关系和笔记变更必须有操作记录。

### 3.5 ConceptAlias

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `concept_id` | TEXT | 是 | 外键 → Concept |
| `alias` | TEXT | 是 | 全局唯一 |
| `normalized_alias` | TEXT | 是 | 全局唯一 |
| `source` | TEXT | 是 | `llm`、`manual`、`merge` |
| `created_at` | TEXT | 是 | |

别名不能与另一个 Concept 的主名称或别名产生规范化冲突。冲突必须进入人工确认。

### 3.6 UnitConcept

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `unit_id` | TEXT | 是 | 外键 → KnowledgeUnit |
| `concept_id` | TEXT | 是 | 外键 → Concept |
| `source` | TEXT | 是 | `llm`、`manual`、`maintenance` |
| `created_at` | TEXT | 是 | |

主键为 `(unit_id, concept_id)`。同一单元和 Concept 只能有一条关联；手动关联不能被后续自动整理静默删除。

### 3.7 ConceptRelation

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `parent_concept_id` | TEXT | 是 | hierarchy 的父节点，related 的一端 |
| `child_concept_id` | TEXT | 是 | hierarchy 的子节点，related 的另一端 |
| `relation_type` | TEXT | 是 | `hierarchy`、`related` |
| `source` | TEXT | 是 | `llm`、`manual`、`maintenance` |
| `status` | TEXT | 是 | `proposed`、`confirmed`、`rejected` |
| `created_at` | TEXT | 是 | |
| `updated_at` | TEXT | 是 | |

不变量：

- `hierarchy` 不允许自环和任何可达环；
- `related` 不表达方向语义，查询和图谱绘制应按无向关系处理；
- `proposed` 关系不能作为默认确认关系参与布局；
- 拒绝关系保留历史记录，但不参与图谱和搜索。

### 3.8 NavTreeNode / NavTreeNodeUnit

`NavTreeNode` 表示一次探索动作；`NavTreeNodeUnit` 将该动作关联到一个或多个 KnowledgeUnit。

不变量：

- 节点的 `session_id` 必须与其关联 KnowledgeUnit 的 Session 一致；
- `parent_id` 必须属于同一 Session；
- 根节点 `parent_id IS NULL` 且 `depth=0`；
- 非根节点 `depth = parent.depth + 1`；
- 一次追问即使生成多个 KnowledgeUnit，也只能创建一个探索节点；
- 导入线性会话可以创建链式节点；软件内回到旧节点继续提问创建新分支；
- 删除 KnowledgeUnit 前必须先解除 NavTreeNodeUnit 或由事务级联处理。

### 3.9 ContextReference

记录目标 Session 首条 Prompt 使用的来源 Session、KnowledgeUnit 或 Message。

不变量：

- `target_session_id` 与来源 Session 可以相同，但跨 Session 是主要用途；
- `source_unit_id` 和 `source_message_id` 至少有一个非空；
- `order_in_context` 在同一目标 Session 内唯一、从 0 开始；
- `include_full_content=0` 表示标题/摘要/Concept，`1` 表示附带完整原文；
- 新 Session 的 KnowledgeUnit 归属于目标 Session，不修改来源单元。

### 3.10 LLMTask

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `type` | TEXT | 是 | 分段、Concept、标题、摘要、起源、对话或维护 |
| `mode` | TEXT | 是 | `api`、`prompt_paste` |
| `provider_id` | TEXT | 否 | API 连接配置 ID |
| `model` | TEXT | 否 | 实际使用模型 |
| `prompt_version` | TEXT | 是 | Prompt Contract 版本 |
| `input_revision` | TEXT | 是 | Session/Unit revision 或输入哈希 |
| `prompt` | TEXT | 是 | 完整 Prompt |
| `response` | TEXT | 否 | 原始响应 |
| `parsed_result` | JSON TEXT | 否 | 通过本地校验的结果 |
| `validation_errors` | JSON TEXT | 否 | 校验错误列表 |
| `status` | TEXT | 是 | `pending`、`running`、`success`、`failed`、`needs_review`、`stale`、`cancelled` |
| `retry_count` | INTEGER | 是 | 非负整数 |
| `error_message` | TEXT | 否 | |
| `created_at` | TEXT | 是 | |
| `updated_at` | TEXT | 是 | |
| `scope_label` | TEXT | 否 | 用户可见范围说明 |

任务状态规则：

- `pending → running → success` 为正常路径；
- 网络错误、解析错误可进入 `failed`；
- 结构完整但需要用户确认进入 `needs_review`；
- 输入 revision 不再匹配时进入 `stale`，旧结果不得覆盖当前数据；
- 取消任务进入 `cancelled`，原始响应和已生成 Prompt 保留；
- 重试递增 `retry_count`，不能复制出没有来源的新任务。

## 4. LLM 结构化结果规则

### 4.1 分段结果

```json
{
  "units": [
    { "message_indices": [0, 1], "title_hint": "RDMA 基本原理" }
  ],
  "unassigned_message_indices": []
}
```

强制校验：

- 所有字段存在且类型正确；
- 所有索引为整数且 `0 <= index < message_count`；
- 单元之间不能重复索引；
- `units` 与 `unassigned_message_indices` 的并集必须恰好覆盖 `[0, message_count)`；
- 不允许空单元；
- `title_hint` 为空时允许进入后续标题任务，但不能使用完整句子冒充摘要。

### 4.2 Concept 结果

Concept 提取结果至少包含名称列表；可选返回别名和关系建议。系统必须检查：

- 名称非空且不是泛词；
- 名称经过归一化后不冲突；
- 引用的已有 Concept ID 必须存在；
- 父子关系不能成环；
- 不确定结果只能保存为 `proposed`，不能自动合并或删除。

### 4.3 维护建议

维护任务只允许返回建议变更，不允许返回“直接执行 SQL”或不可追溯的自由文本命令。每条建议需要包含类型、目标 ID、影响范围、理由和可逆操作描述。

## 5. 导入规范

### 5.1 外部 JSON

```json
{
  "schema_version": 1,
  "platform": "deepseek",
  "exported_at": "2026-08-21T10:00:00Z",
  "conversations": [
    {
      "external_session_id": "source-id",
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

### 5.2 重复导入

1. 优先使用 `platform + external_session_id`；
2. 缺少可靠 ID 时使用标题、创建时间和消息内容指纹；
3. 完全相同默认跳过；
4. 内容变化必须让用户选择更新原 Session、作为新 Session 导入或跳过；
5. 更新前自动备份；
6. 更新不能静默覆盖用户编辑过的标题、摘要、Concept 关联和导航树。

## 6. 图谱派生规则

### 6.1 节点

- 所有 active Concept → Concept 节点；
- KnowledgeUnit 节点按显示选项生成，点击 Concept 时强制显示相关单元；
- 未归属或用户主动展开的 Message → Message 节点；
- 节点 label 来自 Concept.name、KnowledgeUnit.title 或 Message 内容预览；
- 节点位置和视口是可丢弃的 GraphLayout，不是业务事实。

### 6.2 边

- 两个 Concept 共同关联一个 KnowledgeUnit，生成一次共现权重；共同单元越多，边越粗；
- Concept 与 KnowledgeUnit 有关联边；
- `hierarchy` 为有向边；`related` 按无向边呈现；
- 手动额外边单独保存；
- `proposed` 关系默认隐藏或以虚线呈现，除非用户开启显示；
- Concept 点击展开 KnowledgeUnit，不要求全局打开所有单元节点。

### 6.3 缓存

- 缓存键至少包含 `graph_revision`、节点显示选项和筛选条件；
- 导入、分段、Concept 关联、关系编辑、合并、删除和恢复成功后递增 `graph_revision`；
- 缓存失效不会影响业务数据；
- 自动图谱不允许出现无法从业务表重建的事实。

## 7. 配置与导出

### 7.1 `config.yaml`

- 配置文件与 `nexus.db` 分离；
- API Key 明文可编辑，应用必须提示本机读取风险；
- 配置解析失败时保留原文件，使用上一次有效配置；
- 首次启动不预设 LLM 模式，用户选择 API 或 Prompt 粘贴后才可启动任务；
- `local_only` Session 禁止 API 任务；
- 配置永不进入数据库备份或业务导出。

### 7.2 导出层级

- 完整知识库 JSON：可恢复，包含所有业务实体、关系、导航树、上下文引用和必要任务记录；
- 图谱快照 JSON：用于分享/分析，不承诺恢复；
- Session JSON：单个会话及其消息、单元和导航树；
- Concept Markdown：Concept 名称、别名、笔记、关系和关联单元；
- 所有导出带 `export_version`，不包含 API Key。

## 8. 版本与迁移

- `schema_meta.schema_version` 使用递增整数；
- 每次迁移前自动备份数据库；
- 迁移事务失败恢复备份；
- 新版本不得静默丢弃未知字段；
- JSON `export_version` 变化时提供兼容导入器或明确拒绝原因；
- 迁移测试必须覆盖空库、当前版本库、至少一个旧版本库和失败回滚。

## 9. 单元测试清单

- 所有实体字段的必填、枚举、长度和唯一约束；
- Message 与 KnowledgeUnit 的 Session 一致性；
- 分段索引的越界、重复、遗漏和全覆盖；
- Concept/别名归一化冲突；
- ConceptRelation 成环检测、多父节点和 proposed 状态；
- UnitConcept 去重、手动关联不被自动结果覆盖；
- NavTreeNode 父子 Session 一致、depth 计算和一对多单元关联；
- ContextReference 顺序和来源追溯；
- LLMTask revision 失效和状态迁移；
- Concept 合并/删除/恢复事务；
- 图谱共现权重、派生缓存和 revision 失效；
- 导入重复判定、完整导出/导入和 schema 迁移回滚。
