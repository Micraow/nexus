# Conversation/task state audit

本审计依据 `/tmp/goal/prompt.txt`、`docs/design.md`、`docs/data-spec.md`、`src/services/prompts.ts`、`src/services/validation.ts`、`src/stores/workspace.ts` 和 `src/App.vue` 编写。以下“已验证”对应当前工作区在 `ed6f30c` 至 `3e6f9a9` 期间完成的实现；“剩余决策”是产品取舍，不代表已知回归。

## 已验证

- 新对话和追问提交后都会清空输入草稿；离开会话或重新打开 composer 也会重置草稿。
- 新对话原子化写入 Session、根导航节点、用户 Message、conversation task，以及用户预选主题的 SessionConcept/MessageConcept 归属。追问写入已有 Session，并保留 `parentNodeId`、`taskId` 和源上下文引用。
- conversation 结果先校验 `answer`、可选 `units`、Session/Message 归属、Concept ID、标题/摘要和版本；成功后在同一事务中写入 assistant Message、导航树分支、可选 KnowledgeUnit、多主题归属、Session 标题/滚动摘要和准确计数。`units: []` 合法。
- `applyTaskResult()` 拒绝对 `success`、`cancelled`、`stale` 等终态任务重复应用；需要再次处理时必须先重新排队。任务详情仅对 `pending`、`running`、`needs_review` 显示“校验并应用”。
- API 任务只在明确执行或启动队列时发出请求；Prompt 粘贴任务保持待处理，需人工粘贴并应用结果。导入提示使用“创建待处理任务”，不暗示已经发起网络请求。
- 同一 Session 同时只允许一个未完成 conversation task；页面和 store 都拦截 `pending`、`running`、`needs_review` 状态下的重复追问。追问 Prompt 携带当前导航路径、Session 标题/摘要和最近历史消息。
- `[[nexus:existing:...]]` 与 `[[nexus:suggested:...]]` 标记由 Prompt 约定并由 Markdown renderer 渲染为蓝色/黄色下划线；未知 suggested 标记不会静默写入事实。
- 探索树节点点击会定位到带有 `data-conversation-message` 的回答；活动对话只有顶部“全屏”入口，主题消息列表只有顶部“全屏查看全部对话”入口，并支持跨 Session 分页。
- 导入主链只创建 `session_triage` 和 `origin_concepts`，不再创建 segmentation 或以分段为前置条件的 KnowledgeUnit。schema v7 会把历史活动 `segmentation` 任务统一标记为 `cancelled`，保留原 Prompt/响应供审计但不允许重新执行；title/summary 任务仍按兼容状态维护。
- 图谱使用 Session、Message、KnowledgeUnit 三类直接归属投影；SessionConcept 和 UnitConcept 在 `showUnits=false`、`showMessages=true` 时仍能落到消息边。归档 Session 的残留 join facts 不进入 active graph。主题详情和目录右栏通过共享证据解析器汇总 Session/Message/可选阅读片段，单个主题的全屏入口固定绑定主题并跨 Session 每页 20 条显示来源会话。

## 非本轮范围的后续决策

1. **Session 级证据范围。** 直接 SessionConcept 按规范表示整段会话归属，因此主题详情会包含该 Session 的全部单元和消息。若产品希望改成单元级证据，需要另行定义新的归属语义，不能在展示层静默缩小范围。

2. **对话返回的新 Concept 的直接归属。** 当前新 Concept 通过 `units[].concepts` 创建并挂到可选 KnowledgeUnit；conversation 合同尚未允许用 `client_ref` 把它直接归属 assistant Message/Session。可选择扩展合同，或在回答后排队 direct extraction task，但都必须有显式证据，不能因黄色标记自动创建整段会话事实。

3. **Suggested marker 的后续动作。** 黄色标记目前是展示提示，不会自动创建候选 Concept。若需要审阅、确认或转为新对话，应增加明确的用户动作和持久化模型。

4. **旧手工任务与会话状态绑定。** 当前 UI 通过阻止未完成任务并优先选择未完成任务解决正常流程；如果要支持同一 Session 并存多个旧手工任务，应按用户 Message 的 `metadata.taskId` 严格绑定详情状态。旧 `segmentation` 已不在活动任务集合中。

## Verification

本分支新增证据测试覆盖主题跨 Session 证据范围、消息分页、旧 segmentation 迁移/恢复及无摘要阅读片段状态。合并前应运行完整 `pnpm test -- --run`、类型检查和构建。
