# 实现补充记录

本文记录 `docs/design.md` 与 `docs/data-spec.md` 没有完全展开、但实现时必须固定下来的行为。它不是新的产品需求；后续实现和验收如有冲突，以设计文档和数据规范为准，并在这里追加变更原因。

## 运行边界

- 桌面运行时由 Tauri 2 Rust 壳层提供 `nexus.db`、`config.yaml`、原子写入和数据库备份命令；直接以 Vite/Chromium 开发时仍回退到 `localStorage`，只用于开发和浏览器验收。Chrome 扩展仍需独立打包，不属于 Tauri 壳层。
- sql.js 当前发布的是 UMD 入口而不是原生 ESM。浏览器开发运行依赖 Vite 对 `sql.js` 的依赖预构建来提供兼容的默认导出；因此不能把它加入 `optimizeDeps.exclude`，也不应直接以未包装的 `sql-wasm*.js` 文件作为 ESM 导入。
- 本地数据库和配置使用不同的存储键，完整知识库导出不包含配置或 API Key。恢复知识库会在一个 SQLite 事务中替换业务表，失败时由事务回滚，现有数据不被部分覆盖。
- 首次启动没有预置 LLM 模式。导入仍然先写入原始 Session/Message 并创建待处理任务；没有选择模式时任务不会自动请求网络。
- API 任务队列按配置并发数（1～4）批量执行，单任务最多进行三次请求（含超时、429 和 5xx 的指数退避）；Prompt 粘贴任务保持人工逐项应用。长 Session 按估算 token 预算切成带两条消息重叠的分块，只有所有分块通过全局索引校验并成功合并后才创建 KnowledgeUnit。

## 导入与时间

- 外部 JSON 的 `schema_version` 缺省时按兼容模式读取，显式版本目前只接受 `1`。消息角色严格限制为 `user`、`assistant`、`system`，不再把未知角色静默改成用户消息。
- 来源时间会尝试解析为 UTC ISO 8601；解析失败保存为 `NULL`，不会用应用当前时间伪造来源时间。Session 缺少或无效创建时间时才使用导入时刻作为本地创建时间。
- 缺少 `external_session_id` 时，以标题和消息内容指纹作为导入判定 ID。内容变化的重复导入先报告，不覆盖已有用户编辑；用户在提示条中选择更新、另存为新 Session 或跳过。

## LLM 任务

- 所有结构化任务都要求 JSON 对象。分段使用 `units` 与 `unassigned_message_indices`；标题、摘要分别使用 `{ "title": "..." }` 和 `{ "summary": "..." }`；Concept 使用 `{ "concepts": [{ "name": "...", "aliases": [] }] }`，同时兼容只返回字符串数组的结果。
- 分段结果通过完整覆盖、重复、越界和文本长度校验后才写入。应用分段会把旧的下游任务标为 `stale`，再按每个新 KnowledgeUnit 创建标题、摘要和 Concept 任务；起源 Concept 任务重用并更新为新的 Session revision。
- LLM 生成的标题/摘要写入时不增加 KnowledgeUnit revision；revision 增加只发生在用户手动编辑或消息边界改变时。这样同一单元的标题、摘要和 Concept 任务可以按同一输入 revision 顺序完成。用户手动编辑会使该单元尚未完成的下游任务变为 `stale`。
- API 模式采用 OpenAI-compatible Chat Completions：请求地址为 `baseUrl + /chat/completions`，只发送当前任务 Prompt，温度固定为 `0`。`local_only` Session 在 API 执行前被拒绝；Prompt 粘贴模式不发网络请求。
- 起源 Concept 没有独立的 Session-Concept 事实表。为让起源结果可见且能进入派生图谱，当前实现会把通过校验的起源 Concept 关联到该 Session 的所有 KnowledgeUnit；后续若增加 Session 级 Concept 表，应迁移这部分关联逻辑。

## 图谱与导出

- GraphNode/GraphEdge 继续作为派生视图。点击 Concept 时，当前选中的 Concept 会作为局部展开参数，即使全局关闭 KnowledgeUnit，也会显示它关联的单元。
- 手动图谱边保存在 `manual_graph_edges`，但当前界面只提供数据层 API，关系创建界面仍以 ConceptRelation 表单为主。图谱拖拽暂不写入 `graph_layout`，因此刷新页面会重新计算布局；“重置布局”按钮的语义是重新触发该计算。
- 完整知识库 JSON 使用 TypeScript 的 camelCase 实体字段（关系数组字段用下划线命名以区分表），导出带 `export_version=1`，恢复时严格校验所有业务数组并按外键依赖顺序写入。它与用于扩展导入的外部 JSON 是两个不同契约。

## 界面与演示数据

- 如果本地库为空，应用会加载一组可删除的 RDMA/ECN/PFC 演示数据，便于首次打开验证图谱和详情流程；一旦有真实 Session 就不会再次注入。
- 由于当前模板保留了紧凑的工作台布局，长列表暂未接入虚拟滚动；面向文档中的大规模数据目标时，需要把 Session、任务和消息列表改为分段或虚拟加载。
- 文字内容始终按纯文本展示，不执行消息中的脚本或指令。Markdown 的完整渲染和代码高亮属于后续表现层增强，不改变数据存储契约。
