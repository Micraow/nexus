# Nexus 织知数据规范

> 本文件是数据层的权威规范。`docs/design.md` 描述产品行为；数据库 schema、TypeScript 类型、导入校验器、图谱派生逻辑和单元测试必须遵守本文件。字段名在数据库中使用 `snake_case`，在 TypeScript 中使用 `camelCase`。

## 1. 基本原则

1. 原始 Session 和 Message 先落库，任何 LLM 失败都不能删除或覆盖原始内容。
2. KnowledgeUnit 是一次 Session 内可选的阅读片段/证据包，不跨 Session 合并，也不要求覆盖全部 Message。
   它不是 Concept 层级的一部分；当前版本保留该实体用于证据包、上下文选择和旧数据兼容，直接 Session/Message 归属不依赖它。
3. Concept 是跨 Session 复用的稳定知识主体；同一个 Concept 可以关联多个 Session、Message 和 KnowledgeUnit。
4. Message 最多属于一个 KnowledgeUnit，也可以不属于任何 KnowledgeUnit；它可以通过 MessageConcept 同时归属多个 Concept。
5. Session、Message 和 KnowledgeUnit 都可以平等关联多个 Concept，不要求 `primary_concept_id`。
6. Concept 的父子关系允许多父节点，但必须是有向无环图。
7. `GraphNode`/`GraphEdge` 是派生视图，不是自动图谱事实表；缓存可以被删除并重建。
8. 所有用户可见数据修改必须能持久化；有风险的批量操作必须能撤销。
9. LLM 结果永远先经过本地 schema 和完整性校验，再进入业务表。
10. 所有跨实体关系使用内部 ID；来源平台 ID 只用于导入去重和追溯。
11. 对话答案中的 `[[nexus:existing:...]]...[[/nexus]]` 与 `[[nexus:suggested:...]]...[[/nexus]]` 是展示标记，不是数据库归属字段；应用渲染时分别使用已有主题和建议主题样式。

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

- `session_id` 必须与 `unit_id` 指向的 KnowledgeUnit.session_id 相同；`unit_id` 为空是正常状态，不得视为导入失败；
- 同一 Session 不能有两个 Message 使用同一 `order_in_session`；
- Message 删除属于高风险操作，默认只允许从 KnowledgeUnit 解绑，不删除原始消息；
- 尚未分配的 Message 必须可以被搜索、直接归属多个 Concept、作为上下文来源，并可在需要时人工整理为 KnowledgeUnit。

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
- 修改消息边界时 `revision + 1`，只使该单元的可选标题、摘要和 UnitConcept 任务变为 `stale`；
- KnowledgeUnit 可以没有任何 Concept，显示为待关联内容；
- KnowledgeUnit 不跨 Session 合并；维护任务只能提出“重新关联”，不能把两个 Session 的单元合并成一个。

KnowledgeUnit 的创建、标题、摘要或边界变化不得使 SessionConcept/MessageConcept 失效，也不得阻塞直接 Concept 提取。

### 3.4 Concept

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `name` | TEXT | 是 | 展示名称，全局唯一 |
| `normalized_name` | TEXT | 是 | 归一化名称，全局唯一 |
| `summary` | TEXT | 否 | ≤120 个中文字符，用于目录和渐进披露导航 |
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
- Concept 的 hierarchy 深度不设业务上限，允许多父节点；`depth`、根节点和祖先路径均由 ConceptRelation 派生，不写回 Concept；
- 合并是可撤销事务：关联、别名、关系、摘要和笔记变更必须有操作记录。

### 3.5 ConceptAlias

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `concept_id` | TEXT | 是 | 外键 → Concept |
| `alias` | TEXT | 是 | 全局唯一 |
| `normalized_alias` | TEXT | 是 | 全局唯一 |
| `source` | TEXT | 是 | `llm`、`manual`、`maintenance`、`merge`、`import` |
| `created_at` | TEXT | 是 | |

别名不能与另一个 Concept 的主名称或别名产生规范化冲突。冲突必须进入人工确认。

### 3.6 UnitConcept

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `unit_id` | TEXT | 是 | 外键 → KnowledgeUnit |
| `concept_id` | TEXT | 是 | 外键 → Concept |
| `source` | TEXT | 是 | `llm`、`manual`、`maintenance`、`merge`、`import` |
| `created_at` | TEXT | 是 | |

