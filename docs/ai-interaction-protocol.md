# Nexus 与 AI 交互协议

本文说明 Nexus 如何把本地事实交给 AI、如何接收结构化结果，以及何时继续
请求证据。该协议同时适用于 API 模式和 Prompt 粘贴模式，不依赖
`system`、`developer`、`user` 的消息分层。

## 一、一次任务的生命周期

1. 应用从本地数据库选择任务范围，生成带版本号的 Prompt，并把任务保存为
   `pending`。
2. API 模式把同一 Prompt 发送给兼容接口；Prompt 粘贴模式由用户复制到外部
   AI 页面后粘贴 JSON 响应。
3. 应用先解析 JSON，再按任务类型执行字段、ID、长度、层级和证据范围校验。
4. 如果响应包含 `disclosure_requests`，任务进入披露续轮，不应用任何业务变更。
5. 证据足够且校验通过后，应用在事务中写入派生结果；原始消息和证据正文不被
   覆盖。
6. 校验失败时任务进入 `needs_review`，应用生成有界 repair Prompt；用户或
   API 重试只能修复派生结构，不能改写事实正文。

## 二、Prompt 的四种 profile

| profile | 使用任务 | 携带内容 |
| --- | --- | --- |
| `minimal` | 会话分类、分段、标题、摘要 | 基础 JSON 输出和不可信输入规则 |
| `concept` | Concept 提取、起始主题提取 | `minimal` 加 Concept、层级和披露规则 |
| `conversation` | 对话与追问 | `concept` 加证据工具和工作记忆规则 |
| `maintenance` | 知识图谱维护 | `conversation` 加维护动作目录和审核边界 |

持久化任务恢复时根据任务类型重新选择 profile。这样旧任务不会因为历史
包装错误而携带整套维护协议。

## 三、证据与披露

Prompt 默认只发送摘要和有界 excerpt，不发送整个文件或整个会话。需要更多
内容时，AI 可以：

- API 模式调用 `nexus_search_evidence`、`nexus_read_evidence` 或
  `nexus_expand_ref`；
- Prompt 粘贴模式返回
  `disclosure_requests: [{"refID":"目录中的真实 ID","depth":1}]`。

每轮最多请求 4 个 `refID`，每个请求只展开一层。`children` 是导航引用，
不等于子项正文；只有 `content` 才能作为动作证据。`disclosed_ref_ids` 保存
已经披露过的引用，正文窗口按最新展开优先滚动，因此历史正文不会无限累加。

如果剩余引用与当前目标无关，维护任务可以返回 `coverage: "partial"`，但
`reason` 必须说明未覆盖范围；只有 `coverage: "complete"` 才能声称完成全图
审计。

## 四、不同 ID 字段的含义

| 字段 | 允许的 ID |
| --- | --- |
| `units[].concept_ids` | 仅允许 DISCLOSURE_INDEX 中已经出现的已有 Concept refID |
| 顶层 `memberships[].concept_ids` | 已有 Concept refID，或本响应 `concepts[]` 的 `client_ref`（如 `new:1`） |
| `relations.source/target` | 已有 Concept refID，或本响应 `client_ref` |
| `disclosure_requests[].refID` | 当前目录中已经列出的真实 refID |
| `disclosure_requests[].depth` | 整数；运行时实际按 1 处理 |

因此，`new:1` 出现在 `units[].concept_ids` 是错误，但出现在顶层
`memberships[].concept_ids` 是合法的。错误路径会带上 `units.N` 或
`memberships.N`，便于 repair Prompt 精确修改，而不是让 AI 猜测错误位置。

## 五、事实字段与派生字段

不可修改的事实包括原始 Session、Message、Evidence 内容和真实 ID。可以修复
的派生字段包括 Concept 名称、`client_ref` 映射、Concept 归属、hierarchy
关系以及 KnowledgeUnit 标题和摘要。修改派生字段后必须同步所有引用；不得
通过删除事实、截断 ID 或保留已知错误名称来“满足校验”。

## 六、宽严相济的校验

`confidence` 和 `reason` 只在名称看起来由“与/和/及/、/”等连接符拼接、但
AI 认为它仍是一个固定专名时才有解释义务。普通单一 Concept 即使序列化为
`confidence: 0`、`reason: ""`，也不会因为这两个可选字段而失败；如果确实
是复合固定名称，则必须提供 0 到 1 的 `confidence` 和非空 `reason`。

## 七、状态与安全边界

`pending` 表示等待执行，`running` 表示 API 请求进行中，`awaiting_disclosure`
表示等待下一轮证据，`needs_review` 表示需要人工修复，`success` 表示结果已
通过本地校验并写入。披露续轮永远不会部分应用 suggestions；维护动作先进入
待确认状态，用户确认后才改变关系或 Concept 状态。

