# 实现补充记录

本文记录 `docs/design.md` 与 `docs/data-spec.md` 没有完全展开、但实现时必须固定下来的行为。它不是新的产品需求；后续实现和验收如有冲突，以设计文档和数据规范为准，并在这里追加变更原因。

## 2026-08-28 图谱与主题页实现状态

- 图谱默认只投影没有未拒绝 hierarchy 父节点的 active 根主题。提议父关系默认不绘制但仍阻止子主题成为根；Concept 主体的一次单击同时打开右侧详情并切换当前分支；有子主题时显示下一层，叶主题只打开详情。Enter/Space 与单击相同，图谱不提供独立的 `+/-` 展开控件。
- 收起主题会递归清除后代的展开状态；隐藏后代通过 hierarchy 投影到最近可见祖先。`related` 永远不参与根节点、祖先路径、深度或展开；维护任务产生的待确认 hierarchy/related 只有在 `showProposed=true` 时绘制，普通 LLM 产生的 related 会被拒绝并改由共享证据派生，提议 hierarchy 仍参与结构父级判定。
- 共现边按 Session 去重：只要同一 Session 的两个不同 Concept 归属最终落到两个可见代表主题，该 Session 对这对主题贡献一次权重，不按消息或单元条数重复累计。多父后代投影到每条父链上第一个可见祖先，但单个多父 Concept 不会凭空产生根节点共现。`showUnits`/`showMessages`/保留会话筛选不会被主题展开绕过。
- Worker 返回前的图谱缓存只允许在筛选项、深度和展开集合兼容时复用；更深展开、不同开关或收起后的旧快照不会短暂泄露到当前视图。新增节点沿用已有位置并以确定性种子布局，避免拓扑变化时整图闪烁。
- 图谱显示选项默认收起，通过右下角按钮打开，避免在 1024/1440 宽度下遮住首屏根节点；375、768、1024、1440 四档视口均需保持画布非空且无横向溢出。
- 知识主题目录采用左侧 hierarchy 树、右侧完整详情列；未拒绝的待确认父子关系也保留在树结构中，并以状态标记提示。左侧目录不建立视口高度受限的嵌套滚动区，长树随页面主滚动容器自然延伸；工具栏仍保持页面滚动时的可见性。主题详情包含父/子/相关关系、来源与确认状态、关联 Session、可选 KnowledgeUnit、消息预览和一个顶部的跨 Session 分页全屏入口；点击父/子/相关主题后详情滚回顶部。旧的 LLM `related` 提议不进入关系审核区，避免把已由共享证据派生的信号误当成待确认动作。主题目录不再额外弹出全局 Concept 抽屉。
- “待确认”关系可能来自历史导入、整理结果或维护任务，并不表示打开主题时一定存在 API 请求；主题详情读取本地事实，不会隐式创建任务。KnowledgeUnit 继续作为可选的证据包和上下文来源，不是 Concept 提取或图谱展示的前置条件。
- 知识维护任务始终扫描整个 active Concept 图谱；从主题、会话或阅读片段入口触发时，这些对象只作为 Prompt 中的附加关注范围。Prompt 提供全部一级主题及直接子主题引用，并明确根节点是例外、新主题优先匹配最窄父主题、related 不能代替 hierarchy。`MAINTENANCE_ACTION_API` 同时作为 Prompt 和应用校验的机器可读工具目录，使用 MCP 标准 `inputSchema`（并保留 `input_schema` 兼容字段，均为 `additionalProperties=false`），另由 `listMaintenanceMcpTools()` 暴露纯 `{name, description, inputSchema}` `tools/list` 视图；动作覆盖 Concept CRUD、别名、关系增删改与审核、多父层级整体替换/解除、归属迁移和阅读片段修订。创建 Concept 可在同一动作中提交别名与多父级；应用前做 DAG、字段白名单、重复别名和长度检测，并通过快照事务记录，可撤销，未知动作/字段不落库。
- 当前规模和已有 D3 力向布局、拖拽、键盘/ARIA、高亮及位置持久化已覆盖验收目标；在缺少性能基准和交互回归证据前不迁移 Sigma.js。若未来迁移，必须先以同一 fixture 对比初始布局稳定性、拖拽阈值、框选、无障碍和大图谱帧耗时。

