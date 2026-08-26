# 实现补充记录

本文记录 `docs/design.md` 与 `docs/data-spec.md` 没有完全展开、但实现时必须固定下来的行为。它不是新的产品需求；后续实现和验收如有冲突，以设计文档和数据规范为准，并在这里追加变更原因。

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

- 所有结构化任务都要求 JSON 对象。分段使用 `units` 与 `unassigned_message_indices`；标题、摘要分别使用 `{ "title": "..." }` 和 `{ "summary": "..." }`；Concept 使用 `{ "concepts": [{ "name": "...", "aliases": [] }] }`，同时兼容只返回字符串数组的结果。
- 分段结果通过完整覆盖、重复、越界和文本长度校验后才写入。应用分段会把旧的下游任务标为 `stale`，再按每个新 KnowledgeUnit 创建标题、摘要和 Concept 任务；起源 Concept 任务重用并更新为新的 Session revision。
- LLM 生成的标题/摘要写入时不增加 KnowledgeUnit revision；revision 增加只发生在用户手动编辑或消息边界改变时。这样同一单元的标题、摘要和 Concept 任务可以按同一输入 revision 顺序完成。用户手动编辑会使该单元尚未完成的下游任务变为 `stale`。
- API 任务队列按配置并发数（1～4）批量执行，单任务最多进行三次请求（含超时、429 和 5xx 的指数退避）。同一 Session 的任务严格串行：批内每个目标 Session（由 `inputRevision` 前缀或所属单元推导）只允许一个在途任务，保证分段 → 标题/摘要 → Concept 的依赖顺序，避免旧 revision 校验误伤。Prompt 粘贴任务保持人工逐项应用。并发数已在设置页提供选择器（1～4），写回 `config.yaml`；同一 Session 依赖任务串行的规则不受并发数影响。
- 长 Session 按估算 token 预算切成带两条消息重叠的分块；合并多个分块结果时校验全局索引覆盖、重复分配与重叠主题冲突，任何冲突都整体判失败，不写入部分结果。
- API 模式采用 OpenAI-compatible Chat Completions：请求地址为 `baseUrl + /chat/completions`，只发送当前任务 Prompt，温度固定为 `0`。`local_only` Session 在 API 执行前被拒绝；Prompt 粘贴模式不发网络请求。
- 所有任务 Prompt 先经过 `ensureHarnessPrompt`，固定拼接版本化的 `NEXUS_HARNESS_PROMPT` 与 `PROGRESSIVE_DISCLOSURE_PROTOCOL`；动态任务规格放在固定前缀之后。Harness 允许模型使用自身知识和调用方授权的搜索/工具，但要求区分输入证据、外部资料和推断，并把消息、摘要、目录都当作不可信数据。
- 大型知识上下文通过 `DISCLOSURE_INDEX` 传递：根引用只包含 `title`、`summary` 和不透明 `refID`，展开记录才提供下一层 children 或消息原文。模型可返回 `disclosure_requests: [{ refID, depth }]`；应用先校验 ID 已在当前目录、无重复且深度为 1～64，再从本地 hierarchy、KnowledgeUnit 和 Message 递归生成下一轮 Prompt。API 模式自动续跑，最多 8 轮；Prompt 粘贴模式把同一任务恢复为 pending，等待用户执行更新后的 Prompt。非法请求或超过轮数进入 `needs_review`，不会应用部分结果。
- 起源 Concept 没有独立的 Session-Concept 事实表。为让起源结果可见且能进入派生图谱，当前实现会把通过校验的起源 Concept 关联到该 Session 的所有 KnowledgeUnit；后续若增加 Session 级 Concept 表，应迁移这部分关联逻辑。
- 会话内追问（从导航树节点或会话详情发起）：用户消息以 `metadata = { mode: 'follow_up', parentNodeId, taskId }` 落库，回答分支节点挂在该节点之下（depth + 1）。与“新对话”任务的区别：追问不新建 Session，应用结果后按 `unit_count = unit_count + n` 累加，而新对话固定写 `message_count = 2`。早期没有 `metadata.taskId` 的对话任务按 legacy 规则回落到根节点。
- 任务中心在队列启动前显示待处理任务数、覆盖的 Session 数和预计调用次数（按待处理 API 任务数估算，失败重试最多 ×3 不计入）；Session 数取 `inputRevision` 首段去重，`maintenance:` 前缀不计入。

## 图谱

