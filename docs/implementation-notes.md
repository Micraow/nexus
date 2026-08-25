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
- 起源 Concept 没有独立的 Session-Concept 事实表。为让起源结果可见且能进入派生图谱，当前实现会把通过校验的起源 Concept 关联到该 Session 的所有 KnowledgeUnit；后续若增加 Session 级 Concept 表，应迁移这部分关联逻辑。
- 会话内追问（从导航树节点或会话详情发起）：用户消息以 `metadata = { mode: 'follow_up', parentNodeId, taskId }` 落库，回答分支节点挂在该节点之下（depth + 1）。与“新对话”任务的区别：追问不新建 Session，应用结果后按 `unit_count = unit_count + n` 累加，而新对话固定写 `message_count = 2`。早期没有 `metadata.taskId` 的对话任务按 legacy 规则回落到根节点。
- 任务中心在队列启动前显示待处理任务数、覆盖的 Session 数和预计调用次数（按待处理 API 任务数估算，失败重试最多 ×3 不计入）；Session 数取 `inputRevision` 首段去重，`maintenance:` 前缀不计入。

## 图谱

- 图谱共现计算运行在 Web Worker（`workers/graph.worker.ts`）中；主线程只做缓存命中与布局回填。缓存键为 `图谱版本:单元开关:消息开关:待确认开关:展开主题`，任一输入变化即重新计算，计算期间先返回最近一次快照（stale-while-revalidate 式），完成后增量刷新。Worker 不可用时退回主线程同步计算。
- Worker 通信的数据必须先深拷贝为纯 JSON（`toPlainJson`）：Pinia 的响应式代理无法结构化克隆，直接 `postMessage` 会抛 `DataCloneError` 并中断图谱视图渲染。新增图谱输入字段时必须保持可 JSON 序列化。
- GraphNode/GraphEdge 继续作为派生视图。图谱以知识主题为中心：单元节点只随关联主题出现（全局“知识单元”开关或点击主题局部展开），未关联主题的单元不会孤立出现；未归类消息仅在“未归类消息”开关打开时显示。点击 Concept 时，当前选中的 Concept 会作为局部展开参数，即使全局关闭 KnowledgeUnit，也会显示它关联的单元。
- 图谱布局持久化：节点拖拽结束写入 `graph_layout`（固定坐标），视口平移/缩放防抖后写入单行 `graph_viewport` 表；刷新后恢复。“重置布局”清除这两类记录并重新计算。快照变化触发的重渲染以 d3 的实时变换恢复视口，持久化视口只在组件挂载时应用；store 保存/重置视口时会同步内存值，避免过期的 prop 把缩放拉回旧状态，“重置布局”通过递增组件 key 整体重建实现。
- 图谱支持框选多选：空白画布上 Shift+左键拖出选框（该手势已从 d3.zoom 的默认事件过滤中排除，不与平移冲突），松开后把框内知识单元节点逐一加入跨会话上下文选择；选框坐标经当前缩放变换的逆变换映射回布局坐标再判定命中。
- 手动图谱边保存在 `manual_graph_edges`，但当前界面只提供数据层 API，关系创建界面仍以 ConceptRelation 表单为主。
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

## Chrome 扩展（DeepSeek 导出器）

- MV3 结构：`bridge.js` 注入 MAIN world（`document_start`，要求 Chrome 111+）包装 `fetch`/`XHR`，把 `/api/` 响应的 JSON 通过 `CustomEvent('nexus:captured-json')` 转发给隔离世界；`content.js` 在隔离世界深搜响应对象树（递归查找含 `role` + `content` 的数组）并按会话 id 缓存。页面结构变化时自动降级为 DOM 提取（`.ds-markdown` 交替块），两类来源都失败才计入错误。
- 侧边栏会话列表采用“锚点定位 + 滚动容器步进”懒加载，逐屏触发 DeepSeek 自己的加载请求；工作台可暂停/继续，失败项可重试。
- 导出策略：全部会话失败时不生成文件；部分成功仍导出，失败项进入 `errors` 数组随 JSON 一并保存，便于补导。工作台通过向源页面发消息驱动抓取，不自行注入网络请求。

## 桌面打包（Tauri）

- 打包配置在 `src-tauri/tauri.conf.json`：`bundle.active` 已开启，Linux 产物为 deb / rpm / AppImage，输出到 `src-tauri/target/release/bundle/<目标>/`。图标由 `pnpm tauri icon <1024px 源图>` 从 `icons/icon.svg` 生成整套尺寸。
- 生产 CSP 的 `script-src` 必须包含 `'wasm-unsafe-eval'`，否则 sql.js 的 WASM 在 WebView2（Windows）中无法实例化；`connect-src` 放行 `https:` 供用户自配的 Provider 端点使用，并包含 Tauri v2 的 IPC 源（`ipc:` 与 `http://ipc.localhost`）。
- AppImage 打包需要运行 linuxdeploy 工具链。宿主机只有 fuse3（缺 fuse2）时，linuxdeploy AppImage 无法直接执行，需加环境变量 `APPIMAGE_EXTRACT_AND_RUN=1` 让其自解压运行；deb 与 rpm 由 Tauri 纯 Rust 实现，无需系统 dpkg/rpm 工具。
- 版本号需要同步三处：`tauri.conf.json` 的 `version`、`Cargo.toml` 的 `version`、（如发布扩展）`extension/manifest.json`。业务前端版本不单独维护。

## 验收覆盖说明（对应设计 15.1）

- 单元测试（vitest，30 项）覆盖纯函数：Markdown 渲染与注入防护、分块切分与合并校验、图谱关系建环规则、中文搜索回退与排序。`services/db.ts` 与 store 的数据库耦合路径（导入、合并撤销、stale 防覆盖、备份恢复）依赖 sql.js WASM，未纳入 vitest 自动化。
- 数据库耦合路径通过 headless Chromium + CDP 冒烟脚本人工验收：空态加载、图谱渲染、帮助弹窗、Provider 保存、导入 JSON → 任务中心 → Prompt 粘贴应用分段 → 标题/摘要/主题任务逐个应用 → 图谱出现主题与单元节点 → 会话列表核对，全程断言无运行时异常。该脚本为临时验收工具，不随应用分发。