## 运行边界

- 桌面运行时由 Tauri 2 Rust 壳层提供 `nexus.db`、`config.yaml`、原子写入和数据库备份命令；直接以 Vite/Chromium 开发时仍回退到 `localStorage`，只用于开发和浏览器验收。Chrome 扩展仍需独立打包，不属于 Tauri 壳层。
- 网络请求统一走 `services/http.ts`：Tauri 环境切换到 `tauri-plugin-http` 的 fetch 以绕过 webview CORS，浏览器环境回落原生 fetch。插件权限作用域放开了 `https://**` 与 `http://**`，因为 Provider 端点由用户任意配置；真正的出站请求仍只发生在用户显式启动 API 任务时。
- sql.js 当前发布的是 UMD 入口而不是原生 ESM。浏览器开发运行依赖 Vite 对 `sql.js` 的依赖预构建来提供兼容的默认导出；因此不能把它加入 `optimizeDeps.exclude`，也不应直接以未包装的 `sql-wasm*.js` 文件作为 ESM 导入。
- 本地数据库和配置使用不同的存储键，完整知识库导出不包含配置或 API Key。恢复知识库会在一个 SQLite 事务中替换业务表，失败时由事务回滚，现有数据不被部分覆盖。
- 导出落盘统一走 `services/files.ts`：Tauri 环境调用 `tauri-plugin-dialog` 的系统保存对话框，再用 `tauri-plugin-fs` 写入用户选择的位置（capabilities 中 `fs:allow-write-text-file` 作用域为 `**`，因为保存路径完全由用户在对话框中决定）；浏览器开发环境回退为 Blob 下载。用户取消对话框时不提示成功。
- 启动时执行 `PRAGMA integrity_check`，结果按查询返回的第一列取值（列名在不同 SQLite 构建下可能是 `integrity_check` 或其他形式，不能按固定列名读取）。校验失败时中止初始化并抛出错误，避免把损坏数据当作空库继续写入。
- 首次启动没有预置 LLM 模式。导入仍然先写入原始 Session/Message 并创建待处理任务；没有选择模式时任务不会自动请求网络。

## 数据库位置与配置

- 设置页可自定义数据库位置：应用路径前会先自动创建一次备份（原文件名 + `.bak-<时间戳>`），确认后写入配置并热切换数据库连接（reopen + 全量刷新界面状态），无需重启。相对路径会解析到应用数据目录下；留空恢复默认位置。
- 配置文件解析失败时不覆盖用户文件：界面顶部展示常驻警告横幅，沿用上一次有效配置继续运行，直到用户修复 YAML。
- Provider 由界面自动生成 id（名称转 slug，冲突时追加 `-2`、`-3` 序号），表单不暴露 id 编辑。列表中每条连接可用单选设为默认；API Key 按用户选择明文写入本机 `config.yaml`，界面文案明确说明该风险及“备份和导出永远不包含 API Key”的边界。

## 导入与时间

- 外部 JSON 的 `schema_version` 缺省时按兼容模式读取，显式版本目前只接受 `1`。消息角色严格限制为 `user`、`assistant`、`system`，不再把未知角色静默改成用户消息。
- 来源时间会尝试解析为 UTC ISO 8601；解析失败保存为 `NULL`，不会用应用当前时间伪造来源时间。Session 缺少或无效创建时间时才使用导入时刻作为本地创建时间。
- 缺少 `external_session_id` 时，以标题和消息内容指纹作为导入判定 ID。内容变化的重复导入先报告，不覆盖已有用户编辑；用户在提示条中选择更新、另存为新 Session 或跳过。

## LLM 任务

