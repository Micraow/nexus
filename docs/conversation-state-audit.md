# Conversation/task state audit

本审计依据 `/tmp/goal/prompt.txt`、`docs/design.md`、`docs/data-spec.md`、`src/services/prompts.ts`、`src/services/validation.ts`、`src/stores/workspace.ts` 和 `src/App.vue` 编写，记录当前实现和验证边界。

## 已验证

- 新对话和追问提交后都会清空输入草稿；离开会话或重新打开 composer 也会重置草稿。
- 新对话原子化写入 Session、根导航节点、用户 Message、conversation task，以及用户预选主题的 SessionConcept/MessageConcept 归属。追问写入已有 Session，并保留 `parentNodeId`、`taskId` 和源上下文引用。
- conversation 结果先校验 `answer`、可选 `units`、Session/Message 归属、Concept ID、标题/摘要和版本；成功后在同一事务中写入 assistant Message、导航树分支、可选 KnowledgeUnit、多主题归属、Session 标题/滚动摘要和准确计数。`units: []` 合法。
- `applyTaskResult()` 拒绝对 `success`、`cancelled`、`stale` 等终态任务重复应用；需要再次处理时必须先重新排队。任务详情仅对 `pending`、`running`、`needs_review` 显示“校验并应用”。
- API 任务只在明确执行或启动队列时发出请求；Prompt 粘贴任务保持待处理，需人工粘贴并应用结果。导入提示使用“创建待处理任务”，不暗示已经发起网络请求。
- 同一 Session 同时只允许一个未完成 conversation task；页面和 store 都拦截 `pending`、`running`、`needs_review` 状态下的重复追问。追问 Prompt 携带当前导航路径、Session 标题/摘要和最近历史消息。
- `[[nexus:existing:...]]` 与 `[[nexus:suggested:...]]` 标记由 Prompt 约定并由 Markdown renderer 渲染为蓝色/黄色下划线；已有主题点击打开详情，建议主题点击会把安全的探索问题填入当前会话输入，不会静默写入事实。
- 探索树节点点击会定位到带有 `data-conversation-message` 的回答；活动对话只有顶部“全屏”入口，主题消息列表只有顶部“全屏查看全部对话”入口，并支持跨 Session 分页。
- 导入主链只创建 `session_triage` 和 `origin_concepts`，不再创建 segmentation 或以分段为前置条件的 KnowledgeUnit。schema v7 会把历史活动 `segmentation` 任务统一标记为 `cancelled`，保留原 Prompt/响应供审计但不允许重新执行；title/summary 任务仍按兼容状态维护。
- 图谱使用 Session、Message、KnowledgeUnit 三类直接归属投影；SessionConcept 和 UnitConcept 在 `showUnits=false`、`showMessages=true` 时仍能落到消息边。归档 Session 的残留 join facts 不进入 active graph。主题详情和目录右栏通过共享证据解析器汇总 Session/Message/可选阅读片段，单个主题的全屏入口固定绑定主题并跨 Session 每页 20 条显示来源会话。

## 已明确的边界

1. **Session 级证据范围。** 直接 SessionConcept 按规范表示整段会话归属，因此主题详情会包含该 Session 的全部单元和消息。若产品希望改成单元级证据，需要另行定义新的归属语义，不能在展示层静默缩小范围。

2. **对话返回的新 Concept 的直接归属。** conversation 结果支持响应内唯一 `client_ref`；新主题必须通过顶层 `memberships` 至少归属本轮用户或 assistant Message，确有会话级证据时才归属 Session。`units[].concepts` 只补充可选阅读片段证据，不能替代直接消息证据。

3. **Suggested marker 的后续动作。** 黄色标记只触发预填的探索问题；用户提交后才创建 conversation task 和持久化事实，不会因渲染或点击自动创建主题。

4. **旧手工任务与会话状态绑定。** 同一 Session 的输入锁仍只允许一个未完成 conversation task；当前导航节点状态按用户 Message 的 `metadata.taskId` 和 assistant Message 的 `navNodeId` 精确解析。旧 `segmentation` 已不在活动任务集合中。

## Verification

自动化测试覆盖主题跨 Session 证据范围、消息分页、旧 segmentation 迁移/恢复及无摘要阅读片段状态。2026-08-28 已通过 115 项测试、主应用与扩展类型检查、主应用与扩展构建及 `git diff --check`。

隔离浏览器 fixture 已在 375×812、768×1024、1024×768、1440×900 四档视口完成渐进展开、递归收起、拖拽抑制、键盘操作、详情跳转、跨 Session 分页、建议主题预填和输入清空验收；无横向溢出、控制台错误或失败资源请求。`data/99-deepseek-export-2026-08-25.json` 只读解析为 99 个 Session、797 条 Message、1,433,985 个内容字符（按当前规则约 358,497 tokens）和 0 个导出错误，未导入业务数据库。