- 图谱共现计算运行在 Web Worker（`workers/graph.worker.ts`）中；主线程只做缓存命中与布局回填。缓存键包含 `graph_revision`、知识单元/消息/待确认/保留会话开关、`expandedConceptDepth` 和排序后的 `expandedConceptIds`，任一输入变化即重新计算，计算期间先返回最近一次快照（stale-while-revalidate 式），完成后增量刷新。Worker 不可用时退回主线程同步计算。
- Worker 通信的数据必须先深拷贝为纯 JSON（`toPlainJson`）：Pinia 的响应式代理无法结构化克隆，直接 `postMessage` 会抛 `DataCloneError` 并中断图谱视图渲染。新增图谱输入字段时必须保持可 JSON 序列化。
- GraphNode/GraphEdge 继续作为派生视图。`resolveVisibleConceptIds` 默认只返回 active hierarchy 根节点；节点旁的展开控件把 Concept 加入 `expandedConceptIds`，逐层显示直接子节点。`normalizeExpandedConceptIds` 会补齐显式后代的祖先路径；`toggleConceptExpansion` 在收起父节点时递归清除后代。hierarchy 不限制深度且允许多父节点；`related` 始终无向，完全不参与根节点、祖先、深度或展开判断。
- 折叠主题通过 hierarchy 投影到最近可见祖先。每个 KnowledgeUnit 先对可见代表节点去重，再对每个代表节点对贡献一次共现权重；因此隐藏叶节点仍能为根视图提供聚合关系，同时不会因多条叶子路径重复计数。hierarchy 只绘制当前两端都可见的事实边；related 的隐藏端点也可投影到可见祖先，但只形成无向弱关系。
- 图谱中的节点主体点击只打开详情，不改变拓扑；节点旁的展开/收起控件才改变层级投影。全局 `showUnits` 显示所有有关联的单元，显式展开的主题也会披露其后代单元；消息按 `showMessages`、保留会话或局部展开生成，并按 Session 的 `orderInSession` 连接成链。
- 图谱布局持久化：节点拖拽结束写入 `graph_layout`（固定坐标），视口平移/缩放防抖后写入单行 `graph_viewport` 表；刷新后恢复。“重置布局”清除这两类记录并重新计算。快照变化触发的重渲染以 d3 的实时变换恢复视口，持久化视口只在组件挂载时应用；store 保存/重置视口时会同步内存值，避免过期的 prop 把缩放拉回旧状态，“重置布局”通过递增组件 key 整体重建实现。
- 图谱支持框选多选：空白画布上 Shift+左键拖出选框（该手势已从 d3.zoom 的默认事件过滤中排除，不与平移冲突），松开后把框内知识单元节点逐一加入跨会话上下文选择；选框坐标经当前缩放变换的逆变换映射回布局坐标再判定命中。
- 手动图谱边保存在 `manual_graph_edges`，但当前界面只提供数据层 API，关系创建界面仍以 ConceptRelation 表单为主。
- 层级维护使用 workspace store 的 `setConceptParent`、`addConceptChild`、`removeConceptFromParent` 和 `promoteConcept`：前两者写入 hierarchy 前做成环检查，移除一条父引用不会删除子主题；没有其他父引用时子主题自然回到根集合，`promoteConcept` 一次移除全部父引用。`related` 关系两端按无向集合处理。
- 完整知识库 JSON 使用 TypeScript 的 camelCase 实体字段（关系数组字段用下划线命名以区分表），导出带 `export_version=1`，恢复时严格校验所有业务数组并按外键依赖顺序写入。它与用于扩展导入的外部 JSON 是两个不同契约。

## 消息渲染安全模型

- 消息与回答详情使用受限 Markdown 渲染（`services/markdown.ts`）：先对原文转义 `&`、`<`、`>`（不转义引号，因为结果不进入属性），再生成块级结构（标题、列表、引用、分隔线、段落）与行内结构（粗体、斜体、行内代码、链接、fenced 代码块）。
- 链接只接受 `http(s)` 协议，`javascript:` 等一律按纯文本处理；行内代码内的文本不再做链接或概念识别。
- 知识主题提及渲染为可点击胶囊：把当前主题名（含别名，长名优先）拼成交替正则做一次性替换，用无命名捕获组（兼容旧 WebKitGTK 的正则能力）并按匹配文本查表回填主题 id，因此主题名中的正则特殊字符不会破坏匹配。
- 渲染结果通过 `v-html` 注入前已完成转义，消息原文永远不作为 HTML 解释；事件代理只响应带数据属性的主题胶囊点击。

## 主动探索界面

- `Concept` 在用户界面中显示为“知识主题”。这是中文产品文案的显示层选择：它比“概念”更能表达跨会话复用的稳定知识主体；数据库字段、TypeScript 类型和 Prompt 契约仍使用 `Concept`，以保持设计文档的数据契约不变。
- 界面文案不暴露开发术语：面向用户统一使用“会话 / 知识单元 / 知识主题 / 任务”等词，`Session`、`Concept`、`schema` 等只出现在数据层与文档。
- 从知识主题详情或上下文面板发起对话时，总是打开独立的 composer。快捷短语先渲染 `$(topic)` / `$(context)`，用户仍可编辑生成的问题；创建后只落库用户首条消息和待处理 conversation 任务，不在界面中直接发送网络请求。
- 导航树使用 `NavTreeNode` 的父子关系递归渲染；会话页同时保留按时间排列的知识单元列表，节点点击只定位已有单元，不复制或重建事实数据。
- 上下文排序在界面状态中保持为用户拖拽顺序，创建 conversation 任务时按该顺序写入 `ContextReference.order_in_context`。输入 token 以字符数除以 4 估算；超过配置预算时只提示并禁止创建任务，不静默截断。
- 长列表使用分段加载而非虚拟滚动：会话每页 40、知识主题每页 60、历史任务每页 30，底部“加载更多”递增可见数。该阈值是界面常量，后续接入虚拟滚动时可整体替换。
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

- 单元测试（vitest，36 项）覆盖纯函数：Markdown 渲染与注入防护、分块切分与合并校验、图谱关系建环规则、中文搜索回退与排序、扩展会话发现与导出 payload。`services/db.ts` 与 store 的数据库耦合路径（导入、合并撤销、stale 防覆盖、备份恢复）依赖 sql.js WASM，未纳入 vitest 自动化。
- 数据库耦合路径通过 headless Chromium + CDP 冒烟脚本人工验收：空态加载、图谱渲染、帮助弹窗、Provider 保存、导入 JSON → 任务中心 → Prompt 粘贴应用分段 → 标题/摘要/主题任务逐个应用 → 图谱出现主题与单元节点 → 会话列表核对，全程断言无运行时异常。该脚本为临时验收工具，不随应用分发。