主键为 `(unit_id, concept_id)`。同一单元和 Concept 只能有一条关联；手动关联不能被后续自动整理静默删除。

### 3.7 SessionConcept / MessageConcept

Session 和 Message 也可以直接归属于多个 Concept。两类直接归属分别保存在
`session_concepts(session_id, concept_id)` 和
`message_concepts(message_id, concept_id)`，复合主键防止重复关联，并通过外键
级联到所属实体和 Concept。`source` 使用与 UnitConcept 相同的来源枚举
（`llm`、`manual`、`maintenance`、`merge`、`import`）。

直接归属是独立事实：Session 归属不会在数据库中复制成该 Session 的所有
Message 或 KnowledgeUnit 归属。图谱需要展示 Session 主题时可以把它投影到对应
单元或未分段消息，但编辑或移除直接归属只修改对应关联表。旧版本曾把未分段
Message 的 `metadata.concept_ids` 作为兼容字段；schema v4 会将其中存在的
Concept ID 导入 `message_concepts`，同时保留 metadata 原文以便回溯。

### 3.8 ConceptRelation

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `parent_concept_id` | TEXT | 是 | hierarchy 的父节点，related 的一端 |
| `child_concept_id` | TEXT | 是 | hierarchy 的子节点，related 的另一端 |
| `relation_type` | TEXT | 是 | `hierarchy`、`related` |
| `source` | TEXT | 是 | `llm`、`manual`、`maintenance`、`merge`、`import` |
| `status` | TEXT | 是 | `proposed`、`confirmed`、`rejected` |
| `created_at` | TEXT | 是 | |
| `updated_at` | TEXT | 是 | |

不变量：

- `hierarchy` 不允许自环和任何可达环；
- `hierarchy` 构成可无限向下扩展且允许多父节点的 DAG；只有它参与父级、子级、祖先、后代、根节点和深度计算；
- `related` 不表达方向语义，查询、去重和图谱绘制应按无向关系处理；`parent_concept_id`/`child_concept_id` 对它只是两个存储端点，绝不能用于判断父子或根节点；
- `proposed` 关系不能作为默认确认关系参与布局；
- 拒绝关系保留历史记录，但不参与图谱和搜索；
- 删除一条 hierarchy 只解除该父子引用，不删除任一 Concept；子节点仍有其他父级时保留其他路径，否则自然成为根节点。提升为根节点等价于可撤销地删除该节点的全部 hierarchy 父引用。

### 3.9 NavTreeNode / NavTreeNodeUnit

`NavTreeNode` 表示一次探索动作；`NavTreeNodeUnit` 将该动作关联到一个或多个 KnowledgeUnit。

不变量：

- 节点的 `session_id` 必须与其关联 KnowledgeUnit 的 Session 一致；
- `parent_id` 必须属于同一 Session；
- 根节点 `parent_id IS NULL` 且 `depth=0`；
- 非根节点 `depth = parent.depth + 1`；
- 一次追问即使生成多个 KnowledgeUnit，也只能创建一个探索节点；
- 导入线性会话可以创建链式节点；软件内回到旧节点继续提问创建新分支；
- 删除 KnowledgeUnit 前必须先解除 NavTreeNodeUnit 或由事务级联处理。

### 3.10 ContextReference

记录目标 Session 首条 Prompt 使用的来源 Session、KnowledgeUnit 或 Message。

不变量：

- `target_session_id` 与来源 Session 可以相同，但跨 Session 是主要用途；
- `source_unit_id` 和 `source_message_id` 至少有一个非空；
- `order_in_context` 在同一目标 Session 内唯一、从 0 开始；
- `include_full_content=0` 表示标题/摘要/Concept，`1` 表示附带完整原文；
- 新 Session 的 KnowledgeUnit 归属于目标 Session，不修改来源单元。

### 3.11 LLMTask

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `id` | TEXT | 是 | 主键 |
| `type` | TEXT | 是 | `concept_extraction` / `origin_concepts` / `conversation` / `maintenance`；兼容或按需整理可使用 `segmentation` / `title` / `summary` |
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

### 4.1 Session/Message Concept 归属结果