- 所有结构化任务都要求 JSON 对象。主 Concept 任务直接使用 `{ "concepts": [{ "name": "...", "summary": "...", "aliases": [] }], "concept_ids": [], "memberships": [], "relations": [] }`；每个 `memberships` 目标的 `concept_ids` 都是可为空的多选数组，目标可以是 `session`、`message` 或兼容的 `unit`。标题/摘要任务和维护任务仍可使用 `{ "title": "..." }`、`{ "summary": "..." }` 与 `unit_relink.concept_ids`。旧结果若仍使用单个归属 `concept_id`，进入人工修复而不自动压缩为一个主题。
- 新导入默认不创建 `segmentation` 任务。长 Session 可以在运行时用带重叠窗口的输入分批处理，但窗口必须携带全局 Message ID，最终在 Session 级完成去重、归一化、关系校验和多归属合并；窗口边界不落库为 KnowledgeUnit。
- `segmentation`、标题和摘要任务仍作为旧数据库/按需阅读片段的兼容记录保留。旧分段结果通过完整覆盖、重复、越界和文本长度校验后才可人工审阅；活动状态的旧 `segmentation` 任务在 schema v7 统一转为 `cancelled`，不能重试或执行，也不再产生新的单元投影。按需阅读片段只影响对应 KnowledgeUnit、Message.unit_id 和 UnitConcept 下游，不得清除或阻塞 SessionConcept/MessageConcept。
- LLM 生成的 Concept 名称、摘要和别名优先在同一结果中写入；可选 KnowledgeUnit 的标题/摘要写入时不增加其 revision。用户创建或编辑 KnowledgeUnit 只使该单元尚未完成的下游任务变为 `stale`，不使直接 Session/Message 归属失效。
- API 任务队列按配置并发数（1～4）批量执行，单任务最多进行三次请求（含超时、429 和 5xx 的指数退避）。同一 Session 的直接 Concept 任务按输入 revision 串行，避免旧结果覆盖新归属；可选 KnowledgeUnit 元数据任务只在对应单元创建后串行。Prompt 粘贴任务保持人工逐项应用。并发数已在设置页提供选择器（1～4），写回 `config.yaml`；同一 Session 的 revision 规则不受并发数影响。
- Token 预算不是固定的 `8000`：设置页允许输入任意不小于 `1000` 的有限安全整数并立即持久化为 `llm.token_budget`，不施加产品级最大值。配置读取、界面提交和写回使用同一归一化函数；该值供长 Session 分窗与新对话上下文超限检查共同使用，已创建的任务不会因之后修改预算而重写。
- 长 Session 按估算 token 预算切成带两条消息重叠的运行时窗口；合并多个窗口结果时按全局 Message ID、Concept 规范名、归属目标和关系类型去重，并校验未知 ID、关系成环与 related/hierarchy 语义冲突，任何冲突都整体判失败，不写入部分结果。窗口不创建 KnowledgeUnit。
- API 模式采用 OpenAI-compatible Chat Completions：请求地址为 `baseUrl + /chat/completions`，只发送当前任务 Prompt，温度固定为 `0`。`local_only` Session 在 API 执行前被拒绝；Prompt 粘贴模式不发网络请求。
- 对话 Prompt 携带当前 Session 标题/摘要、导航路径和最近历史消息，并允许返回 `session_title`（≤60 字）和 `session_summary`（≤120 字）。完成结果在同一事务中写入 assistant Message、Session 滚动摘要、可选 KnowledgeUnit 和导航节点；仅应用内占位标题会自动改名，导入或用户编辑过的标题保持不变。旧结果省略字段时保留已有值，空摘要以回答文本作有限回退。
- 所有任务 Prompt 先经过 `ensureHarnessPrompt`，固定拼接版本化的 `NEXUS_HARNESS_PROMPT` 与 `PROGRESSIVE_DISCLOSURE_PROTOCOL`；动态任务规格放在固定前缀之后。Harness 允许模型使用自身知识和调用方授权的搜索/工具，但要求区分输入证据、外部资料和推断，并把消息、摘要、目录都当作不可信数据。
- 对话 Prompt 约定已有主题使用 `[[nexus:existing:主题名称]]回答中实际出现的词组[[/nexus]]`、建议探索主题使用 `[[nexus:suggested:主题名称]]回答中实际出现的词组[[/nexus]]`；模型先按思维导图梳理答案，再对每个稳定、独立概念的首次真实出现分别标记。推荐词采用教材章节大标题/小标题粒度，短而有辨识度；没有固定总数量上限，但不得把多个概念合并为一个 marker，也不得使用“原文”等占位文字。Markdown 渲染器移除标记并以蓝/黄色下划线呈现，旧响应中的占位正文回退显示 marker 主题名。
- 大型知识上下文通过 `DISCLOSURE_INDEX` 传递：根引用只包含 `title`、`summary` 和不透明 `refID`，展开记录才提供下一层 children 或消息原文。模型可返回 `disclosure_requests: [{ refID, depth }]`；应用先校验 ID 已在当前目录、无重复且深度为 1～64，再从本地 hierarchy、KnowledgeUnit 和 Message 递归生成下一轮 Prompt。API 模式自动续跑，最多 8 轮；Prompt 粘贴模式把同一任务恢复为 pending，等待用户执行更新后的 Prompt。非法请求或超过轮数进入 `needs_review`，不会应用部分结果。
- 起源 Concept 结果写入独立的 `session_concepts` 多对多事实表；它不会复制到该 Session 的全部 KnowledgeUnit。图谱派生时会把 Session、Message 和 KnowledgeUnit 三种归属投影到可见主题，并按 Session（而不是单元数量）累计 Concept 共现权重。
- 新对话与起源 Concept 任务共用层级约束：优先选择最窄的已有或同批次父主题，仅在没有可解释父级时保留根节点。普通 LLM 结果只能返回 `hierarchy` 并以 `proposed` 写入；`related` 由软件按共享 Session/Message 派生，只有维护动作 API 可写持久化 related。端点必须来自当前披露目录或响应内 `client_ref`；落库会去重、检测环，并保留已有 `confirmed` 关系。
- 会话内追问（从导航树节点或会话详情发起）：用户消息以 `metadata = { mode: 'follow_up', parentNodeId, taskId }` 落库，回答分支节点挂在该节点之下（depth + 1），assistant Message 额外记录 `navNodeId` 供探索树点击定位正文。结果落库后从 Message 和 KnowledgeUnit 实际行数重算 `message_count` / `unit_count`，每个 Session 同时只允许一个 `pending` / `running` / `needs_review` 对话任务；任务完成后才可创建下一轮。早期没有 `metadata.taskId` 的对话任务按 legacy 规则回落到根节点。
- 新对话或追问如果预选了现有知识主题，创建任务时立即写入该 Session 和首条用户 Message 的 `session_concepts` / `message_concepts`（source=`manual`）；这不等待 API 或 Prompt 粘贴结果，回答完成后仍按返回的单元和多目标归属继续补充事实。
- 任务中心在队列启动前显示待处理任务数、覆盖的 Session 数和预计调用次数（按待处理 API 任务数估算，失败重试最多 ×3 不计入）；Session 数取 `inputRevision` 首段去重，`maintenance:` 前缀不计入。

