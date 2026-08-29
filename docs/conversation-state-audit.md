# Nexus 状态与接口审计

本文把任务队列、知识维护、对话分支和渐进披露放在同一份状态模型中。它是实现和验收的索引；具体字段约束仍以 `docs/data-spec.md`、Prompt 版本和本地校验器为准。

## 模块边界

| 模块 | 责任 | 不应承担的责任 |
|---|---|---|
| `services/task-state.ts` | 声明任务事件、合法来源状态和目标状态 | 写数据库、发请求、决定业务结果 |
| `services/prompts.ts` | 生成 Prompt、MCP 工具目录和披露目录格式 | 直接修改知识库 |
| `services/validation.ts` | 校验 JSON 结构、ID 白名单、标题/名称长度和 DAG 输入 | 猜测或修复越界 ID |
| `stores/workspace.ts` | 持久化任务转换、业务事实事务、队列租约和续轮；仅业务事实事务递增 `graph_revision` | 以 UI 状态代替数据库事实；任务轮询不得伪造图谱变更 |
| `App.vue` | 发送用户意图、显示任务和派生卡片状态 | 直接写任务状态或从数组长度推断成功 |
| `GraphCanvas.vue` | 绘制已投影的图谱、处理节点单击和布局事件 | 修改层级关系或推断隐藏节点 |

## 任务状态

```mermaid
stateDiagram-v2
  [*] --> pending: create / retry
  pending --> running: start
  running --> pending: continue_disclosure
  pending --> success: accept_validated_result
  running --> success: accept_validated_result
  needs_review --> success: accept_validated_result
  pending --> needs_review: reject_validation
  running --> needs_review: reject_validation
  needs_review --> needs_review: reject_validation
  running --> failed: fail_transport
  pending --> cancelled: cancel
  running --> cancelled: cancel
  needs_review --> cancelled: cancel
  pending --> stale: invalidate
  running --> stale: invalidate
  needs_review --> stale: invalidate
  failed --> pending: retry
  stale --> pending: retry
  cancelled --> pending: retry
```

`success` 是终态。`continue_disclosure` 必须同时保存本轮原始响应、下一轮 Prompt，清空 `parsed_result` 和校验错误，然后回到 `pending`。API 任务取得新的执行租约后再次进入 `running`；Prompt 粘贴任务等待用户复制新的 Prompt。任何仍有 `pending_ref_ids` 的维护任务都不能进入 success。

任务状态事件（start、retry、cancel、fail_transport、continue_disclosure）与图谱事实写入是两类事务：前者只更新 `llm_tasks`，不会递增 `graph_revision`；后者才使图谱投影缓存失效。这样队列轮询、重试和人工校验不会导致图谱闪烁。

维护结果还有两道独立的提交门禁：维护响应在 `suggestions=[]` 时无论 API 还是 Prompt 粘贴模式都必须带非空总体 `reason`（API 模式对所有响应都执行该要求）；最终动作的 Concept、关系、别名、Session、Message 和 KnowledgeUnit ID 必须来自当前 Prompt 中已经展开并带 `content` 的实体。根目录或 children 中只有标题/摘要的导航引用不构成写入授权，越界结果整体进入 `needs_review`，不应用部分建议。若模型省略 `disclosure_requests` 但目录仍有 `pending_ref_ids`，任务同样不能成功；修复 Prompt 会列出待展开 ID（超出前 64 项的部分仍以目录为准），便于批量补发续轮请求。中间轮的总体 `reason` 保存在原始响应中，但只有最终 `success` 才能显示“无建议变更”。

## 维护时序

```mermaid
sequenceDiagram
  participant User as 用户
  participant UI as 任务中心
  participant Store as workspace store
  participant Provider as API/网页端
  User->>UI: 全图维护
  UI->>Store: createMaintenanceTask()
  Store-->>UI: 根主题、未归属 Session/Unit 的披露目录
  UI->>Store: applyTaskResult(response)
  Store->>Store: validate scope + reason + disclosure
  alt pending_ref_ids 非空
    Store->>Store: continue_disclosure()
    alt API
      Store->>Provider: executeTask(nextPrompt)
    else Prompt 粘贴
      Store-->>UI: pending + 新 Prompt
    end
  else 完整审计结果
    Store->>Store: success（只保存 suggestions，不自动应用）
    UI-->>User: reason + 逐条确认/全部确认
  end
```

维护入口的关注主题只是排序提示，任务范围始终是整个 active 图谱。动作参数中的 Concept、Session、Message 和 Unit ID 必须来自已披露的 `content`；越界结果整体进入 `needs_review`，不执行部分写入。`unit_create.title` 统一限制为最多 30 个 Unicode 字符。

## 对话状态机