主整理任务不要求把消息互斥地切成 KnowledgeUnit，而是返回 Concept、严格区分的关系和多目标归属：

```json
{
  "concepts": [{ "name": "Clos 网络", "summary": "多级无阻塞交换网络结构。", "aliases": [] }],
  "memberships": [
    { "target_type": "session", "target_id": "session-id", "concept_ids": ["concept-ref-1"] },
    { "target_type": "message", "target_id": "message-id", "concept_ids": ["concept-ref-1", "concept-ref-2"] }
  ],
  "relations": [{ "source": "concept-ref-1", "target": "concept-ref-2", "type": "hierarchy" }]
}
```

强制校验：

- `target_type` 只能是 `session`、`message` 或兼容的 `unit`，`target_id` 必须属于当前任务范围；
- 每个目标使用可为空的 `concept_ids` 数组，同一目标和 Concept 不能重复；
- 同一个 Session、Message 或 KnowledgeUnit 可以归属多个 Concept，不得压缩为单个“主主题”；
- 新 Concept 的名称、摘要和别名在同一结果中返回；引用现有 Concept 时 ID 必须来自当前目录；
- `hierarchy` 只表达严格的上位/下位关系并通过 DAG 校验；一般关联使用无向 `related`；
- `knowledge`、`discussion`、`procedure` 和 `mixed` 都保留原始消息；`mixed` 必须继续执行 Message 级识别，没有稳定知识的目标可以返回空数组。

长 Session 可以使用带重叠上下文的窗口分批提取候选。窗口必须携带全局 Message ID，最终在 Session 级完成去重、归一化、关系校验和归属合并；窗口边界是运行时机制，不得落库为 KnowledgeUnit 或被视为知识边界。

旧版分段结果仍按兼容规则校验：索引必须在输入范围内，不能重复，且 `units` 与 `unassigned_message_indices` 覆盖全部消息。校验失败不得应用部分结果；旧任务可完成、取消或转人工，但新主流程不依赖它。

### 4.2 Concept 结果

Concept 提取结果必须包含 `concepts` 数组；全部复用目录中已有 Concept 时该数组可以为空，但此时 `concept_ids` 或 `memberships[].concept_ids` 至少需要一项。结果可选返回多目标归属和关系建议。系统必须检查：

- 名称非空且不是泛词；
- 名称经过归一化后不冲突；
- 引用的已有 Concept ID 必须存在；
- 父子关系不能成环；
- `memberships[].target_type` 只能是 `session`、`message` 或 `unit`，每个目标的 `concept_ids` 必须是去重数组；
- Session、Message 和 KnowledgeUnit 的归属彼此独立，不能把 Session 归属隐式复制到所有消息；
- `hierarchy` 和 `related` 必须分别校验，`related` 不得参与根节点、祖先或深度计算；
- 不确定结果只能保存为 `proposed`，不能自动合并或删除。

### 4.3 维护建议

维护任务只允许返回建议变更，不允许返回“直接执行 SQL”或不可追溯的自由文本命令。每条建议需要包含类型、目标 ID、影响范围、理由和可逆操作描述。

### 4.4 Prompt Harness 与渐进式披露