## 图谱

- 图谱共现计算运行在 Web Worker（`workers/graph.worker.ts`）中；主线程只做缓存命中与布局回填。缓存键包含 `graph_revision`、Session/Message/KnowledgeUnit/待确认/保留会话开关、`expandedConceptDepth` 和排序后的 `expandedConceptIds`，任一输入变化即重新计算，计算期间先返回最近一次快照（stale-while-revalidate 式），完成后增量刷新。Worker 不可用时退回主线程同步计算。
- Worker 通信的数据必须先深拷贝为纯 JSON（`toPlainJson`）：Pinia 的响应式代理无法结构化克隆，直接 `postMessage` 会抛 `DataCloneError` 并中断图谱视图渲染。新增图谱输入字段时必须保持可 JSON 序列化。
- GraphNode/GraphEdge 继续作为派生视图。`resolveVisibleConceptIds` 默认只返回没有未拒绝 hierarchy 父节点的 active 根节点；Concept 主体单击、Enter 或 Space 把节点加入/移出 `expandedConceptIds`，逐层显示直接子节点，叶节点单击只打开详情。`normalizeExpandedConceptIds` 会补齐显式后代的祖先路径；`toggleConceptExpansion` 在收起父节点时递归清除后代。hierarchy 不限制深度且允许多父节点；`related` 始终无向，完全不参与根节点、祖先、深度或展开判断。`showProposed=false` 时 proposed hierarchy/related 均被排除绘制，但 proposed hierarchy 仍参与结构父级判定。
- Concept 的直接证据同时来自 SessionConcept、MessageConcept 和 UnitConcept。没有 KnowledgeUnit 的消息仍可生成图谱关联；KnowledgeUnit 只作为可选阅读片段投影。窗口化处理保留全局 Message ID，不把窗口边界写入图谱。
- 主题详情的关联会话、消息和单元统一从三类直接归属事实推导；因此只有 MessageConcept 或 UnitConcept、没有直接 SessionConcept 的历史数据也能显示关联会话。
- Store 传给图谱服务的 Session 集合只包含未归档 Session；当调用方提供该集合时，残留的 `session_concepts` 不得为已归档 Session 生成共现边。独立调用 `buildGraph` 未提供 Session 集合时，仍按调用方显式传入的事实计算。
- 折叠主题通过 hierarchy 投影到最近可见祖先。每个 KnowledgeUnit 先对可见代表节点去重，再对每个代表节点对贡献一次共现权重；因此隐藏叶节点仍能为根视图提供聚合关系，同时不会因多条叶子路径重复计数。hierarchy 只绘制当前两端都可见的事实边；related 的隐藏端点也可投影到可见祖先，但只形成无向弱关系。
- 图谱中的 Concept 节点主体点击同时打开详情并改变层级投影；叶节点只打开详情，Enter/Space 与单击一致，图谱不提供独立 `+/-` 展开控件。全局 `showUnits` 才显示单元，`showMessages` 或保留会话筛选才显示消息；这些开关不会被 Concept 展开绕过，并按 Session 的 `orderInSession` 连接成链。
- 对话结果只允许返回有直接证据的 `hierarchy` 关系；应用以 `proposed` 写入并复用统一确认、拒绝与环检测流程。`related` 不接受普通 LLM 断言，由软件从共享 Session/Message 事实派生；只有知识维护动作 API 能显式编辑持久化 `related`。
- 图谱布局持久化：节点拖拽结束写入 `graph_layout`（固定坐标），视口平移/缩放防抖后写入单行 `graph_viewport` 表；刷新后恢复。“重置布局”清除这两类记录并重新计算。快照变化触发的重渲染以 d3 的实时变换恢复视口，持久化视口只在组件挂载时应用；store 保存/重置视口时会同步内存值，避免过期的 prop 把缩放拉回旧状态，“重置布局”通过递增组件 key 整体重建实现。
- 图谱支持框选多选：空白画布上 Shift+左键拖出选框（该手势已从 d3.zoom 的默认事件过滤中排除，不与平移冲突），松开后把框内知识单元节点逐一加入跨会话上下文选择；选框坐标经当前缩放变换的逆变换映射回布局坐标再判定命中。
- 手动图谱边保存在 `manual_graph_edges`，但当前界面只提供数据层 API，关系创建界面仍以 ConceptRelation 表单为主。
- 层级维护使用 workspace store 的 `setConceptParent`、`addConceptChild`、`removeConceptFromParent` 和 `promoteConcept`：前两者写入 hierarchy 前做成环检查，移除一条父引用不会删除子主题；没有其他父引用时子主题自然回到根集合，`promoteConcept` 一次移除全部父引用。`related` 关系两端按无向集合处理。
- 图谱主题抽屉中的子主题行显示标题和摘要。行尾只提供向上箭头：它解除当前父子引用，并把子主题接到当前主题的父级，从而提升到当前主题同级；不会删除子主题，也不再并列提供语义不同的垃圾桶按钮。添加子主题使用加号入口和实时搜索候选，无匹配时可直接创建。
- 完整知识库 JSON 使用 TypeScript 的 camelCase 实体字段（关系数组字段用下划线命名以区分表），导出带 `export_version=1`，恢复时严格校验所有业务数组并按外键依赖顺序写入。它与用于扩展导入的外部 JSON 是两个不同契约。