对话分支和 LLM 任务是两个有关联、但不能互相代替的状态机。新会话的根 `NavTreeNode` 可以在首问任务创建时先持久化；推荐词产生的后续临时节点只在回答通过校验后持久化。临时节点只存在于 `App.vue`，其 `taskId` 一旦写入就代表分支已经开始。

| 分支状态 | 事实依据 | 可见操作 | 合法后继状态 |
|---|---|---|---|
| `draft` | 临时节点没有 `taskId`，没有用户消息 | 修改预填问题、关闭分支、提交问题 | `pending` |
| `pending` | 已写入用户消息和 conversation task | 等待 API/粘贴 Prompt；禁止关闭和切换到其他分支 | `running`、`needs_review`、`failed`、`cancelled` |
| `running` | task 已取得执行租约 | 显示对应卡片的流式预览；禁止关闭和切换 | `success`、`needs_review`、`failed`、`cancelled`、`pending`（披露续轮） |
| `needs_review` | 响应已保存但本地校验失败 | 在原卡片/任务详情修正并重新提交；禁止关闭 | `pending`、`success`、`cancelled`、`stale` |
| `failed` | 传输或响应不可用，原始响应/错误已保存 | 重试；仍不可关闭，避免丢失用户已开始的分支 | `pending` |
| `success` | assistant、阅读片段、归属和导航节点已在同一事务提交 | 继续追问、切换分支 | 新的子分支 `draft` |
| `cancelled` / `stale` | 任务被取消或输入版本失效 | 重新排队；分支记录保留 | `pending` |

```mermaid
stateDiagram-v2
  [*] --> draft: 点击推荐词
  draft --> pending: 写入 user Message + task
  pending --> running: API 取得租约
  pending --> needs_review: 粘贴响应校验失败
  running --> pending: DISCLOSURE_INDEX 续轮
  running --> success: 校验通过并原子提交
  running --> needs_review: 校验失败，保留响应
  running --> failed: 传输失败，保留错误
  pending --> cancelled: 用户取消任务
  needs_review --> pending: 修正/重新排队
  failed --> pending: 重试
  stale --> pending: 重新生成 Prompt
  cancelled --> pending: 重新排队
  success --> [*]
```

核心不变量：

1. 同一 Session 同时最多一个 `pending`、`running` 或 `needs_review` 的 conversation task；创建追问必须先取得 Session 输入锁。
2. `taskId`、持久化 user Message 或 assistant Message 任意一个存在，都表示分支已经开始；只有 `draft` 可以关闭。页面的 `started` 字段不能覆盖这个事实。
3. 流式预览按 `taskId` 索引，并且只渲染在该任务所属的当前卡片；成功、失败和 `needs_review` 都不能把回答移到父卡片或清空。
4. 点击推荐词先创建独立临时卡片，提交时以其父节点创建独立 conversation task；回答成功后才把临时节点替换为持久 `NavTreeNode`。
5. 一个任务的 assistant Message 只允许由 `applyTaskResult` 写入一次；重复提交必须被终态任务拒绝。

## 对话时序

```mermaid
sequenceDiagram
  participant User as 用户
  participant UI as 对话卡片
  participant Store as workspace store
  participant Provider as API
  User->>UI: 点击黄色推荐词
  UI->>UI: 创建可关闭草稿分支并预填问题
  User->>UI: 提交问题
  UI->>Store: createFollowUpTask()
  Store->>Store: 取得 Session 输入锁
  Store->>Store: 原子写 user Message + task + assistant ID
  UI->>UI: 草稿分支锁定，不允许关闭/切换
  Store->>Provider: executeTask(task)
  Provider-->>UI: SSE 增量（按 taskId，留在所属卡片）
  Provider-->>Store: 最终 JSON
  alt 校验失败/传输失败
    Store-->>UI: needs_review/failed；保留原卡片预览和错误
  else 校验通过
    Store->>Store: 原子写 assistant、Unit、归属、NavTreeNode
    Store-->>UI: success；草稿分支变为持久分支
  end
```

提交前草稿可以关闭；只要 user Message 或 task 已创建，关闭入口必须消失或禁用。流式文本只属于对应 `taskId` 的卡片，校验失败时保留在该卡片供修复，不能落到父卡片或在最终刷新时消失。全屏查看按 Session 分页，同一个 Session 的所有消息必须在同一页。

## 队列顺序

导入先保存原始 Session/Message，再创建 `session_triage`。队列优先执行分类；只有 `knowledge` 才创建/执行 `origin_concepts`，`discussion` 和 `procedure` 取消遗留起始任务；`mixed` 可直接进行有证据的提取。不同 Session 可并行，同一 Session 任务按依赖顺序串行。