- 每个生成的 Prompt 必须以前缀稳定、带版本号的 harness 开始；当前版本使用 `NEXUS_HARNESS_PROMPT`、`PROGRESSIVE_DISCLOSURE_PROTOCOL` 和 `PROMPT_VERSION=2026-08-v3-multi-concept`。任务规格和数据追加在固定前缀之后，续跑不得改写固定前缀；
- `DISCLOSURE_INDEX.roots[]` 每项必须包含 `{ refID, title, summary }`。`refID` 是本地实体的不透明标识；模型不得创造、改写或拼接；
- `DISCLOSURE_INDEX.expansions[]` 以已有 `refID` 为键，可包含下一层 `children[]`，以及明确披露的 `content`。`children` 仍是摘要目录，只有 `content` 可以表示知识单元或 Message 原文；
- 支持递归链路 `Concept → 子 Concept → KnowledgeUnit → Message 原文`。实现可以按实体类型分步披露，但任何层级都必须先出现在当前目录，才能成为下一次请求目标；
- 支持结构化的 `disclosure_requests?: Array<{ refID: string; depth: integer }>`。数组中 `refID` 不能为空或重复，必须存在于当前已列目录；`depth` 必须在 `[1, 64]`；
- 本地校验通过后才从事实表展开指定深度、保留根目录、替换 Prompt 的动态 `DISCLOSURE_INDEX` 并继续同一任务。引用不存在、越权、重复、深度非法、目录不可解析或超过 8 轮都不得应用部分业务结果；
- harness 明确允许模型使用自身知识、推理和调用方授权的外部搜索/工具，但输出必须区分输入证据、外部资料和推断；目录、摘要与原文一律按不可信数据处理。
- Concept 归属使用多对多数组：`memberships[]` 的每个目标必须包含 `concept_ids: string[]`，Session、Message 和 KnowledgeUnit 均可同时关联多个 Concept；单值 `concept_id` 不能作为归属字段。任务结果中的 `concept_ids` 和维护任务的 `unit_relink.concept_ids` 必须逐项检查是否重复、是否属于当前目录/候选范围。一个子 Concept 可拥有多个 `hierarchy` 父节点，`related` 不参与父子推导。

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

- `active` Concept 是候选节点，但默认只返回 hierarchy 根节点；根集合只依据可见的 hierarchy（`confirmed`，以及 `showProposed=true` 时的 `proposed`）计算，`related` 永远不影响根集合；
- hierarchy 是无限深度 DAG。`expandedConceptIds` 是用户明确展开的 Concept ID 集合；显式展开的后代会自动补齐祖先路径。父节点展开只使直接子节点可见，继续展开子节点才进入下一层；`expandedConceptDepth=0` 表示仅根节点，正值是可选的批量深度上限，不是模型层数上限；
- 收起一个 Concept 必须递归移除其后代的展开状态；后代事实仍在数据库中，重新展开即可恢复；
- 可见 Concept 集合是根节点加上沿“已展开父节点”可达的后代。对隐藏 Concept，计算其到最近可见 hierarchy 祖先的一个或多个代表节点；这组代表用于折叠投影；
- KnowledgeUnit 节点只在 `showUnits=true` 时生成；Message 节点只按 `showMessages` 或保留会话筛选生成，Concept 展开不能绕过这些开关；
- 节点 `label` 来自 `Concept.name`、`KnowledgeUnit.title` 或 Message 内容预览；Concept 节点可附带 `depth`、`parentId`/`parentIds`、`rootIds`、`hasChildren`、`expanded` 等派生元数据；
- 节点位置和视口是可丢弃的 `GraphLayout`，不是业务事实。

### 6.2 边

- 每个 Session 汇总其直接、消息级和 KnowledgeUnit 级 Concept 归属，再把隐藏 Concept 投影到最近可见代表节点并去重；任意一对可见代表 Concept 对该 Session 最多贡献 `1` 个共现权重。多个 KnowledgeUnit 或 Message 不会在同一 Session 内重复计数；多个 Session 投影到同一对节点时累加；
- Concept 与 Session、Message、KnowledgeUnit 之间生成关联边；SessionConcept/MessageConcept 是没有 KnowledgeUnit 时的主要证据边，UnitConcept 作为可选阅读片段边；端点使用同一套代表投影；
- `hierarchy` 只在父、子两端都可见时输出有向边。隐藏叶节点不能产生指向不可见节点的假边；
- `related` 始终按无向边处理。若端点折叠，可分别投影到最近可见代表并合并重复边；同一节点的自环丢弃。related 边不参与层级展开、根节点、深度或父子布局；
- 手动额外边单独保存，只有当前两个端点可见时才进入快照；
- `proposed` 关系默认不参与确认视图，`showProposed=true` 时按其原类型显示（hierarchy 仍有方向，related 仍无方向）；
- 消息与会话链边按同一 Session 的 `orderInSession` 排序生成，当前数据模型下网页端分支退化为链；
- 边权重、代表投影和节点度数均为派生值，不回写事实表。

### 6.3 缓存