## 消息渲染安全模型

- 消息与回答详情使用受限 Markdown 渲染（`services/markdown.ts`）：先对原文转义 HTML 特殊字符，再生成块级结构（标题、列表、引用、分隔线、段落）与行内结构（粗体、斜体、行内代码、链接、fenced 代码块）。主题 marker 的正文必须是回答中实际出现的词组；旧响应中的 `原文` 等占位正文会回退显示 marker 主题名。未闭合的 marker 起始符只作为该主题的单独标记，不得吞掉后续正文或其他 marker；孤立结束符仅作为展示语法移除。
- 链接只接受 `http(s)` 协议，`javascript:` 等一律按纯文本处理；行内代码内的文本不再做链接或概念识别。
- 知识主题提及渲染为可点击胶囊：把当前主题名（含别名，长名优先）拼成交替正则做一次性替换，用无命名捕获组（兼容旧 WebKitGTK 的正则能力）并按匹配文本查表回填主题 id，因此主题名中的正则特殊字符不会破坏匹配。
- 渲染结果通过 `v-html` 注入前已完成转义，消息原文永远不作为 HTML 解释；事件代理只响应带数据属性的主题胶囊点击。

## 主动探索界面

- `Concept` 在用户界面中显示为“知识主题”。这是中文产品文案的显示层选择：它比“概念”更能表达跨会话复用的稳定知识主体；数据库字段、TypeScript 类型和 Prompt 契约仍使用 `Concept`，以保持设计文档的数据契约不变。
- 界面文案不暴露开发术语：面向用户使用“会话 / 阅读片段 / 知识主题 / 任务”等词，`KnowledgeUnit` 作为可选证据包保留在数据层；`Session`、`Concept`、`schema` 等只出现在数据层与文档。
- 从知识主题详情或上下文面板发起对话时，总是打开独立的 composer。快捷短语先渲染 `$(topic)` / `$(context)`，用户仍可编辑生成的问题；创建后落库新的 Session、导航根节点、用户首条消息和待处理 conversation 任务，不在界面中直接发送网络请求。预选主题同时写入 Session/Message 直接归属。
- 导航树使用 `NavTreeNode` 的父子关系递归渲染；根调用传入完整 Session 节点集合，圆点为主要可点击区域，细线表达父子关系，标签通过悬停/聚焦提示显示；会话导航隐藏每个节点的重复追问动作，只保留单击圆点切换分支。
- 会话工作区按当前导航节点投影消息：切换主题只切换到另一条分支，不把新问题线性追加到旧分支尾部。中心渲染当前节点及其祖先路径上的实体问答卡片；只有最前面的当前卡片可交互，祖先卡片保留真实标题和消息 DOM 作为不可交互的叠放背景，层数与导航深度一致。卡片使用 `TransitionGroup`、稳定尺寸和 `transform` 做可中断的切换动画，在 `prefers-reduced-motion: reduce` 下关闭位移/旋转。Session 仍保留完整 Message 顺序供检索和导出，分支视图只是显示投影。
- 上下文排序在界面状态中保持为用户拖拽顺序，创建 conversation 任务时按该顺序写入 `ContextReference.order_in_context`。输入 token 以字符数除以 4 估算；超过配置预算时只提示并禁止创建任务，不静默截断。
- 长列表使用分段加载而非虚拟滚动：会话每页 40、知识主题每页 60、历史任务每页 30；主题的“包含消息”全屏查看器跨 Session 固定每页 20 条，并在每条消息头部标记来源会话，使用上一页/下一页翻页。该阈值是界面常量，后续接入虚拟滚动时可整体替换。
- 知识主题详情的关联单元列表支持三种排序：最近更新、创建时间、名称（中文 `Intl.Collator('zh-Hans-CN')` 排序）；父/子/相关主题行按对方主题关联的单元数量降序排列，常用主体靠前。
- 首次启动不注入演示数据。空库直接显示导入引导，避免把示例内容误认为用户自己的知识。
- 新对话主页直接提供问题输入、知识主题、快捷短语和上下文入口；创建动作复用同一 composer，仍只创建本地任务，不在点击时隐式发出网络请求。原有导入、最近会话和图谱入口降为辅助区域，确保首次打开应用即可开始提问。首页和普通工作页使用更宽的内容列，空列表也用占满面板的空状态承接主要空间。
- 侧边栏收起时保留固定网格尺寸，品牌文字、导航文字、badge 使用 `display: none`，底部状态使用 `visibility: hidden`；这样不会因 v-if 销毁导航节点造成按钮横向重排，窄窗口自动收起也使用同一网格规则。底部状态只展示本地保存提示和简短路径摘要。
- 图谱首次布局只在力向模拟结束或首帧有效时执行一次 bounds fit，不在每个 tick 调用 `zoom.transform`；首次快照为空时保留“尚未 fit”状态，异步节点回来后再适配一次。用户开始缩放或平移后保留实时变换，不再被快照重绘覆盖。

## Chrome 扩展（DeepSeek 导出器）

- MV3 结构：`bridge.js` 注入 MAIN world（`document_start`，要求 Chrome 111+）包装 `fetch`/`XHR`，只捕获当前页面同源且看起来是 JSON 的响应，再通过 `CustomEvent('nexus:captured-json')` 转发给隔离世界；`content.js` 在隔离世界深搜响应对象树（递归查找含 `role` + `content` 的数组）并按会话 id 缓存。页面结构变化时自动降级为 DOM 提取（`.ds-markdown` 交替块），两类来源都失败才计入错误。
- `session` 侧边栏列表采用增量滚动：每次移动约 0.8 个可视高度并等待懒加载，连续两次在滚动底部没有新节点后才判定结束，避免一次跳到底部导致虚拟列表只发现首批会话。导出等待同时确认当前路由已切换，不能只因为旧页面仍有 `.ds-markdown` 就提前成功。
- 扩展下载使用 `chrome.downloads` 的 data URL，并允许只包含失败项的结果文件；部分成功时成功会话和 `errors` 一并导出。这样不会依赖工作台页面的 Blob 点击行为，也不会因为一个失败项阻止保留诊断结果。
- DeepSeek 适配器明确记录三类前端耦合：`/a/chat/s/<id>` 路由、同源 JSON 响应和 `.ds-markdown` DOM 回退。网络层优先、DOM 层兜底；页面改版时应根据工作台错误提示提交最小复现信息，不上传会话内容。