- 缓存键至少包含 `graph_revision`、筛选条件、`showUnits`、`showMessages`、`showProposed`、`showRetainedSessions`、排序后的 `expandedConceptIds` 和规范化的 `expandedConceptDepth`；
- 导入、直接 Session/Message/Unit Concept 关联、按需 KnowledgeUnit 编辑、关系编辑、合并、删除和恢复成功后递增 `graph_revision`；旧分段任务应用也只在实际改变兼容单元投影时递增；
- 缓存失效不会影响业务数据；
- 自动图谱不允许出现无法从业务表重建的事实。

### 6.4 图谱编辑不变量

- 增加子节点或设置父级只新增 `hierarchy` 关系，并在提交前做成环校验；一个子节点可有多个父级；
- 删除单条父子引用只解除该引用，不删除子 Concept。子节点没有其他父级时自动成为根节点；“提升为根节点”是删除全部父引用的可撤销快捷操作；
- `related` 的两个端点可交换，存储列名不携带父子意义；
- 合并迁移别名、UnitConcept、父子/related 关系和笔记，清理自环/重复边并保留 `merged_into_id`；归档只改变默认投影状态。删除、归档、合并和关系编辑都必须可撤销，且不能删除 Session、Message 或 KnowledgeUnit。

## 7. 配置与导出

### 7.1 `config.yaml`

- 配置文件与 `nexus.db` 分离；
- API Key 明文可编辑，应用必须提示本机读取风险；
- 配置解析失败时保留原文件，使用上一次有效配置；
- 首次启动不预设 LLM 模式，用户选择 API 或 Prompt 粘贴后才可启动任务；
- `llm.token_budget` 由用户在设置页手动配置，必须是不小于 `1000` 的有限安全整数，不设置产品级最大值；它用于长 Session 分窗与新对话上下文校验，缺省或无效时才回退到 `8000`；
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
- Session/Message Concept 多归属的未知 ID、重复项、目标范围和关系类型；
- 旧版或按需分段索引的越界、重复、遗漏和全覆盖；
- Concept/别名归一化冲突；
- ConceptRelation 成环检测、无限深度、多父节点、related 无向语义和 proposed 状态；
- UnitConcept 去重、手动关联不被自动结果覆盖；
- NavTreeNode 父子 Session 一致、depth 计算和一对多单元关联；
- ContextReference 顺序和来源追溯；
- LLMTask revision 失效和状态迁移；
- Concept 合并/删除/恢复事务；
- 图谱根节点投影、逐层展开/递归收起、隐藏后代代表节点、每 Session 一次的共现聚合、related 不改变层级、派生缓存和 revision 失效；
- `DISCLOSURE_INDEX` 的根摘要、refID 递归展开、disclosure_requests 本地校验、非法请求拒绝和续跑上限；
- 导入重复判定、完整导出/导入和 schema 迁移回滚。

## 10. 直接 Concept 流程与兼容迁移

新导入的知识整理以 Session/Message 的直接多主题归属为主：先写入原始 Session/Message，再由 `concept_extraction` 或 `origin_concepts` 任务返回 `memberships[].concept_ids`，分别写入 `session_concepts` 和 `message_concepts`。这些关联不依赖 KnowledgeUnit，也不要求覆盖全部消息。

长会话可以被切成带重叠的运行时窗口以满足模型上下文限制。窗口必须携带原始 Message ID；窗口结果在 Session 级去重、归一化、DAG/related 校验后才可应用。窗口本身不是实体，不能写入 `knowledge_units`，不能改变 `Message.unit_id`，也不能形成新的知识边界。

KnowledgeUnit 仍是合法的可选实体，用于用户选择的一组消息的阅读整理或证据打包。它可以晚于 Concept 提取创建，也可以不存在；其 `UnitConcept` 关联是对直接 Session/Message 归属的补充，不是替代。删除或重做 KnowledgeUnit 只解除其自身关联，不得删除原始内容或直接归属。

旧 schema 和旧任务兼容规则：已有 KnowledgeUnit、`Message.unit_id`、`UnitConcept`、`NavTreeNodeUnit` 继续按原外键和校验规则读取；历史 `segmentation`、`title`、`summary` 任务可以恢复、完成、取消或标记 `stale`。旧分段结果不得自动覆盖手动归属，也不得阻塞新的直接 Concept 任务。导入迁移保留旧任务响应和原始 Prompt，任何无法安全转换的单一 `concept_id` 归属进入 `needs_review`，不能静默选择一个主题。