## 桌面打包（Tauri）

- Linux Tauri 壳层在创建窗口前为未显式设置的进程变量注入 `GTK_IM_MODULE=fcitx`、`QT_IM_MODULE=fcitx` 和 `XMODIFIERS=@im=fcitx`，兼容 Arch Linux + KDE + Wayland + fcitx5；用户已设置其他输入法变量时保持原值。
- 打包配置在 `src-tauri/tauri.conf.json`：`bundle.active` 已开启，Linux 产物为 deb / rpm / AppImage，输出到 `src-tauri/target/release/bundle/<目标>/`。图标由 `pnpm tauri icon <1024px 源图>` 从 `icons/icon.svg` 生成整套尺寸。
- 生产 CSP 的 `script-src` 必须包含 `'wasm-unsafe-eval'`，否则 sql.js 的 WASM 在 WebView2（Windows）中无法实例化；`connect-src` 放行 `https:` 供用户自配的 Provider 端点使用，并包含 Tauri v2 的 IPC 源（`ipc:` 与 `http://ipc.localhost`）。
- AppImage 打包需要运行 linuxdeploy 工具链。宿主机只有 fuse3（缺 fuse2）时，linuxdeploy AppImage 无法直接执行，需加环境变量 `APPIMAGE_EXTRACT_AND_RUN=1` 让其自解压运行；deb 与 rpm 由 Tauri 纯 Rust 实现，无需系统 dpkg/rpm 工具。
- 版本号需要同步三处：`tauri.conf.json` 的 `version`、`Cargo.toml` 的 `version`、（如发布扩展）`extension/manifest.json`。业务前端版本不单独维护。

## 验收覆盖说明（对应设计 15.1）

- 单元测试（Vitest，163 项）覆盖 Markdown 渲染与注入防护、分块切分与合并校验、图谱关系/渐进披露、中文搜索回退与排序、扩展会话发现与导出 payload、主题证据分页、任务迁移和直接对话写入。数据库耦合路径依赖 sql.js WASM；当前测试已覆盖直接导入、旧 segmentation 归一化、对话结果应用和 API 任务并发护栏，仍不替代真实桌面环境的备份恢复验收。
- 数据库耦合路径通过 headless Chromium + CDP 冒烟脚本人工验收：空态加载、图谱渲染、帮助弹窗、Provider 保存、导入 JSON → 任务中心 → Prompt 粘贴应用 Session/Message Concept 归属（旧数据另验阅读片段兼容与废弃分段任务归档）→ 图谱出现主题与直接证据节点 → 主题目录右栏跨 Session 消息分页 → 会话列表核对，全程断言无运行时异常。该脚本为临时验收工具，不随应用分发。

## 直接 Concept 流程迁移约定

- 新导入的主链是 `Session triage → Session/Message Concept 提取 → Session 级归一化与关系校验 → 图谱派生`。它不等待 `segmentation`、KnowledgeUnit 标题或摘要。
- 长会话的重叠窗口只服务于请求大小和上下文管理。窗口携带全局 Message ID，窗口合并后才写入 SessionConcept/MessageConcept；禁止把窗口边界当作持久化 KnowledgeUnit。
- `mixed`、`discussion` 和 `procedure` 仍然进入直接 Concept 提取。形态判断只影响默认筛选和展示，不影响原始内容保留、搜索、上下文选择或知识识别。
- KnowledgeUnit 是可选阅读片段/证据包。创建、编辑和删除只影响它自己的 Message.unit_id、UnitConcept、标题和摘要；不应删除原始 Message，也不应覆盖直接 SessionConcept/MessageConcept。
- 旧 schema 中的 KnowledgeUnit、`Message.unit_id`、`NavTreeNodeUnit` 和 `segmentation`/标题/摘要任务必须继续可读、可导出和可人工维护。迁移会把活动状态的旧 `segmentation` 任务统一标记为 `cancelled`，保留审计字段但不再允许重试或执行；不能用旧分段结果重写新的直接归属。

## 当前概念层次与状态机（2026-08）

- 事实层次：`Session` 是完整对话容器，`Message` 是不可丢失的原始消息，`Concept` 是跨 Session 复用的知识主题。`KnowledgeUnit` 保留为同一 Session 内可选的阅读片段/证据包，不是主题层级、不是分段前置条件，也不参与根主题判断。
- 导入链：原始 `Session/Message` 先写入 → 创建 `session_triage` 与 `origin_concepts` 任务 → 任务经历 `pending → running → success`，异常进入 `needs_review/failed`，输入版本变化进入 `stale`；直接主题结果写入 `SessionConcept/MessageConcept`，不等待 KnowledgeUnit。
- 对话链：本地草稿 → 创建 `conversation` 任务（API 为 `pending → running`，Prompt 粘贴保持 `pending` 等待人工回传）→ 校验结果 → `success` 写入 assistant Message、导航树节点和多主题归属；`units` 可以为空或包含多个本轮可选阅读片段。非法结果进入 `needs_review`，重试或版本变化分别回到 `pending` 或 `stale`。没有摘要的已应用片段仍为 `ready`，不再伪装成等待分段。
- 关系链：普通 Concept/对话任务只能产生 `hierarchy` `proposed`，由用户确认变为 `confirmed` 或拒绝变为 `rejected`；`related` 默认由软件从共享 Session/Message 事实派生，维护任务才可通过动作 API 显式添加、修改或删除持久化 related。只有 `confirmed` 默认参与图谱绘制；未拒绝的 hierarchy proposal 仍参与根节点结构判定，`showProposed` 打开时才显示建议关系。
- 展示层：图谱从事实层实时派生；默认只显示 hierarchy 根主题，Concept 单击同时打开详情并逐层展开/递归收起，`related` 永不改变层级。Sigma.js 评估后暂不替换 D3：现有 SVG 图谱已覆盖缩放、拖拽、悬停高亮、键盘语义、框选和稳定布局，贸然换成 Sigma 会改写测试与交互层；后续若节点规模超过当前阈值，再以独立适配层引入 graphology/Sigma。
- 知识主题页的左栏使用可折叠 hierarchy 树，主题行单击选中并打开右侧内容，树节点的独立折叠控件负责展开/收起；过滤时保留命中主题的祖先节点，父子跳转后详情列滚动回顶。会话探索树使用大圆点、细连接线和悬停/聚焦标签，切换分支时只替换当前前景卡片。图谱主题节点不提供独立 `+/-` 控件，主体单击同时打开详情并展开/收起，新增或移除的节点通过透明度和稳定坐标过渡。
