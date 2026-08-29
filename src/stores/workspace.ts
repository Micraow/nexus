import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/services/db'
import { httpRequest } from '@/services/http'
import { DEFAULT_API_CONCURRENCY, DEFAULT_CONCEPT_LIMIT, DEFAULT_TOKEN_BUDGET, normalizeApiConcurrency, normalizeConceptLimit, normalizeTokenBudget, parseConfigText, readConfigText, writeConfig } from '@/services/config'
import { buildGraph, graphSnapshotIsProgressiveCompatible, graphStats, graphViewFallbackIsCompatible, resolveVisibleConceptIds, toggleExpandedConceptIds } from '@/services/graph'
import { buildSearchDocuments, searchKnowledge } from '@/services/search'
import { buildConceptPrompt, buildConversationPrompt, buildMaintenancePrompt, buildOriginConceptPrompt, buildRepairPrompt, buildSessionTriagePrompt, buildTitleSummaryPrompt, ensureHarnessPrompt, formatMaintenanceActionApi, listMaintenanceMcpTools, listedDisclosureRefIds, MAINTENANCE_ACTION_API, maintenanceToolCallSuggestion, parseDisclosureContext, PROMPT_VERSION, renderQuickPhrase, replaceDisclosureContext } from '@/services/prompts'
import { conversationMessageBranchNodeId } from '@/services/conversation'
import { importPayloadSchema, normalizeOriginConceptResultForReuse, parseImportPayload, validateConceptIdList, validateConceptMemberships, validateConceptName, validateDisclosureRequests, validateOriginConceptResult, validateSegmentationResult, validateUnitText } from '@/services/validation'
import type { DisclosureContext } from '@/services/prompts'
import { combineSegmentationChunks, splitMessageChunks } from '@/utils/chunks'
import { wouldCreateHierarchyCycle } from '@/utils/graph-rules'
import { createId, isoNow, normalizeText, parseIsoTimestamp, stableHash } from '@/utils/id'
import { parseMetadata } from '@/utils/metadata'
import { canTransitionTask, canTransitionTaskStatus, isActiveTaskStatus, LEGACY_SEGMENTATION_RETIRED_REASON, normalizeTaskStatus, taskPhaseForStatus, taskPhaseForTransition, taskStatusForTransition, type TaskTransitionEvent } from '@/services/task-state'
import type {
  AppConfig,
  Concept,
  ConceptAlias,
  ConceptRelation,
  ContextReference,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  GraphLayoutEntry,
  GraphViewport,
  GraphViewOptions,
  ImportPayload,
  ImportReport,
  KnowledgeUnit,
  LLMTask,
  MaintenanceSuggestion,
  ManualGraphEdge,
  Message,
  MessageConcept,
  NavTreeNode,
  NavTreeNodeUnit,
  OperationLog,
  QuickPhrase,
  Session,
  SessionConcept,
  UnitConcept,
} from '@/types/domain'
import type { GraphWorkerResponse } from '@/workers/graph.worker'

export type { GraphViewOptions } from '@/types/domain'

type Row = Record<string, unknown>

const DEFAULT_CONFIG: AppConfig = {
  llm: { mode: null, defaultProvider: null, concurrency: DEFAULT_API_CONCURRENCY, conceptLimit: DEFAULT_CONCEPT_LIMIT, tokenBudget: DEFAULT_TOKEN_BUDGET, stream: false, providers: [], taskOverrides: {} },
  prompts: { overrideDir: '' },
  ui: { theme: 'system', reducedMotion: false, fontFamily: 'system-sans', fontSize: 15, graph: { showUnits: false, showMessages: false, showProposed: false, showRetainedSessions: false } },
  storage: { databasePath: '' },
}

function text(value: unknown): string {
  return value == null ? '' : String(value)
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(value: unknown): boolean {
  return Number(value) === 1 || value === true
}

function compactSessionText(value: unknown, maxLength: number): string {
  const normalized = String(value ?? '')
    .replace(/\[\[\/?nexus(?::(?:existing|suggested):[^\]]+)?\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(normalized).slice(0, maxLength).join('')
}

function isGeneratedConversationTitle(session: Session): boolean {
  return session.source === 'in_app'
    && (session.title === '新的知识对话' || /^围绕 .+ 的新对话$/.test(session.title))
}

/** 深拷贝为纯 JSON 数据，用于跨 Worker 传输（响应式代理无法结构化克隆）。 */
function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sessionFromRow(row: Row): Session {
  return {
    id: text(row.id),
    source: text(row.source) as Session['source'],
    platform: text(row.platform),
    model: row.model == null ? null : text(row.model),
    externalSessionId: row.external_session_id == null ? null : text(row.external_session_id),
    title: text(row.title),
    summary: text(row.summary),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    messageCount: number(row.message_count),
    unitCount: number(row.unit_count),
    knowledgeKind: (text(row.knowledge_kind) || 'unknown') as Session['knowledgeKind'],
    knowledgeConfidence: row.knowledge_confidence == null ? null : number(row.knowledge_confidence),
    knowledgeJudgment: row.knowledge_judgment == null ? null : text(row.knowledge_judgment),
    knowledgeRetainInGraph: bool(row.knowledge_retain_in_graph),
    revision: number(row.revision, 1),
    localOnly: bool(row.local_only),
    deletedAt: row.deleted_at == null ? null : text(row.deleted_at),
  }
}

function messageFromRow(row: Row): Message {
  const metadata = row.metadata == null ? null : parseMetadata(row.metadata)
  return {
    id: text(row.id),
    sessionId: text(row.session_id),
    unitId: row.unit_id == null ? null : text(row.unit_id),
    role: text(row.role) as Message['role'],
    content: text(row.content),
    orderInSession: number(row.order_in_session),
    timestamp: row.timestamp == null ? null : text(row.timestamp),
    metadata,
  }
}

function unitFromRow(row: Row): KnowledgeUnit {
  return {
    id: text(row.id),
    sessionId: text(row.session_id),
    title: row.title == null ? null : text(row.title),
    summary: row.summary == null ? null : text(row.summary),
    orderInSession: number(row.order_in_session),
    status: text(row.status) as KnowledgeUnit['status'],
    revision: number(row.revision, 1),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  }
}

function conceptFromRow(row: Row): Concept {
  return {
    id: text(row.id),
    name: text(row.name),
    normalizedName: text(row.normalized_name),
    summary: text(row.summary),
    notes: text(row.notes),
    status: text(row.status) as Concept['status'],
    mergedIntoId: row.merged_into_id == null ? null : text(row.merged_into_id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    deletedAt: row.deleted_at == null ? null : text(row.deleted_at),
  }
}

function taskFromRow(row: Row): LLMTask {
  const status = text(row.status) as LLMTask['status']
  const response = row.response == null ? null : text(row.response)
  const parsedResult = row.parsed_result == null ? null : text(row.parsed_result)
  const awaitingDisclosure = status === 'pending' && !parsedResult && Boolean(response && /"disclosure_requests"\s*:\s*\[[^\]]*"refID"/u.test(response))
  return {
    id: text(row.id),
    type: text(row.type) as LLMTask['type'],
    mode: text(row.mode) as LLMTask['mode'],
    providerId: row.provider_id == null ? null : text(row.provider_id),
    model: row.model == null ? null : text(row.model),
    promptVersion: text(row.prompt_version),
    inputRevision: text(row.input_revision),
    prompt: ensureHarnessPrompt(text(row.prompt)),
    response,
    parsedResult,
    validationErrors: row.validation_errors == null ? null : text(row.validation_errors),
    status,
    phase: row.phase == null ? taskPhaseForStatus(status, awaitingDisclosure) : text(row.phase) as LLMTask['phase'],
    retryCount: number(row.retry_count),
    errorMessage: row.error_message == null ? null : text(row.error_message),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    scopeLabel: row.scope_label == null ? undefined : text(row.scope_label),
  }
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const ready = ref(false)
  const loading = ref(false)
  const sessions = ref<Session[]>([])
  const messages = ref<Message[]>([])
  const units = ref<KnowledgeUnit[]>([])
  const concepts = ref<Concept[]>([])
  const aliases = ref<ConceptAlias[]>([])
  const unitConcepts = ref<UnitConcept[]>([])
  const sessionConcepts = ref<SessionConcept[]>([])
  const messageConcepts = ref<MessageConcept[]>([])
  const relations = ref<ConceptRelation[]>([])
  const navNodes = ref<NavTreeNode[]>([])
  const navNodeUnits = ref<NavTreeNodeUnit[]>([])
  const tasks = ref<LLMTask[]>([])
  const contextReferences = ref<ContextReference[]>([])
  const manualEdges = ref<ManualGraphEdge[]>([])
  const quickPhrases = ref<QuickPhrase[]>([])
  const operationLogs = ref<OperationLog[]>([])
  const graphLayout = ref<GraphLayoutEntry[]>([])
  const graphViewport = ref<GraphViewport>({ x: 0, y: 0, scale: 1, layoutVersion: 1 })
  const graphRevision = ref(1)
  const config = ref<AppConfig>(structuredClone(DEFAULT_CONFIG))
  const configWarning = ref<string | null>(null)
  const selectedContextIds = ref<string[]>([])
  const selectedContextMessageIds = ref<string[]>([])
  const selectedSessionId = ref<string | null>(null)
  const lastImport = ref<ImportReport | null>(null)
  const graphSnapshots = new Map<string, GraphSnapshot>()
  const graphSnapshotOptions = new Map<string, GraphViewOptions>()
  const graphPendingOptions = new Map<string, GraphViewOptions>()
  const graphPendingKeys = new Set<string>()
  const graphTick = ref(0)
  let graphWorker: Worker | null = null
  const queueRunning = ref(false)
  const queuePaused = ref(false)
  const queueActiveCount = ref(0)
  const abortControllers = new Map<string, AbortController>()
  // Streaming conversation responses are kept separately from the durable
  // assistant Message. The partial payload is usually an incomplete JSON
  // object, so the UI extracts only the answer text for a readable preview.
  const streamingTaskText = ref<Record<string, string>>({})
  // A task can be started from both the queue and the task detail view. Keep
  // an in-process guard so those entry points cannot issue duplicate requests.
  const executingTaskIds = new Set<string>()

  const activeSessions = computed(() => sessions.value.filter((session) => !session.deletedAt))
  const activeSessionIds = computed(() => new Set(activeSessions.value.map((session) => session.id)))
  const activeConcepts = computed(() => concepts.value.filter((concept) => concept.status === 'active'))
  const pendingTaskCount = computed(() => tasks.value.filter((task) => task.type !== 'segmentation' && isActiveTaskStatus(task.status)).length)
  const selectedUnits = computed(() => selectedContextIds.value.map((id) => units.value.find((unit) => unit.id === id)).filter(Boolean) as KnowledgeUnit[])
  const selectedContextMessages = computed(() => selectedContextMessageIds.value.map((id) => messages.value.find((message) => message.id === id)).filter(Boolean) as Message[])
  const stats = computed(() => ({
    sessions: activeSessions.value.length,
    messages: messages.value.filter((message) => activeSessionIds.value.has(message.sessionId)).length,
    units: units.value.filter((unit) => activeSessionIds.value.has(unit.sessionId)).length,
    concepts: activeConcepts.value.length,
    pendingTasks: pendingTaskCount.value,
  }))

  function refreshFromDb(): void {
    sessions.value = db.query<Row>('SELECT * FROM sessions ORDER BY updated_at DESC').map(sessionFromRow)
    messages.value = db.query<Row>('SELECT * FROM messages ORDER BY session_id, order_in_session').map(messageFromRow)
    units.value = db.query<Row>('SELECT * FROM knowledge_units ORDER BY created_at DESC').map(unitFromRow)
    concepts.value = db.query<Row>('SELECT * FROM concepts ORDER BY name COLLATE NOCASE').map(conceptFromRow)
    aliases.value = db.query<Row>('SELECT * FROM concept_aliases ORDER BY alias COLLATE NOCASE').map((row) => ({
      id: text(row.id),
      conceptId: text(row.concept_id),
      alias: text(row.alias),
      normalizedAlias: text(row.normalized_alias),
      source: text(row.source) as ConceptAlias['source'],
      createdAt: text(row.created_at),
    }))
    unitConcepts.value = db.query<Row>('SELECT * FROM unit_concepts').map((row) => ({
      unitId: text(row.unit_id),
      conceptId: text(row.concept_id),
      source: text(row.source) as UnitConcept['source'],
      createdAt: text(row.created_at),
    }))
    sessionConcepts.value = db.query<Row>('SELECT * FROM session_concepts').map((row) => ({
      sessionId: text(row.session_id),
      conceptId: text(row.concept_id),
      source: text(row.source) as SessionConcept['source'],
      createdAt: text(row.created_at),
    }))
    messageConcepts.value = db.query<Row>('SELECT * FROM message_concepts').map((row) => ({
      messageId: text(row.message_id),
      conceptId: text(row.concept_id),
      source: text(row.source) as MessageConcept['source'],
      createdAt: text(row.created_at),
    }))
    relations.value = db.query<Row>('SELECT * FROM concept_relations').map((row) => ({
      id: text(row.id),
      parentConceptId: text(row.parent_concept_id),
      childConceptId: text(row.child_concept_id),
      relationType: text(row.relation_type) as ConceptRelation['relationType'],
      source: text(row.source) as ConceptRelation['source'],
      status: text(row.status) as ConceptRelation['status'],
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    }))
    navNodes.value = db.query<Row>('SELECT * FROM nav_tree_nodes ORDER BY depth, created_at').map((row) => ({
      id: text(row.id),
      sessionId: text(row.session_id),
      parentId: row.parent_id == null ? null : text(row.parent_id),
      triggerConceptId: row.trigger_concept_id == null ? null : text(row.trigger_concept_id),
      label: text(row.label),
      depth: number(row.depth),
      createdAt: text(row.created_at),
    }))
    navNodeUnits.value = db.query<Row>('SELECT * FROM nav_tree_node_units ORDER BY node_id, order_in_node').map((row) => ({
      nodeId: text(row.node_id),
      unitId: text(row.unit_id),
      orderInNode: number(row.order_in_node),
    }))
    tasks.value = db.query<Row>('SELECT * FROM llm_tasks ORDER BY created_at DESC').map(taskFromRow)
    contextReferences.value = db.query<Row>('SELECT * FROM context_references ORDER BY target_session_id, order_in_context').map((row) => ({
      id: text(row.id),
      targetSessionId: text(row.target_session_id),
      sourceSessionId: text(row.source_session_id),
      sourceUnitId: row.source_unit_id == null ? null : text(row.source_unit_id),
      sourceMessageId: row.source_message_id == null ? null : text(row.source_message_id),
      orderInContext: number(row.order_in_context),
      includeFullContent: bool(row.include_full_content),
    }))
    manualEdges.value = db.query<Row>('SELECT * FROM manual_graph_edges ORDER BY created_at').map((row) => ({
      id: text(row.id),
      sourceType: text(row.source_type) as ManualGraphEdge['sourceType'],
      sourceRefId: text(row.source_ref_id),
      targetType: text(row.target_type) as ManualGraphEdge['targetType'],
      targetRefId: text(row.target_ref_id),
      label: row.label == null ? null : text(row.label),
      createdAt: text(row.created_at),
    }))
    quickPhrases.value = db.query<Row>('SELECT * FROM quick_phrases ORDER BY sort_order, id').map((row) => ({
      id: text(row.id),
      template: text(row.template),
      isBuiltin: bool(row.is_builtin),
      sortOrder: number(row.sort_order),
    }))
    operationLogs.value = db.query<Row>('SELECT * FROM operation_log ORDER BY created_at DESC').map((row) => ({
      id: text(row.id),
      action: text(row.action),
      beforeJson: text(row.before_json),
      afterJson: row.after_json == null ? null : text(row.after_json),
      createdAt: text(row.created_at),
      undoneAt: row.undone_at == null ? null : text(row.undone_at),
    }))
    graphLayout.value = db.query<Row>('SELECT * FROM graph_layout ORDER BY node_type, ref_id').map((row) => ({
      nodeType: text(row.node_type) as GraphLayoutEntry['nodeType'],
      refId: text(row.ref_id),
      x: number(row.x),
      y: number(row.y),
      fixed: bool(row.fixed),
      layoutVersion: number(row.layout_version, 1),
    }))
    const viewport = db.query<Row>('SELECT * FROM graph_viewport WHERE id = 1')[0]
    graphViewport.value = viewport ? { x: number(viewport.x), y: number(viewport.y), scale: number(viewport.scale, 1), layoutVersion: number(viewport.layout_version, 1) } : { x: 0, y: 0, scale: 1, layoutVersion: 1 }
    graphRevision.value = Number(db.getMeta('graph_revision') ?? '1')
    graphSnapshots.clear()
    graphSnapshotOptions.clear()
    graphPendingOptions.clear()
    graphPendingKeys.clear()
    db.rebuildSearchDocuments(buildSearchDocuments({
      concepts: concepts.value,
      aliases: aliases.value,
      units: units.value.filter((unit) => activeSessionIds.value.has(unit.sessionId)),
      messages: messages.value.filter((message) => activeSessionIds.value.has(message.sessionId)),
    }))
  }

  function setStreamingTaskText(taskId: string, value: string): void {
    streamingTaskText.value = { ...streamingTaskText.value, [taskId]: value }
  }

  function clearStreamingTaskText(taskId: string): void {
    if (!(taskId in streamingTaskText.value)) return
    const next = { ...streamingTaskText.value }
    delete next[taskId]
    streamingTaskText.value = next
  }

  function streamingTaskPreview(taskId: string): string {
    const raw = streamingTaskText.value[taskId] ?? ''
    if (!raw) return ''
    const match = raw.match(/"answer"\s*:\s*"((?:\\.|[^"\\])*)/)
    if (!match) return ''
    try {
      return JSON.parse(`"${match[1]}"`) as string
    } catch {
      return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }

  async function init(): Promise<void> {
    if (ready.value || loading.value) return
    loading.value = true
    const storedConfig = await readConfigText()
    if (storedConfig) {
      try {
        const parsed = parseConfigText(storedConfig)
        config.value = {
          ...structuredClone(DEFAULT_CONFIG),
          ...parsed,
          llm: { ...DEFAULT_CONFIG.llm, ...(parsed.llm ?? {}) },
          ui: { ...DEFAULT_CONFIG.ui, ...(parsed.ui ?? {}), graph: { ...DEFAULT_CONFIG.ui.graph, ...(parsed.ui?.graph ?? {}) } },
          storage: { ...DEFAULT_CONFIG.storage, ...(parsed.storage ?? {}) },
        }
      } catch {
        // YAML 解析失败：保留原文件，沿用上一次有效配置并提示用户。
        configWarning.value = '配置文件解析失败，已沿用上一次有效配置；请修复 config.yaml 后重启应用。'
      }
    } else {
      config.value = structuredClone(DEFAULT_CONFIG)
    }
    db.setDatabasePathOverride(config.value.storage.databasePath || null)
    await db.init()
    refreshFromDb()
    ready.value = true
    loading.value = false
  }

  /** Switch to another database location after confirming and backing up. */
  async function changeDatabasePath(path: string): Promise<string | null> {
    const trimmed = path.trim()
    if ((config.value.storage.databasePath ?? '') === trimmed) return null
    let backupReference: string | null = null
    try {
      backupReference = (await db.createBackup())?.reference ?? null
    } catch {
      // 当前还没有数据库文件时无需备份。
    }
    db.setDatabasePathOverride(trimmed || null)
    updateConfig({ storage: { databasePath: trimmed } })
    await db.reopen()
    refreshFromDb()
    selectedContextIds.value = []
    selectedContextMessageIds.value = []
    selectedSessionId.value = activeSessions.value[0]?.id ?? null
    return backupReference
  }

  function mutate(callback: () => void, options: { graph?: boolean } = {}): void {
    db.transaction(() => {
      callback()
      if (options.graph !== false) db.bumpGraphRevision()
    })
    refreshFromDb()
  }

  type TaskTransitionPatch = {
    response?: string | null
    parsedResult?: string | null
    validationErrors?: string[] | null
    errorMessage?: string | null
    prompt?: string
    retryCountDelta?: number
  }

  /**
   * The only task status writer. The caller may perform related business
   * writes in the same database transaction by using this transaction-local
   * form; the public wrapper below is for standalone queue/UI events.
   */
  function transitionTaskInTransaction(taskId: string, event: TaskTransitionEvent, patch: TaskTransitionPatch = {}): boolean {
    // Read the persisted status inside the transaction. `tasks.value` is a
    // reactive snapshot and can lag behind a previous transition in the same
    // mutate callback (notably when legacy segmentation chunks are retired
    // before the current chunk is accepted).
    const row = db.query<Row>('SELECT status, prompt FROM llm_tasks WHERE id = ?', [taskId])[0]
    if (!row) return false
    const currentStatus = text(row.status) as LLMTask['status']
    if (!canTransitionTask(currentStatus, event)) return false
    const status = taskStatusForTransition(event)
    const phase = taskPhaseForTransition(event)
    const assignments = ['status = ?', 'phase = ?']
    const values: unknown[] = [status, phase]
    if (Object.prototype.hasOwnProperty.call(patch, 'response')) {
      assignments.push('response = ?')
      values.push(patch.response ?? null)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'parsedResult')) {
      assignments.push('parsed_result = ?')
      values.push(patch.parsedResult ?? null)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'validationErrors')) {
      assignments.push('validation_errors = ?')
      values.push(patch.validationErrors?.length ? JSON.stringify(patch.validationErrors) : null)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'errorMessage')) {
      assignments.push('error_message = ?')
      values.push(patch.errorMessage ?? null)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'prompt')) {
      assignments.push('prompt = ?')
      values.push(patch.prompt ?? text(row.prompt))
    }
    if (patch.retryCountDelta) {
      assignments.push('retry_count = retry_count + ?')
      values.push(patch.retryCountDelta)
    }
    assignments.push('updated_at = ?')
    values.push(isoNow(), taskId, currentStatus)
    db.run(`UPDATE llm_tasks SET ${assignments.join(', ')} WHERE id = ? AND status = ?`, values)
    return true
  }

  function transitionTask(taskId: string, event: TaskTransitionEvent, patch: TaskTransitionPatch = {}): boolean {
    let changed = false
    // Queue and validation events do not alter graph facts. Keeping this
    // transaction off graph_revision prevents task polling from invalidating
    // graph snapshots and triggering a visual redraw.
    mutate(() => { changed = transitionTaskInTransaction(taskId, event, patch) }, { graph: false })
    return changed
  }

  function graphCacheKey(options: GraphViewOptions): string {
    const expanded = [...(options.expandedConceptIds ?? [])].sort().join(',')
    const depth = options.expandedConceptDepth == null || !Number.isFinite(options.expandedConceptDepth)
      ? ''
      : String(Math.max(0, Math.floor(options.expandedConceptDepth)))
    return `${graphRevision.value}:${options.showUnits ? 1 : 0}:${options.showMessages ? 1 : 0}:${options.showProposed ? 1 : 0}:${options.showRetainedSessions ? 1 : 0}:${depth}:${expanded}`
  }

  function applyGraphLayout(snapshot: GraphSnapshot): GraphSnapshot {
    const persisted = new Map(graphLayout.value.map((entry) => [`${entry.nodeType}:${entry.refId}`, entry]))
    snapshot.nodes = snapshot.nodes.map((node) => {
      const entry = persisted.get(`${node.type}:${node.refId}`)
      return entry ? { ...node, x: entry.x, y: entry.y, fixed: entry.fixed } : node
    })
    snapshot.viewport = { ...graphViewport.value }
    return snapshot
  }

  function rememberGraphSnapshot(key: string, snapshot: GraphSnapshot, options: GraphViewOptions): GraphSnapshot {
    // Worker responses may come from a stale bundle or a legacy projection.
    // Never cache a snapshot that exposes descendants beyond the requested
    // disclosure state; rebuild it synchronously from the current store data
    // so the next render remains a valid roots/expanded projection.
    const input = graphInputFor(options)
    const visibleConceptIds = resolveVisibleConceptIds(input.concepts, input.relations, input).visibleIds
    const snapshotConceptIds = new Set(snapshot.nodes.filter((node) => node.type === 'concept').map((node) => node.refId))
    // A worker response may be structurally safe yet stale (for example,
    // after promoting a child to a root). Require every currently visible
    // Concept root/branch node before caching it; otherwise the UI can keep
    // serving an old subset indefinitely while waiting for another render.
    const respectsCurrentProjection = snapshotConceptIds.size === visibleConceptIds.size
      && [...snapshotConceptIds].every((id) => visibleConceptIds.has(id))
    const safeSnapshot = respectsCurrentProjection && graphSnapshotIsProgressiveCompatible(snapshot, options)
      ? snapshot
      : buildGraph(input)
    const prepared = applyGraphLayout(safeSnapshot)
    graphSnapshots.set(key, prepared)
    graphSnapshotOptions.set(key, toPlainJson(options))
    return prepared
  }

  function compatibleGraphFallback(options: GraphViewOptions): GraphSnapshot | null {
    let bestSnapshot: GraphSnapshot | null = null
    let bestExpansionCount = -1
    const input = graphInputFor(options)
    const visibleConceptIds = resolveVisibleConceptIds(input.concepts, input.relations, input).visibleIds
    graphSnapshots.forEach((snapshot: GraphSnapshot, key: string) => {
      if (snapshot.revision !== graphRevision.value) return
      const candidateOptions = graphSnapshotOptions.get(key)
      if (!candidateOptions || !graphViewFallbackIsCompatible(candidateOptions, options)) return
      const candidateConceptIds = new Set(snapshot.nodes.filter((node) => node.type === 'concept').map((node) => node.refId))
      if (candidateConceptIds.size !== visibleConceptIds.size || [...candidateConceptIds].some((id) => !visibleConceptIds.has(id))) return
      if (!graphSnapshotIsProgressiveCompatible(snapshot, options)) return
      const expansionCount = candidateOptions.expandedConceptIds?.length ?? 0
      if (expansionCount > bestExpansionCount) {
        bestSnapshot = snapshot
        bestExpansionCount = expansionCount
      }
    })
    return bestSnapshot
  }

  function graphInputFor(options: GraphViewOptions) {
    const activeUnits = units.value.filter((unit) => activeSessionIds.value.has(unit.sessionId))
    const activeUnitIds = new Set(activeUnits.map((unit) => unit.id))
    return {
      concepts: concepts.value,
      units: activeUnits,
      messages: messages.value.filter((message) => activeSessionIds.value.has(message.sessionId)),
      sessions: sessions.value.filter((session) => activeSessionIds.value.has(session.id)),
      unitConcepts: unitConcepts.value.filter((link) => activeUnitIds.has(link.unitId)),
      sessionConcepts: sessionConcepts.value,
      messageConcepts: messageConcepts.value,
      relations: relations.value,
      manualEdges: manualEdges.value,
      revision: graphRevision.value,
      ...options,
    }
  }

  function ensureGraphWorker(): Worker | null {
    if (graphWorker) return graphWorker
    if (typeof Worker === 'undefined') return null
    try {
      const worker = new Worker(new URL('../workers/graph.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<GraphWorkerResponse>) => {
        const { key, snapshot } = event.data
        graphPendingKeys.delete(key)
        const options = graphPendingOptions.get(key)
        graphPendingOptions.delete(key)
        if (options) rememberGraphSnapshot(key, snapshot, options)
        graphTick.value += 1
      }
      graphWorker = worker
    } catch {
      graphWorker = null
    }
    return graphWorker
  }

  function computeGraphSync(key: string, options: GraphViewOptions): void {
    rememberGraphSnapshot(key, buildGraph(graphInputFor(options)), options)
  }

  /** Cached graph view; heavy co-occurrence computation runs inside a worker. */
  function viewGraph(options: GraphViewOptions = {}): GraphSnapshot {
    void graphTick.value
    const key = graphCacheKey(options)
    const cached = graphSnapshots.get(key)
    if (cached) return cached
    const worker = ensureGraphWorker()
    if (worker) {
      if (!graphPendingKeys.has(key)) {
        graphPendingKeys.add(key)
        graphPendingOptions.set(key, toPlainJson(options))
        // Pinia 的响应式代理无法结构化克隆，必须先还原成普通 JSON 数据。
        worker.postMessage({ key, ...toPlainJson(graphInputFor(options)) })
      }
    } else {
      computeGraphSync(key, options)
      return graphSnapshots.get(key) as GraphSnapshot
    }
    return compatibleGraphFallback(options) ?? applyGraphLayout({ nodes: [], edges: [], revision: graphRevision.value })
  }

  function unitMessages(unitId: string): Message[] {
    return messages.value.filter((message) => message.unitId === unitId).sort((a, b) => a.orderInSession - b.orderInSession)
  }

  function unitConceptNames(unitId: string): string[] {
    const ids = unitConcepts.value.filter((link) => link.unitId === unitId).map((link) => link.conceptId)
    return ids.map((id) => concepts.value.find((concept) => concept.id === id)?.name).filter(Boolean) as string[]
  }

  /**
   * Hierarchy queries used by the graph and by progressive-disclosure UIs.
   * `related` relations are intentionally excluded from every helper here:
   * they describe an undirected association and never imply a parent.
   */
  function hierarchyRelations(includeProposed = false): ConceptRelation[] {
    const activeIds = new Set(activeConcepts.value.map((concept) => concept.id))
    return relations.value.filter((relation) =>
      relation.relationType === 'hierarchy'
      && (relation.status === 'confirmed' || (includeProposed && relation.status === 'proposed'))
      && activeIds.has(relation.parentConceptId)
      && activeIds.has(relation.childConceptId),
    )
  }

  function sortConceptsByName(items: Concept[]): Concept[] {
    return items.slice().sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id))
  }

  function conceptParentIds(conceptId: string, includeProposed = false): string[] {
    return hierarchyRelations(includeProposed)
      .filter((relation) => relation.childConceptId === conceptId)
      .map((relation) => relation.parentConceptId)
  }

  function conceptChildIds(conceptId: string, includeProposed = false): string[] {
    return hierarchyRelations(includeProposed)
      .filter((relation) => relation.parentConceptId === conceptId)
      .map((relation) => relation.childConceptId)
  }

  function conceptParents(conceptId: string, includeProposed = false): Concept[] {
    const ids = new Set(conceptParentIds(conceptId, includeProposed))
    return sortConceptsByName(activeConcepts.value.filter((concept) => ids.has(concept.id)))
  }

  function conceptChildren(conceptId: string, includeProposed = false): Concept[] {
    const ids = new Set(conceptChildIds(conceptId, includeProposed))
    return sortConceptsByName(activeConcepts.value.filter((concept) => ids.has(concept.id)))
  }

  /** Return all ancestors, nearest first, while tolerating malformed cycles. */
  function conceptAncestors(conceptId: string, includeProposed = false): Concept[] {
    const byId = new Map(activeConcepts.value.map((concept) => [concept.id, concept]))
    const queue = conceptParentIds(conceptId, includeProposed).map((id) => ({ id, distance: 1 }))
    const seen = new Set<string>()
    const found: Array<{ id: string; distance: number }> = []
    while (queue.length) {
      const current = queue.shift()!
      if (seen.has(current.id)) continue
      seen.add(current.id)
      if (byId.has(current.id)) found.push(current)
      conceptParentIds(current.id, includeProposed).forEach((parentId) => {
        if (!seen.has(parentId)) queue.push({ id: parentId, distance: current.distance + 1 })
      })
    }
    return found
      .sort((left, right) => left.distance - right.distance || (byId.get(left.id)?.name ?? '').localeCompare(byId.get(right.id)?.name ?? '', 'zh-CN'))
      .map(({ id }) => byId.get(id)!)
  }

  /** Return all descendants, nearest first, while tolerating malformed cycles. */
  function conceptDescendants(conceptId: string, includeProposed = false): Concept[] {
    const byId = new Map(activeConcepts.value.map((concept) => [concept.id, concept]))
    const queue = conceptChildIds(conceptId, includeProposed).map((id) => ({ id, distance: 1 }))
    const seen = new Set<string>()
    const found: Array<{ id: string; distance: number }> = []
    while (queue.length) {
      const current = queue.shift()!
      if (seen.has(current.id)) continue
      seen.add(current.id)
      if (byId.has(current.id)) found.push(current)
      conceptChildIds(current.id, includeProposed).forEach((childId) => {
        if (!seen.has(childId)) queue.push({ id: childId, distance: current.distance + 1 })
      })
    }
    return found
      .sort((left, right) => left.distance - right.distance || (byId.get(left.id)?.name ?? '').localeCompare(byId.get(right.id)?.name ?? '', 'zh-CN'))
      .map(({ id }) => byId.get(id)!)
  }

  function rootConcepts(includeProposed = false): Concept[] {
    const childIds = new Set(hierarchyRelations(includeProposed).map((relation) => relation.childConceptId))
    return sortConceptsByName(activeConcepts.value.filter((concept) => !childIds.has(concept.id)))
  }

  /** Ancestor path (root first) plus the requested Concept itself. */
  function conceptExpansionPath(conceptId: string, includeProposed = false): string[] {
    const path: string[] = []
    const visited = new Set<string>()
    const visiting = new Set<string>()
    const visit = (id: string): void => {
      if (visited.has(id) || visiting.has(id)) return
      visiting.add(id)
      conceptParentIds(id, includeProposed).sort().forEach((parentId) => visit(parentId))
      visiting.delete(id)
      visited.add(id)
      path.push(id)
    }
    if (activeConcepts.value.some((concept) => concept.id === conceptId)) visit(conceptId)
    return path
  }

  /**
   * Pure expansion-state helper for callers that keep the open-node set in
   * component state. Collapsing a Concept also collapses its entire subtree,
   * matching the progressive-disclosure interaction contract.
   */
  function toggleConceptExpansion(currentIds: string[], conceptId: string, expanded?: boolean, showProposed = false): string[] {
    if (!activeConcepts.value.some((concept) => concept.id === conceptId)) return currentIds.slice()
    return toggleExpandedConceptIds(currentIds, conceptId, relations.value, expanded, showProposed)
  }
  /**
   * Build the read-only catalog used by LLM prompts. The catalog is derived
   * from existing ConceptRelation/UnitConcept/Message rows; no graph schema
   * or persistent field is added for the disclosure protocol.
   */
  function promptDisclosureContext(options: { unitIds?: string[]; messageIds?: string[]; sessionIds?: string[]; includeFullContent?: boolean; includeConceptDetails?: boolean; includeMessageSummaries?: boolean; scopeConceptRoots?: boolean; auditPendingRefs?: boolean; expandedRefIds?: string[]; round?: number } = {}): DisclosureContext {
    const active = activeConcepts.value.slice().sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id))
    const activeIds = new Set(active.map((concept) => concept.id))
    const hierarchy = relations.value.filter((relation) =>
      relation.relationType === 'hierarchy' && relation.status !== 'rejected' && activeIds.has(relation.parentConceptId) && activeIds.has(relation.childConceptId),
    )
    const byParent = new Map<string, string[]>()
    const byChild = new Map<string, string[]>()
    hierarchy.forEach((relation) => {
      byParent.set(relation.parentConceptId, [...(byParent.get(relation.parentConceptId) ?? []), relation.childConceptId])
      byChild.set(relation.childConceptId, [...(byChild.get(relation.childConceptId) ?? []), relation.parentConceptId])
    })
    const conceptUnits = new Map<string, string[]>()
    unitConcepts.value.forEach((link) => {
      if (!activeIds.has(link.conceptId) || !units.value.some((unit) => unit.id === link.unitId)) return
      conceptUnits.set(link.conceptId, [...(conceptUnits.get(link.conceptId) ?? []), link.unitId])
    })
    const conceptSessions = new Map<string, string[]>()
    sessionConcepts.value.forEach((link) => {
      if (!activeIds.has(link.conceptId) || !activeSessionIds.value.has(link.sessionId)) return
      conceptSessions.set(link.conceptId, [...(conceptSessions.get(link.conceptId) ?? []), link.sessionId])
    })
    const conceptMessages = new Map<string, string[]>()
    messageConcepts.value.forEach((link) => {
      if (!activeIds.has(link.conceptId) || !messages.value.some((message) => message.id === link.messageId)) return
      conceptMessages.set(link.conceptId, [...(conceptMessages.get(link.conceptId) ?? []), link.messageId])
    })
    // Keep legacy metadata memberships visible even when an imported database
    // predates the v4 migration or contains an assignment not yet projected.
    messages.value.forEach((message) => {
      const declared = message.metadata?.concept_ids
      if (!Array.isArray(declared)) return
      declared.filter((id): id is string => typeof id === 'string' && activeIds.has(id.trim())).forEach((conceptId) => {
        const current = conceptMessages.get(conceptId.trim()) ?? []
        if (!current.includes(message.id)) conceptMessages.set(conceptId.trim(), [...current, message.id])
      })
    })
    const conceptSummary = (concept: Concept): string => {
      if (concept.summary?.trim()) return concept.summary.trim().replace(/\s+/g, ' ').slice(0, 240)
      if (concept.notes.trim()) return concept.notes.trim().replace(/\s+/g, ' ').slice(0, 240)
      const summaries = (conceptUnits.get(concept.id) ?? [])
        .map((id) => units.value.find((unit) => unit.id === id)?.summary?.trim())
        .filter(Boolean) as string[]
      const sessionSummaries = (conceptSessions.get(concept.id) ?? [])
        .map((id) => activeSessions.value.find((session) => session.id === id)?.knowledgeJudgment?.trim())
        .filter(Boolean) as string[]
      return [...summaries, ...sessionSummaries].slice(0, 2).join('；').slice(0, 240) || `关联 ${conceptUnits.get(concept.id)?.length ?? 0} 个知识单元、${conceptSessions.get(concept.id)?.length ?? 0} 个会话`
    }
    const conceptRef = (concept: Concept) => ({ refID: concept.id, title: `知识主题：${concept.name}`, summary: conceptSummary(concept) })
    const unitRef = (unit: KnowledgeUnit) => ({ refID: unit.id, title: `知识单元：${unit.title || '未命名知识单元'}`, summary: (unit.summary || '').replace(/\s+/g, ' ').slice(0, 240) })
    const sessionRef = (session: Session) => ({ refID: session.id, title: `会话：${session.title || '未命名会话'}`, summary: (session.summary || session.knowledgeJudgment || session.title || '').replace(/\s+/g, ' ').slice(0, 240) })
    const messageRef = (message: Message) => ({
      refID: message.id,
      title: `消息：${message.role} #${message.orderInSession + 1}`,
      summary: options.includeMessageSummaries === false
        ? `${message.role} 消息，展开后查看内容`
        : message.content.trim().replace(/\s+/g, ' ').slice(0, 240),
    })
    const messageEvidence = (message: Message) => {
      const linked = messageConcepts.value.filter((link) => link.messageId === message.id && activeIds.has(link.conceptId)).map((link) => link.conceptId)
      const declared = Array.isArray(message.metadata?.concept_ids)
        ? message.metadata.concept_ids.filter((id): id is string => typeof id === 'string' && activeIds.has(id))
        : []
      return {
        entity_type: 'message',
        id: message.id,
        session_id: message.sessionId,
        unit_id: message.unitId ?? null,
        role: message.role,
        order_in_session: message.orderInSession,
        content: message.content,
        concept_ids: [...new Set([...linked, ...declared])],
      }
    }

    const selectedUnitIds = [...new Set((options.unitIds ?? []).filter((id) => units.value.some((unit) => unit.id === id)))]
    const selectedMessageIds = [...new Set((options.messageIds ?? []).filter((id) => messages.value.some((message) => message.id === id)))]
    const selectedSessionIds = [...new Set((options.sessionIds ?? []).filter((id) => activeSessions.value.some((session) => session.id === id)))]
    const scoped = options.scopeConceptRoots !== false && (selectedUnitIds.length > 0 || selectedMessageIds.length > 0)
    // For a scoped task expose only the hierarchy roots that can reach one of
    // its selected units/messages. An unscoped task (origin extraction) gets
    // all roots, but never all descendants up front.
    const relevantConceptIds = new Set<string>()
    selectedUnitIds.forEach((unitId) => {
      unitConcepts.value.filter((link) => link.unitId === unitId).forEach((link) => relevantConceptIds.add(link.conceptId))
      const unit = units.value.find((item) => item.id === unitId)
      if (unit) sessionConcepts.value.filter((link) => link.sessionId === unit.sessionId).forEach((link) => relevantConceptIds.add(link.conceptId))
    })
    selectedMessageIds.forEach((messageId) => {
      const message = messages.value.find((item) => item.id === messageId)
      if (message?.unitId) unitConcepts.value.filter((link) => link.unitId === message.unitId).forEach((link) => relevantConceptIds.add(link.conceptId))
      if (message) sessionConcepts.value.filter((link) => link.sessionId === message.sessionId).forEach((link) => relevantConceptIds.add(link.conceptId))
      messageConcepts.value.filter((link) => link.messageId === messageId).forEach((link) => relevantConceptIds.add(link.conceptId))
      const declared = message?.metadata?.concept_ids
      if (Array.isArray(declared)) declared.filter((id): id is string => typeof id === 'string').forEach((id) => { if (activeIds.has(id)) relevantConceptIds.add(id) })
    })
    const queue = [...relevantConceptIds]
    while (queue.length) {
      const childId = queue.shift()!
      ;(byChild.get(childId) ?? []).forEach((parentId) => {
        if (relevantConceptIds.has(parentId)) return
        relevantConceptIds.add(parentId)
        queue.push(parentId)
      })
    }
    const rootItems = active.filter((concept) => !byChild.has(concept.id) && (!scoped || relevantConceptIds.has(concept.id)))
    const conceptRoots = rootItems.map(conceptRef)
    const sessionRoots = selectedSessionIds.map((id) => activeSessions.value.find((session) => session.id === id)).filter(Boolean).map((session) => sessionRef(session as Session))
    const unitRoots = selectedUnitIds.map((id) => units.value.find((unit) => unit.id === id)).filter(Boolean).map((unit) => unitRef(unit as KnowledgeUnit))
    const messageRoots = selectedMessageIds.map((id) => messages.value.find((message) => message.id === id)).filter(Boolean).map((message) => messageRef(message as Message))
    const roots = [...conceptRoots, ...sessionRoots, ...unitRoots, ...messageRoots]

    const unitExpansion = (item: KnowledgeUnit, revealContent = Boolean(options.includeFullContent)) => {
      const itemMessages = unitMessages(item.id)
      const children = itemMessages.map(messageRef)
      const content = revealContent
        ? JSON.stringify({
            unit: {
              entity_type: 'unit',
              id: item.id,
              session_id: item.sessionId,
              title: item.title ?? '',
              summary: item.summary ?? '',
              status: item.status,
              concept_ids: unitConcepts.value.filter((link) => link.unitId === item.id && activeIds.has(link.conceptId)).map((link) => link.conceptId),
              message_ids: itemMessages.map((message) => message.id),
            },
            messages: itemMessages.map(messageEvidence),
          })
        : undefined
      return { refID: item.id, children, ...(revealContent ? { content } : {}) }
    }
    const conceptExpansion = (concept: Concept) => {
      const childRefs = (byParent.get(concept.id) ?? [])
        .map((id) => active.find((item) => item.id === id))
        .filter(Boolean)
        .map((child) => conceptRef(child as Concept))
      const unitRefs = (conceptUnits.get(concept.id) ?? [])
        .map((id) => units.value.find((unit) => unit.id === id))
        .filter(Boolean)
        .map((unit) => unitRef(unit as KnowledgeUnit))
      const sessionRefs = (conceptSessions.get(concept.id) ?? [])
        .map((id) => activeSessions.value.find((session) => session.id === id))
        .filter(Boolean)
        .map((session) => sessionRef(session as Session))
      const messageRefs = (conceptMessages.get(concept.id) ?? [])
        .map((id) => messages.value.find((message) => message.id === id))
        .filter(Boolean)
        .map((message) => messageRef(message as Message))
      const seen = new Set<string>()
      const revealDetails = options.includeConceptDetails ?? Boolean(options.includeFullContent)
      const content = revealDetails
        ? JSON.stringify({
            concept: {
              entity_type: 'concept',
              id: concept.id,
              name: concept.name,
              summary: concept.summary ?? '',
              notes: concept.notes,
              aliases: aliases.value.filter((alias) => alias.conceptId === concept.id).map((alias) => ({ id: alias.id, alias: alias.alias })),
            },
            relations: relations.value
              .filter((relation) => relation.parentConceptId === concept.id || relation.childConceptId === concept.id)
              .map((relation) => ({ id: relation.id, sourceId: relation.parentConceptId, targetId: relation.childConceptId, type: relation.relationType, status: relation.status })),
            memberships: {
              session_ids: conceptSessions.get(concept.id) ?? [],
              unit_ids: conceptUnits.get(concept.id) ?? [],
              message_ids: conceptMessages.get(concept.id) ?? [],
            },
          })
        : undefined
      return {
        refID: concept.id,
        children: [...childRefs, ...sessionRefs, ...unitRefs, ...messageRefs].filter((reference) => !seen.has(reference.refID) && (seen.add(reference.refID), true)),
        ...(content ? { content } : {}),
      }
    }
    const sessionExpansion = (session: Session, revealContent = Boolean(options.includeFullContent)) => {
      const unassignedMessages = messages.value.filter((message) => message.sessionId === session.id && !message.unitId).sort((left, right) => left.orderInSession - right.orderInSession)
      const children = [
        ...units.value.filter((unit) => unit.sessionId === session.id).map(unitRef),
        ...unassignedMessages.map(messageRef),
      ]
      const content = revealContent
        ? JSON.stringify({
            session: {
              entity_type: 'session',
              id: session.id,
              title: session.title,
              summary: session.summary ?? '',
              knowledge_kind: session.knowledgeKind,
              knowledge_judgment: session.knowledgeJudgment ?? '',
              concept_ids: sessionConcepts.value.filter((link) => link.sessionId === session.id && activeIds.has(link.conceptId)).map((link) => link.conceptId),
            },
            unassigned_messages: unassignedMessages.map(messageEvidence),
          })
        : undefined
      return { refID: session.id, children, ...(revealContent ? { content } : {}) }
    }
    const messageExpansion = (message: Message) => ({
      refID: message.id,
      content: JSON.stringify({
        message: messageEvidence(message),
      }),
    })
    const expandedIds = [...new Set(options.expandedRefIds ?? [])]
    const expansionMap = new Map<string, NonNullable<DisclosureContext['expansions']>[number]>()
    // Explicitly selected full-content units/messages are already authorized
    // by the caller and can be revealed in the initial prompt.
    selectedUnitIds.forEach((id) => {
      if (options.includeFullContent) {
        const unit = units.value.find((item) => item.id === id)
        if (unit) expansionMap.set(id, unitExpansion(unit, true))
      }
    })
    selectedMessageIds.forEach((id) => {
      if (!options.includeFullContent) return
      const message = messages.value.find((item) => item.id === id)
      if (message) expansionMap.set(id, messageExpansion(message))
    })
    expandedIds.forEach((refID) => {
      const concept = active.find((item) => item.id === refID)
      if (concept) expansionMap.set(refID, conceptExpansion(concept))
      const unit = units.value.find((item) => item.id === refID)
      if (unit) expansionMap.set(refID, unitExpansion(unit))
      const session = activeSessions.value.find((item) => item.id === refID)
      if (session) expansionMap.set(refID, sessionExpansion(session))
      const message = messages.value.find((item) => item.id === refID)
      if (message && options.includeFullContent) expansionMap.set(refID, messageExpansion(message))
    })
    return {
      roots,
      expansions: [...expansionMap.values()],
      round: Number.isInteger(options.round) ? Math.max(0, options.round as number) : 0,
      ...(options.auditPendingRefs ? { auditPendingRefs: true } : {}),
    }
  }


  function createTask(task: Omit<LLMTask, 'id' | 'createdAt' | 'updatedAt' | 'retryCount'>): string {
    const id = createId('task')
    const now = isoNow()
    const status = normalizeTaskStatus(task.type, task.status)
    const errorMessage = status !== task.status ? LEGACY_SEGMENTATION_RETIRED_REASON : task.errorMessage ?? null
    const phase = task.phase ?? taskPhaseForStatus(status)
    db.run(
      `INSERT INTO llm_tasks(id, type, mode, provider_id, model, prompt_version, input_revision, prompt, response, parsed_result, validation_errors, status, phase, retry_count, error_message, created_at, updated_at, scope_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [id, task.type, task.mode, task.providerId ?? null, task.model ?? null, task.promptVersion, task.inputRevision, ensureHarnessPrompt(task.prompt), task.response ?? null, task.parsedResult ?? null, task.validationErrors ?? null, status, phase, errorMessage, now, now, task.scopeLabel ?? null],
    )
    return id
  }

  function createOriginConceptTasks(session: Session, sessionMessages: Message[]): string[] {
    const chunks = splitMessageChunks(sessionMessages, config.value.llm.tokenBudget)
    return chunks.map((chunk, chunkIndex) => {
      const chunkSuffix = chunks.length > 1 ? `:chunk:${chunk.start}:${chunk.end}:${chunks.length}` : ''
      return createTask({
        type: 'origin_concepts',
        mode: config.value.llm.mode ?? 'prompt_paste',
        providerId: config.value.llm.defaultProvider,
        model: null,
        promptVersion: PROMPT_VERSION,
        inputRevision: `${session.id}:${session.revision}${chunkSuffix}`,
        prompt: buildOriginConceptPrompt(
          session,
          chunk.messages,
          promptDisclosureContext(),
          chunks.length > 1 ? { index: chunkIndex + 1, total: chunks.length } : undefined,
          config.value.llm.conceptLimit,
        ),
        status: 'pending',
        scopeLabel: chunks.length > 1 ? `${session.title} · 起始知识主题 ${chunkIndex + 1}/${chunks.length}` : `${session.title} · 起始知识主题`,
      })
    })
  }

  function exportKnowledgeBase(): string {
    const payload = {
      export_version: 1 as const,
      exported_at: isoNow(),
      sessions: sessions.value,
      messages: messages.value,
      units: units.value,
      concepts: concepts.value,
      aliases: aliases.value,
      unit_concepts: unitConcepts.value,
      session_concepts: sessionConcepts.value,
      message_concepts: messageConcepts.value,
      relations: relations.value,
      nav_nodes: navNodes.value,
      nav_node_units: navNodeUnits.value,
      context_references: contextReferences.value,
      tasks: tasks.value.map((task) => ({ ...task, providerId: task.providerId ? task.providerId : null })),
      graph_layout: graphLayout.value,
      graph_viewport: graphViewport.value,
      manual_edges: manualEdges.value,
    }
    return JSON.stringify(payload, null, 2)
  }

  function importKnowledgeBase(raw: string): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error('知识库备份不是有效的 JSON')
    }
    if (parsed.export_version !== 1) throw new Error('只支持 export_version=1 的知识库备份')
    const requiredArrays = ['sessions', 'messages', 'units', 'concepts', 'aliases', 'unit_concepts', 'relations', 'nav_nodes', 'nav_node_units', 'context_references', 'tasks', 'manual_edges']
    requiredArrays.forEach((key) => { if (!Array.isArray(parsed[key])) throw new Error(`备份缺少数组字段：${key}`) })
    mutate(() => {
      const resetStatements = [
        'DELETE FROM context_references',
        'DELETE FROM nav_tree_node_units',
        'DELETE FROM nav_tree_nodes',
        'DELETE FROM manual_graph_edges',
        'DELETE FROM unit_concepts',
        'DELETE FROM session_concepts',
        'DELETE FROM message_concepts',
        'DELETE FROM concept_aliases',
        'DELETE FROM concept_relations',
        'DELETE FROM knowledge_units',
        'DELETE FROM messages',
        'DELETE FROM llm_tasks',
        'DELETE FROM sessions',
        'DELETE FROM concepts',
        'DELETE FROM graph_layout',
        'DELETE FROM graph_viewport',
        'DELETE FROM operation_log',
        'DELETE FROM search_documents',
      ] as const
      resetStatements.forEach((statement) => db.run(statement))
      const records = parsed as any
      records.sessions.forEach((item: Session) => db.run('INSERT INTO sessions(id, source, platform, model, external_session_id, title, summary, created_at, updated_at, message_count, unit_count, knowledge_kind, knowledge_confidence, knowledge_judgment, knowledge_retain_in_graph, revision, local_only, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.source, item.platform, item.model ?? null, item.externalSessionId ?? null, item.title, item.summary ?? '', item.createdAt, item.updatedAt, item.messageCount, item.unitCount, item.knowledgeKind ?? 'unknown', item.knowledgeConfidence ?? null, item.knowledgeJudgment ?? null, item.knowledgeRetainInGraph ? 1 : 0, item.revision, item.localOnly ? 1 : 0, item.deletedAt ?? null]))
      records.concepts.forEach((item: Concept) => db.run('INSERT INTO concepts(id, name, normalized_name, summary, notes, status, merged_into_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.name, item.normalizedName, item.summary ?? '', item.notes ?? '', item.status, item.mergedIntoId ?? null, item.createdAt, item.updatedAt, item.deletedAt ?? null]))
      records.units.forEach((item: KnowledgeUnit) => db.run('INSERT INTO knowledge_units(id, session_id, title, summary, order_in_session, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.sessionId, item.title ?? null, item.summary ?? null, item.orderInSession, item.status, item.revision, item.createdAt, item.updatedAt]))
      records.messages.forEach((item: Message) => db.run('INSERT INTO messages(id, session_id, unit_id, role, content, order_in_session, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.sessionId, item.unitId ?? null, item.role, item.content, item.orderInSession, item.timestamp ?? null, item.metadata ? JSON.stringify(item.metadata) : null]))
      records.aliases.forEach((item: ConceptAlias) => db.run('INSERT INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [item.id, item.conceptId, item.alias, item.normalizedAlias, item.source, item.createdAt]))
      records.unit_concepts.forEach((item: UnitConcept) => db.run('INSERT INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [item.unitId, item.conceptId, item.source, item.createdAt]))
      ;(Array.isArray(records.session_concepts) ? records.session_concepts : []).forEach((item: SessionConcept) => db.run('INSERT INTO session_concepts(session_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [item.sessionId, item.conceptId, item.source, item.createdAt]))
      ;(Array.isArray(records.message_concepts) ? records.message_concepts : []).forEach((item: MessageConcept) => db.run('INSERT INTO message_concepts(message_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [item.messageId, item.conceptId, item.source, item.createdAt]))
      records.relations.forEach((item: ConceptRelation) => db.run('INSERT INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.parentConceptId, item.childConceptId, item.relationType, item.source, item.status, item.createdAt, item.updatedAt]))
      records.nav_nodes.forEach((item: NavTreeNode) => db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.sessionId, item.parentId ?? null, item.triggerConceptId ?? null, item.label, item.depth, item.createdAt]))
      records.nav_node_units.forEach((item: NavTreeNodeUnit) => db.run('INSERT INTO nav_tree_node_units(node_id, unit_id, order_in_node) VALUES (?, ?, ?)', [item.nodeId, item.unitId, item.orderInNode]))
      records.context_references.forEach((item: ContextReference) => db.run('INSERT INTO context_references(id, target_session_id, source_session_id, source_unit_id, source_message_id, order_in_context, include_full_content) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.targetSessionId, item.sourceSessionId, item.sourceUnitId ?? null, item.sourceMessageId ?? null, item.orderInContext, item.includeFullContent ? 1 : 0]))
      records.tasks.forEach((item: LLMTask) => {
        const status = normalizeTaskStatus(item.type, item.status)
        const errorMessage = status !== item.status ? LEGACY_SEGMENTATION_RETIRED_REASON : item.errorMessage ?? null
        db.run('INSERT INTO llm_tasks(id, type, mode, provider_id, model, prompt_version, input_revision, prompt, response, parsed_result, validation_errors, status, phase, retry_count, error_message, created_at, updated_at, scope_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.type, item.mode, item.providerId ?? null, item.model ?? null, item.promptVersion, item.inputRevision, ensureHarnessPrompt(item.prompt), item.response ?? null, item.parsedResult ?? null, item.validationErrors ?? null, status, item.phase ?? taskPhaseForStatus(status), item.retryCount, errorMessage, item.createdAt, item.updatedAt, item.scopeLabel ?? null])
      })
      records.manual_edges.forEach((item: ManualGraphEdge) => db.run('INSERT INTO manual_graph_edges(id, source_type, source_ref_id, target_type, target_ref_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.sourceType, item.sourceRefId, item.targetType, item.targetRefId, item.label ?? null, item.createdAt]))
      if (Array.isArray(records.graph_layout)) records.graph_layout.forEach((item: GraphLayoutEntry) => db.run('INSERT INTO graph_layout(node_type, ref_id, x, y, fixed, layout_version) VALUES (?, ?, ?, ?, ?, ?)', [item.nodeType, item.refId, item.x, item.y, item.fixed ? 1 : 0, item.layoutVersion ?? 1]))
      if (records.graph_viewport && typeof records.graph_viewport === 'object') {
        const viewport = records.graph_viewport as GraphViewport
        db.run('INSERT INTO graph_viewport(id, x, y, scale, layout_version) VALUES (1, ?, ?, ?, ?)', [number(viewport.x, 0), number(viewport.y, 0), number(viewport.scale, 1), number(viewport.layoutVersion, 1)])
      }
    })
  }

  function importPayload(payload: ImportPayload, mode: 'skip' | 'replace' | 'new' = 'skip'): ImportReport {
    const parsed = importPayloadSchema.safeParse(payload)
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'))
    const report: ImportReport = { importedSessionIds: [], skippedSessionIds: [], changedSessionIds: [], issues: [], taskIds: [] }
    mutate(() => {
      payload.conversations.forEach((conversation, conversationIndex) => {
        const rawExternalId = conversation.external_session_id || conversation.session_id
        const contentFingerprint = stableHash(JSON.stringify({ title: conversation.title, messages: conversation.messages }))
        const externalId = rawExternalId || `fingerprint:${contentFingerprint}`
        const existing = db.query<Row>('SELECT * FROM sessions WHERE platform = ? AND external_session_id = ?', [payload.platform, externalId])[0]
        if (existing && mode === 'skip') {
          const existingMessages = db.query<Row>('SELECT role, content FROM messages WHERE session_id = ? ORDER BY order_in_session', [existing.id])
          const currentFingerprint = stableHash(JSON.stringify({ title: existing.title, messages: existingMessages.map((row) => ({ role: row.role, content: row.content })) }))
          if (currentFingerprint === contentFingerprint) report.skippedSessionIds.push(text(existing.id))
          else report.changedSessionIds.push(text(existing.id))
          return
        }
        const sessionId = mode === 'replace' && existing ? text(existing.id) : createId('session')
        const now = isoNow()
        if (mode === 'replace' && existing) {
          db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
        }
        const createdAt = parseIsoTimestamp(conversation.created_at) ?? now
        db.run(
          `INSERT INTO sessions(id, source, platform, model, external_session_id, title, created_at, updated_at, message_count, unit_count, revision, local_only)
           VALUES (?, 'chrome_import', ?, ?, ?, ?, ?, ?, ?, 0, 1, 0)`,
          [sessionId, payload.platform, conversation.model ?? null, externalId, conversation.title?.trim() || `未命名会话 ${conversationIndex + 1}`, createdAt, now, conversation.messages.length],
        )
        conversation.messages.forEach((message, index) => {
          const role = message.role === 'assistant' || message.role === 'system' ? message.role : 'user'
          const messageId = createId('message')
          db.run(
            'INSERT INTO messages(id, session_id, role, content, order_in_session, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [messageId, sessionId, role, message.content ?? '', index, parseIsoTimestamp(message.timestamp) ?? null, message.metadata ? JSON.stringify(message.metadata) : null],
          )
          const declared = message.metadata?.concept_ids
          if (Array.isArray(declared)) declared.filter((id): id is string => typeof id === 'string' && concepts.value.some((concept) => concept.id === id.trim())).forEach((conceptId) => {
            db.run('INSERT OR IGNORE INTO message_concepts(message_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [messageId, conceptId.trim(), 'import', now])
          })
        })
        const rootId = createId('nav')
        db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, NULL, NULL, ?, 0, ?)', [rootId, sessionId, conversation.title?.trim() || '起始对话', now])
        const session = sessionFromRow(db.query<Row>('SELECT * FROM sessions WHERE id = ?', [sessionId])[0])
        const importedMessages = db.query<Row>('SELECT * FROM messages WHERE session_id = ? ORDER BY order_in_session', [sessionId]).map(messageFromRow)
        const triageTaskId = createTask({
          type: 'session_triage',
          mode: config.value.llm.mode ?? 'prompt_paste',
          providerId: config.value.llm.defaultProvider,
          model: null,
          promptVersion: PROMPT_VERSION,
          inputRevision: `${session.id}:${session.revision}`,
          prompt: buildSessionTriagePrompt(session, importedMessages),
          status: 'pending',
          scopeLabel: `${session.title} · 会话分类`,
        })
        report.taskIds.push(triageTaskId)
        report.importedSessionIds.push(sessionId)
      })
    })
    lastImport.value = report
    return report
  }

  function importJsonText(raw: string): ImportReport {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('文件不是有效的 JSON')
    }
    const parsed = parseImportPayload(value)
    if (!parsed.data) throw new Error(parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'))
    return importPayload(parsed.data)
  }

  function importJsonTextWithMode(raw: string, mode: 'replace' | 'new' | 'skip'): ImportReport {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('文件不是有效的 JSON')
    }
    const parsed = parseImportPayload(value)
    if (!parsed.data) throw new Error(parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'))
    return importPayload(parsed.data, mode)
  }

  function updateUnit(unitId: string, updates: { title?: string; summary?: string }): void {
    const validationIssues = validateUnitText(updates.title, updates.summary)
    if (validationIssues.length) throw new Error(validationIssues.map((issue) => issue.message).join('；'))
    mutate(() => {
      const unit = units.value.find((item) => item.id === unitId)
      if (!unit) return
      const now = isoNow()
      db.run('UPDATE knowledge_units SET title = ?, summary = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [updates.title?.trim() || null, updates.summary?.trim() || null, 'ready', now, unitId])
      db.run('UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?', [now, unit.sessionId])
      tasks.value
        .filter((task) => task.inputRevision.startsWith(`${unitId}:`) && isActiveTaskStatus(task.status))
        .forEach((task) => transitionTaskInTransaction(task.id, 'invalidate'))
    })
  }

  /** Update the user-editable Concept title, summary and long-form notes. */
  function updateConcept(conceptId: string, updates: { name?: string; summary?: string; notes?: string }): void {
    const current = db.query<Row>('SELECT * FROM concepts WHERE id = ?', [conceptId])[0]
    if (!current) throw new Error('知识主题不存在')
    const nextName = updates.name === undefined ? text(current.name) : updates.name.trim()
    const normalizedName = normalizeText(nextName)
    if (!normalizedName) throw new Error('知识主题名称不能为空')
    if (nextName.length > 120) throw new Error('知识主题名称不能超过 120 个字符')
    const duplicate = db.query<Row>('SELECT id FROM concepts WHERE normalized_name = ? AND id <> ?', [normalizedName, conceptId])[0]
    const aliasOwner = db.query<Row>('SELECT concept_id FROM concept_aliases WHERE normalized_alias = ?', [normalizedName])[0]
    if (duplicate || (aliasOwner && text(aliasOwner.concept_id) !== conceptId)) throw new Error('已有同名知识主题或别名，请换一个名称')
    const nextSummary = updates.summary === undefined ? text(current.summary) : updates.summary.trim()
    const nextNotes = updates.notes === undefined ? text(current.notes) : updates.notes
    if (nextSummary.length > 120) throw new Error('知识主题摘要不能超过 120 个字符')
    if (nextName === text(current.name) && nextSummary === text(current.summary) && nextNotes === text(current.notes)) return

    const before = captureConceptOperationSnapshot()
    mutate(() => {
      db.run('DELETE FROM concept_aliases WHERE concept_id = ? AND normalized_alias = ?', [conceptId, normalizedName])
      db.run('UPDATE concepts SET name = ?, normalized_name = ?, summary = ?, notes = ?, updated_at = ? WHERE id = ?', [nextName, normalizedName, nextSummary, nextNotes, isoNow(), conceptId])
      recordOperation('编辑知识主题', before, captureConceptOperationSnapshot())
    })
  }

  function updateConceptNotes(conceptId: string, notes: string): void {
    updateConcept(conceptId, { notes })
  }

  function toggleSessionLocalOnly(sessionId: string, value: boolean): void {
    mutate(() => db.run('UPDATE sessions SET local_only = ?, updated_at = ? WHERE id = ?', [value ? 1 : 0, isoNow(), sessionId]))
  }

  function setUnitConcept(unitId: string, conceptId: string, linked: boolean): void {
    mutate(() => {
      if (linked) {
        const unit = units.value.find((item) => item.id === unitId)
        const concept = concepts.value.find((item) => item.id === conceptId && item.status === 'active')
        if (!unit || !concept) throw new Error('知识单元或知识主题不存在')
        const belongsToUnitSession = messages.value.some((message) => message.unitId === unitId && message.sessionId === unit.sessionId)
        if (!belongsToUnitSession) throw new Error('关联的知识单元不属于当前会话')
        db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unitId, conceptId, 'manual', isoNow()])
      } else {
        db.run('DELETE FROM unit_concepts WHERE unit_id = ? AND concept_id = ?', [unitId, conceptId])
      }
    })
  }

  function ensureConcept(name: string, source: 'manual' | 'llm' = 'manual'): string {
    const normalized = normalizeText(name)
    if (!normalized) throw new Error('Concept 名称不能为空')
    const existing = db.query<Row>('SELECT id, status, merged_into_id FROM concepts WHERE normalized_name = ? OR id IN (SELECT concept_id FROM concept_aliases WHERE normalized_alias = ?)', [normalized, normalized])[0]
    if (existing) {
      const mergedIntoId = existing.merged_into_id == null ? '' : text(existing.merged_into_id)
      if (text(existing.status) === 'merged' && mergedIntoId) return mergedIntoId
      if (text(existing.status) === 'archived') db.run("UPDATE concepts SET status = 'active', deleted_at = NULL, updated_at = ? WHERE id = ?", [isoNow(), text(existing.id)])
      return text(existing.id)
    }
    const id = createId('concept')
    const now = isoNow()
    db.run('INSERT INTO concepts(id, name, normalized_name, summary, notes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, name.trim(), normalized, '', '', 'active', now, now])
    void source
    return id
  }

  /** Create (or reactivate) a manually maintained Concept and return its id. */
  function createConcept(name: string, notes = '', summary = ''): string {
    const trimmed = name.trim()
    const normalized = normalizeText(trimmed)
    if (!normalized) throw new Error('知识主题名称不能为空')
    if (trimmed.length > 120) throw new Error('知识主题名称不能超过 120 个字符')

    const existing = db.query<Row>('SELECT id, status, summary, notes FROM concepts WHERE normalized_name = ?', [normalized])[0]
    if (existing && text(existing.status) === 'active') return text(existing.id)

    const before = captureConceptOperationSnapshot()
    let conceptId = ''
    mutate(() => {
      conceptId = ensureConcept(trimmed)
      if (notes.trim() || summary.trim()) db.run('UPDATE concepts SET summary = ?, notes = ?, updated_at = ? WHERE id = ?', [summary.trim(), notes, isoNow(), conceptId])
      recordOperation('创建知识主题', before, captureConceptOperationSnapshot())
    })
    return conceptId
  }

  function addConceptToUnit(unitId: string, name: string): string {
    let conceptId = ''
    mutate(() => {
      const unit = units.value.find((item) => item.id === unitId)
      if (!unit) throw new Error('知识单元不存在')
      conceptId = ensureConcept(name)
      db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unitId, conceptId, 'manual', isoNow()])
    })
    return conceptId
  }

  function setMessageConcept(messageId: string, conceptId: string, linked: boolean): void {
    mutate(() => {
      const message = messages.value.find((item) => item.id === messageId)
      const concept = concepts.value.find((item) => item.id === conceptId && item.status === 'active')
      if (!message || !concept) throw new Error('消息或知识主题不存在')
      if (linked) db.run('INSERT OR IGNORE INTO message_concepts(message_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [messageId, conceptId, 'manual', isoNow()])
      else db.run('DELETE FROM message_concepts WHERE message_id = ? AND concept_id = ?', [messageId, conceptId])
      const metadata = parseMetadata(message.metadata)
      const current = Array.isArray(metadata.concept_ids) ? metadata.concept_ids.filter((id): id is string => typeof id === 'string') : []
      const next = linked ? [...new Set([...current, conceptId])] : current.filter((id) => id !== conceptId)
      if (next.length) metadata.concept_ids = next
      else delete metadata.concept_ids
      db.run('UPDATE messages SET metadata = ? WHERE id = ?', [Object.keys(metadata).length ? JSON.stringify(metadata) : null, messageId])
    })
  }

  function setSessionConcept(sessionId: string, conceptId: string, linked: boolean): void {
    mutate(() => {
      const session = sessions.value.find((item) => item.id === sessionId)
      const concept = concepts.value.find((item) => item.id === conceptId && item.status === 'active')
      if (!session || !concept) throw new Error('会话或知识主题不存在')
      if (linked) db.run('INSERT OR IGNORE INTO session_concepts(session_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [sessionId, conceptId, 'manual', isoNow()])
      else db.run('DELETE FROM session_concepts WHERE session_id = ? AND concept_id = ?', [sessionId, conceptId])
    })
  }

  function addManualGraphEdge(sourceType: ManualGraphEdge['sourceType'], sourceRefId: string, targetType: ManualGraphEdge['targetType'], targetRefId: string, label?: string): string {
    if (sourceType === targetType && sourceRefId === targetRefId) throw new Error('不能建立自环边')
    const id = createId('edge')
    mutate(() => {
      db.run('INSERT INTO manual_graph_edges(id, source_type, source_ref_id, target_type, target_ref_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, sourceType, sourceRefId, targetType, targetRefId, label?.trim() || null, isoNow()])
    })
    return id
  }

  function removeManualGraphEdge(edgeId: string): void {
    mutate(() => db.run('DELETE FROM manual_graph_edges WHERE id = ?', [edgeId]))
  }

  function captureConceptOperationSnapshot(): string {
    return JSON.stringify({
      concepts: db.query<Row>('SELECT * FROM concepts'),
      aliases: db.query<Row>('SELECT * FROM concept_aliases'),
      unit_concepts: db.query<Row>('SELECT * FROM unit_concepts'),
      session_concepts: db.query<Row>('SELECT * FROM session_concepts'),
      message_concepts: db.query<Row>('SELECT * FROM message_concepts'),
      relations: db.query<Row>('SELECT * FROM concept_relations'),
      manual_edges: db.query<Row>('SELECT * FROM manual_graph_edges'),
      graph_layout: db.query<Row>('SELECT * FROM graph_layout'),
      message_metadata: db.query<Row>('SELECT id, metadata FROM messages'),
      knowledge_units: db.query<Row>('SELECT * FROM knowledge_units'),
      sessions: db.query<Row>('SELECT id, revision, updated_at FROM sessions'),
      tasks: db.query<Row>('SELECT id, parsed_result, updated_at FROM llm_tasks'),
    })
  }

  function restoreConceptOperationSnapshot(snapshotText: string): void {
    const snapshot = JSON.parse(snapshotText) as {
      concepts: Row[]
      aliases: Row[]
      unit_concepts: Row[]
      session_concepts?: Row[]
      message_concepts?: Row[]
      relations: Row[]
      manual_edges: Row[]
      graph_layout: Row[]
      message_metadata?: Row[]
      knowledge_units?: Row[]
      sessions?: Row[]
      tasks?: Row[]
    }
    db.run('DELETE FROM unit_concepts')
    db.run('DELETE FROM session_concepts')
    db.run('DELETE FROM message_concepts')
    db.run('DELETE FROM concept_aliases')
    db.run('DELETE FROM concept_relations')
    db.run('DELETE FROM manual_graph_edges')
    db.run('DELETE FROM graph_layout')
    db.run('DELETE FROM concepts')
    snapshot.concepts.forEach((row) => db.run('INSERT INTO concepts(id, name, normalized_name, summary, notes, status, merged_into_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [text(row.id), text(row.name), text(row.normalized_name), text(row.summary), text(row.notes), text(row.status), row.merged_into_id ?? null, text(row.created_at), text(row.updated_at), row.deleted_at ?? null]))
    snapshot.aliases.forEach((row) => db.run('INSERT INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [text(row.id), text(row.concept_id), text(row.alias), text(row.normalized_alias), text(row.source), text(row.created_at)]))
    snapshot.unit_concepts.forEach((row) => db.run('INSERT INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [text(row.unit_id), text(row.concept_id), text(row.source), text(row.created_at)]))
    snapshot.session_concepts?.forEach((row) => db.run('INSERT INTO session_concepts(session_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [text(row.session_id), text(row.concept_id), text(row.source), text(row.created_at)]))
    snapshot.message_concepts?.forEach((row) => db.run('INSERT INTO message_concepts(message_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [text(row.message_id), text(row.concept_id), text(row.source), text(row.created_at)]))
    snapshot.relations.forEach((row) => db.run('INSERT INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [text(row.id), text(row.parent_concept_id), text(row.child_concept_id), text(row.relation_type), text(row.source), text(row.status), text(row.created_at), text(row.updated_at)]))
    snapshot.manual_edges.forEach((row) => db.run('INSERT INTO manual_graph_edges(id, source_type, source_ref_id, target_type, target_ref_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [text(row.id), text(row.source_type), text(row.source_ref_id), text(row.target_type), text(row.target_ref_id), row.label ?? null, text(row.created_at)]))
    snapshot.graph_layout.forEach((row) => db.run('INSERT INTO graph_layout(node_type, ref_id, x, y, fixed, layout_version) VALUES (?, ?, ?, ?, ?, ?)', [text(row.node_type), text(row.ref_id), number(row.x), number(row.y), bool(row.fixed) ? 1 : 0, number(row.layout_version, 1)]))
    snapshot.message_metadata?.forEach((row) => db.run('UPDATE messages SET metadata = ? WHERE id = ?', [row.metadata ?? null, text(row.id)]))
    snapshot.knowledge_units?.forEach((row) => db.run('UPDATE knowledge_units SET title = ?, summary = ?, order_in_session = ?, status = ?, revision = ?, updated_at = ? WHERE id = ?', [row.title ?? null, row.summary ?? null, number(row.order_in_session), text(row.status), number(row.revision, 1), text(row.updated_at), text(row.id)]))
    snapshot.sessions?.forEach((row) => db.run('UPDATE sessions SET revision = ?, updated_at = ? WHERE id = ?', [number(row.revision, 1), text(row.updated_at), text(row.id)]))
    snapshot.tasks?.forEach((row) => db.run('UPDATE llm_tasks SET parsed_result = ?, updated_at = ? WHERE id = ?', [row.parsed_result ?? null, text(row.updated_at), text(row.id)]))
  }

  function recordOperation(action: string, beforeJson: string, afterJson: string): void {
    db.run('INSERT INTO operation_log(id, action, before_json, after_json, created_at, undone_at) VALUES (?, ?, ?, ?, ?, NULL)', [createId('operation'), action, beforeJson, afterJson, isoNow()])
  }

  function undoOperation(operationId?: string): void {
    const operation = operationLogs.value.find((item) => item.id === operationId) ?? operationLogs.value.find((item) => !item.undoneAt)
    if (!operation || operation.undoneAt) throw new Error('没有可撤销的操作')
    mutate(() => {
      restoreConceptOperationSnapshot(operation.beforeJson)
      db.run('UPDATE operation_log SET undone_at = ? WHERE id = ?', [isoNow(), operation.id])
    })
  }

  function createRelation(parentId: string, childId: string, relationType: ConceptRelation['relationType'], status: ConceptRelation['status'] = 'confirmed'): void {
    if (relationType === 'hierarchy' && wouldCreateHierarchyCycle(parentId, childId, relations.value)) throw new Error('这个父子关系会形成环，无法建立')
    const [sourceId, targetId] = relationType === 'related' && parentId > childId ? [childId, parentId] : [parentId, childId]
    const before = captureConceptOperationSnapshot()
    mutate(() => {
      const now = isoNow()
      db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [createId('relation'), sourceId, targetId, relationType, status === 'confirmed' ? 'manual' : 'llm', status, now, now])
      recordOperation('建立知识主题关系', before, captureConceptOperationSnapshot())
    })
  }

  /**
   * Set one hierarchy parent for a Concept. Existing parents are preserved by
   * default because the domain permits a multi-parent DAG; pass
   * `replaceExisting=true` when an editor explicitly wants a single parent.
   */
  function setConceptParent(
    childId: string,
    parentId: string | null,
    options: { replaceExisting?: boolean; status?: 'confirmed' | 'proposed' } = {},
  ): void {
    const child = activeConcepts.value.find((concept) => concept.id === childId)
    if (!child) throw new Error('找不到子知识主题')
    if (parentId != null && !activeConcepts.value.some((concept) => concept.id === parentId)) throw new Error('找不到父知识主题')
    if (parentId === childId) throw new Error('不能将知识主题设置为自身的父主题')
    if (parentId != null && wouldCreateHierarchyCycle(parentId, childId, relations.value)) throw new Error('这个父子关系会形成环，无法建立')
    const before = captureConceptOperationSnapshot()
    mutate(() => {
      const now = isoNow()
      if (options.replaceExisting || parentId == null) {
        db.run('DELETE FROM concept_relations WHERE child_concept_id = ? AND relation_type = \'hierarchy\'', [childId])
      }
      if (parentId != null) {
        const status = options.status ?? 'confirmed'
        db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, \'hierarchy\', ?, ?, ?, ?)', [createId('relation'), parentId, childId, status === 'confirmed' ? 'manual' : 'llm', status, now, now])
      }
      recordOperation(parentId == null ? '提升知识主题层级' : '设置知识主题父级', before, captureConceptOperationSnapshot())
    })
  }

  /** Add a hierarchy edge while retaining any other valid parent edges. */
  function addConceptChild(parentId: string, childId: string, status: 'confirmed' | 'proposed' = 'confirmed'): void {
    createRelation(parentId, childId, 'hierarchy', status)
  }

  /**
   * Promote a child to the level above its selected parent. This removes only
   * the hierarchy reference, never the Concept or its descendants. Omitting
   * `parentId` removes all hierarchy parents and makes the Concept a root.
   */
  function promoteConcept(childId: string, parentId?: string): void {
    if (!activeConcepts.value.some((concept) => concept.id === childId)) throw new Error('找不到要提升的知识主题')
    const before = captureConceptOperationSnapshot()
    mutate(() => {
      if (parentId) db.run('DELETE FROM concept_relations WHERE parent_concept_id = ? AND child_concept_id = ? AND relation_type = \'hierarchy\'', [parentId, childId])
      else db.run('DELETE FROM concept_relations WHERE child_concept_id = ? AND relation_type = \'hierarchy\'', [childId])
      recordOperation('提升知识主题层级', before, captureConceptOperationSnapshot())
    })
  }

  /** Alias used by detail editors when removing a child reference. */
  function removeConceptFromParent(parentId: string, childId: string): void {
    promoteConcept(childId, parentId)
  }

  function confirmRelation(relationId: string, status: 'confirmed' | 'rejected'): void {
    const before = captureConceptOperationSnapshot()
    mutate(() => {
      db.run('UPDATE concept_relations SET status = ?, updated_at = ? WHERE id = ?', [status, isoNow(), relationId])
      recordOperation(status === 'confirmed' ? '确认知识主题关系' : '拒绝知识主题关系', before, captureConceptOperationSnapshot())
    })
  }

  function deleteRelation(relationId: string): void {
    const before = captureConceptOperationSnapshot()
    mutate(() => {
      db.run('DELETE FROM concept_relations WHERE id = ?', [relationId])
      recordOperation('删除知识主题关系', before, captureConceptOperationSnapshot())
    })
  }

  /**
   * Move a hierarchy child up one level. Every active parent of the current
   * parent is connected to the child, then the original edge is removed. A
   * root child simply becomes a root when the selected edge is removed. The
   * operation is intentionally atomic and undoable.
   *
   * The optional child id is accepted as a convenience for callers that have
   * endpoints rather than a relation id; the relation id form is preferred.
   */
  function promoteConceptChild(relationOrParentId: string, childId?: string): void {
    const relation = relations.value.find((item) => item.relationType === 'hierarchy'
      && item.status !== 'rejected'
      && (item.id === relationOrParentId
        || (item.parentConceptId === relationOrParentId && item.childConceptId === childId)))
    if (!relation) throw new Error('找不到需要提升的父子关系')

    const remaining = relations.value.filter((item) => item.id !== relation.id)
    const grandParents = remaining
      .filter((item) => item.relationType === 'hierarchy' && item.status !== 'rejected' && item.childConceptId === relation.parentConceptId)
      .map((item) => item.parentConceptId)
      .filter((id, index, all) => all.indexOf(id) === index)
    const promotedRelations = grandParents.filter((parentId) => !wouldCreateHierarchyCycle(parentId, relation.childConceptId, remaining))
    if (grandParents.length !== promotedRelations.length) throw new Error('提升后会形成层级环，操作已取消')

    const before = captureConceptOperationSnapshot()
    mutate(() => {
      const now = isoNow()
      db.run('DELETE FROM concept_relations WHERE id = ?', [relation.id])
      promotedRelations.forEach((parentId) => {
        db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [createId('relation'), parentId, relation.childConceptId, 'hierarchy', 'manual', 'confirmed', now, now])
      })
      recordOperation('提升知识主题层级', before, captureConceptOperationSnapshot())
    })
  }

  function mergeConcept(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return
    const before = captureConceptOperationSnapshot()
    mutate(() => {
      const now = isoNow()
      mergeConceptRecords(sourceId, targetId, now)
      recordOperation('合并知识主题', before, captureConceptOperationSnapshot())
    })
  }

  /** Merge every user-visible relation carried by a Concept in one transaction. */
  function mergeConceptRecords(sourceId: string, targetId: string, now = isoNow()): void {
    if (sourceId === targetId) throw new Error('不能将知识主题合并到自身')
    const source = db.query<Row>('SELECT * FROM concepts WHERE id = ?', [sourceId])[0]
    const target = db.query<Row>('SELECT * FROM concepts WHERE id = ?', [targetId])[0]
    if (!source || !target) throw new Error('找不到需要合并的知识主题')
    if (text(source.status) === 'merged' && text(source.merged_into_id) === targetId) return

    const sourceName = text(source.name)
    const sourceAliases = db.query<Row>('SELECT * FROM concept_aliases WHERE concept_id = ?', [sourceId])
    db.run('INSERT OR IGNORE INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('alias'), targetId, sourceName, normalizeText(sourceName), 'merge', now])
    sourceAliases.forEach((alias) => {
      db.run('INSERT OR IGNORE INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('alias'), targetId, text(alias.alias), text(alias.normalized_alias), 'merge', text(alias.created_at) || now])
    })
    db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) SELECT unit_id, ?, ?, created_at FROM unit_concepts WHERE concept_id = ?', [targetId, 'merge', sourceId])
    db.run('DELETE FROM unit_concepts WHERE concept_id = ?', [sourceId])
    db.run('INSERT OR IGNORE INTO session_concepts(session_id, concept_id, source, created_at) SELECT session_id, ?, ?, created_at FROM session_concepts WHERE concept_id = ?', [targetId, 'merge', sourceId])
    db.run('DELETE FROM session_concepts WHERE concept_id = ?', [sourceId])
    db.run('INSERT OR IGNORE INTO message_concepts(message_id, concept_id, source, created_at) SELECT message_id, ?, ?, created_at FROM message_concepts WHERE concept_id = ?', [targetId, 'merge', sourceId])
    db.run('DELETE FROM message_concepts WHERE concept_id = ?', [sourceId])
    db.query<Row>('SELECT id, metadata FROM messages WHERE metadata IS NOT NULL').forEach((row) => {
      const metadata = parseMetadata(row.metadata)
      if (!Array.isArray(metadata.concept_ids) || !metadata.concept_ids.includes(sourceId)) return
      metadata.concept_ids = [...new Set(metadata.concept_ids.map((id) => id === sourceId ? targetId : id).filter((id): id is string => typeof id === 'string'))]
      db.run('UPDATE messages SET metadata = ? WHERE id = ?', [JSON.stringify(metadata), text(row.id)])
    })

    const sourceRelations = db.query<Row>('SELECT * FROM concept_relations WHERE parent_concept_id = ? OR child_concept_id = ?', [sourceId, sourceId])
    sourceRelations.forEach((relation) => {
      const parentId = text(relation.parent_concept_id) === sourceId ? targetId : text(relation.parent_concept_id)
      const childId = text(relation.child_concept_id) === sourceId ? targetId : text(relation.child_concept_id)
      if (parentId === childId) return
      db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [createId('relation'), parentId, childId, text(relation.relation_type), text(relation.source), text(relation.status), text(relation.created_at) || now, now])
    })
    db.run('DELETE FROM concept_relations WHERE parent_concept_id = ? OR child_concept_id = ?', [sourceId, sourceId])

    const sourceEdges = db.query<Row>('SELECT * FROM manual_graph_edges WHERE (source_type = ? AND source_ref_id = ?) OR (target_type = ? AND target_ref_id = ?)', ['concept', sourceId, 'concept', sourceId])
    sourceEdges.forEach((edge) => {
      const sourceType = text(edge.source_type)
      const targetType = text(edge.target_type)
      const edgeSource = sourceType === 'concept' && text(edge.source_ref_id) === sourceId ? targetId : text(edge.source_ref_id)
      const edgeTarget = targetType === 'concept' && text(edge.target_ref_id) === sourceId ? targetId : text(edge.target_ref_id)
      if (sourceType === targetType && edgeSource === edgeTarget) return
      const duplicate = db.query<Row>('SELECT id FROM manual_graph_edges WHERE source_type = ? AND source_ref_id = ? AND target_type = ? AND target_ref_id = ? LIMIT 1', [sourceType, edgeSource, targetType, edgeTarget])[0]
      if (!duplicate) db.run('INSERT INTO manual_graph_edges(id, source_type, source_ref_id, target_type, target_ref_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [createId('edge'), sourceType, edgeSource, targetType, edgeTarget, edge.label ?? null, text(edge.created_at) || now])
    })
    db.run("DELETE FROM manual_graph_edges WHERE (source_type = 'concept' AND source_ref_id = ?) OR (target_type = 'concept' AND target_ref_id = ?)", [sourceId, sourceId])
    db.run('UPDATE nav_tree_nodes SET trigger_concept_id = ? WHERE trigger_concept_id = ?', [targetId, sourceId])
    db.run('INSERT OR IGNORE INTO graph_layout(node_type, ref_id, x, y, fixed, layout_version) SELECT node_type, ?, x, y, fixed, layout_version FROM graph_layout WHERE node_type = ? AND ref_id = ?', [targetId, 'concept', sourceId])
    db.run('DELETE FROM graph_layout WHERE node_type = ? AND ref_id = ?', ['concept', sourceId])

    const mergedSummary = [text(target.summary), text(source.summary)].filter(Boolean).join('；').slice(0, 120)
    const mergedNotes = [text(target.notes), text(source.notes) ? `来自 ${sourceName} 的笔记：${text(source.notes)}` : ''].filter(Boolean).join('\n\n')
    db.run('UPDATE concepts SET summary = ?, notes = ?, updated_at = ? WHERE id = ?', [mergedSummary, mergedNotes, now, targetId])
    db.run('UPDATE concepts SET status = ?, merged_into_id = ?, deleted_at = ?, updated_at = ? WHERE id = ?', ['merged', targetId, now, now, sourceId])
  }

  function deleteConcept(conceptId: string): void {
    const before = captureConceptOperationSnapshot()
    mutate(() => {
      const now = isoNow()
      db.run('UPDATE concepts SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?', ['archived', now, now, conceptId])
      recordOperation('归档知识主题', before, captureConceptOperationSnapshot())
    })
  }

  function restoreConcept(conceptId: string): void {
    const before = captureConceptOperationSnapshot()
    mutate(() => {
      db.run('UPDATE concepts SET status = ?, deleted_at = NULL, merged_into_id = NULL, updated_at = ? WHERE id = ?', ['active', isoNow(), conceptId])
      recordOperation('恢复知识主题', before, captureConceptOperationSnapshot())
    })
  }

  function markTask(taskId: string, status: LLMTask['status'], response?: string, errors?: string[]): void {
    const event: TaskTransitionEvent = status === 'needs_review'
      ? 'reject_validation'
      : status === 'failed'
        ? 'fail_transport'
        : status === 'stale'
          ? 'invalidate'
          : status === 'cancelled'
            ? 'cancel'
            : status === 'pending'
              ? 'retry'
              : 'accept_validated_result'
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task) return
    if (!canTransitionTaskStatus(task.status, status) || (task.status !== status && !canTransitionTask(task.status, event))) return
    // Keep the current disclosure catalog in a repair prompt so a user can
    // correct an invalid response without losing the IDs they were shown.
    const disclosure = status === 'needs_review' && response ? parseDisclosureContext(task.prompt) : null
    const nextPrompt = status === 'needs_review' && response ? buildRepairPrompt(response, errors ?? [], disclosure ?? undefined, task.prompt) : task.prompt
    transitionTask(taskId, event, {
      ...(response !== undefined ? { response } : {}),
      validationErrors: errors ?? null,
      errorMessage: errors?.[0] ?? null,
      prompt: nextPrompt,
      retryCountDelta: status === 'failed' || status === 'needs_review' ? 1 : 0,
    })
  }

  function parseStructuredResponse(responseText: string): { data?: Record<string, unknown>; error?: string } {
    let value: unknown
    try {
      value = JSON.parse(responseText)
    } catch {
      const match = responseText.match(/\{[\s\S]*\}/)
      if (!match) return { error: '响应不是有效 JSON' }
      try {
        value = JSON.parse(match[0])
      } catch {
        return { error: '无法从响应中解析 JSON' }
      }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: '响应必须是 JSON 对象' }
    return { data: value as Record<string, unknown> }
  }

  function promptConceptIds(task: LLMTask): Set<string> {
    const context = parseDisclosureContext(task.prompt)
    if (!context) return new Set()
    const activeIds = new Set(activeConcepts.value.map((concept) => concept.id))
    return new Set([...listedDisclosureRefIds(context)].filter((id) => activeIds.has(id)))
  }

  function promptConceptCatalog(task: LLMTask): Array<{ id: string; name: string; aliases: string[] }> {
    const ids = promptConceptIds(task)
    return activeConcepts.value
      .filter((concept) => ids.has(concept.id))
      .map((concept) => ({
        id: concept.id,
        name: concept.name,
        aliases: aliases.value.filter((alias) => alias.conceptId === concept.id).map((alias) => alias.alias),
      }))
  }

  function validateConceptMembershipPayload(
    task: LLMTask,
    data: Record<string, unknown>,
    targetIds: Iterable<string>,
    conceptIds = promptConceptIds(task),
  ): string[] {
    const issues = [
      ...validateConceptIdList(data.concept_ids, conceptIds).map((issue) => `${issue.path}: ${issue.message}`),
      ...validateConceptMemberships(data.memberships, { targetIds, conceptIds }).map((issue) => `${issue.path}: ${issue.message}`),
    ]
    if (Object.prototype.hasOwnProperty.call(data, 'concept_id')) issues.push('concept_id: 归属必须使用 concept_ids 数组，不能使用单个 concept_id')
    return issues
  }

  function taskChunkBounds(task: LLMTask): { start: number; end: number; total: number } | null {
    const parts = task.inputRevision.split(':')
    if (parts[2] !== 'chunk') return null
    const start = Number(parts[3])
    const end = Number(parts[4])
    const total = Number(parts[5])
    if (![start, end, total].every(Number.isInteger) || start < 0 || end <= start || total < 2) return null
    return { start, end, total }
  }

  function taskSessionMessages(task: LLMTask, sessionId: string): Message[] {
    const sessionMessages = messages.value
      .filter((message) => message.sessionId === sessionId)
      .sort((left, right) => left.orderInSession - right.orderInSession)
    const chunk = taskChunkBounds(task)
    return chunk ? sessionMessages.slice(chunk.start, chunk.end) : sessionMessages
  }

  /** Persist multi-membership declarations in exact join tables. Metadata is
   * still mirrored for backwards compatibility with pre-v4 databases and
   * segmentation imports that already know how to carry those IDs forward. */
  function persistConceptMemberships(
    memberships: unknown,
    now: string,
    resolveConceptId: (ref: string) => string | null = (ref) => ref,
    mirrorMessageToUnit = true,
  ): void {
    if (!Array.isArray(memberships)) return
    memberships.forEach((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
      const item = raw as Record<string, unknown>
      const targetType = item.target_type
      const targetId = typeof item.target_id === 'string' ? item.target_id : ''
      const ids = Array.isArray(item.concept_ids)
        ? item.concept_ids
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map((id) => resolveConceptId(id.trim()))
          .filter((id): id is string => Boolean(id))
        : []
      if (!targetId || !ids.length) return
      const addToUnit = (unitId: string): void => ids.forEach((conceptId) => db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unitId, conceptId, 'llm', now]))
      const addToMessage = (messageId: string): void => ids.forEach((conceptId) => db.run('INSERT OR IGNORE INTO message_concepts(message_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [messageId, conceptId, 'llm', now]))
      if (targetType === 'unit') {
        addToUnit(targetId)
      } else if (targetType === 'message') {
        const messageRow = db.query<Row>('SELECT unit_id, metadata FROM messages WHERE id = ?', [targetId])[0]
        if (!messageRow) return
        addToMessage(targetId)
        const unitId = messageRow.unit_id == null ? '' : text(messageRow.unit_id)
        if (mirrorMessageToUnit && unitId) addToUnit(unitId)
        let metadata: Record<string, unknown> = {}
        try { metadata = messageRow.metadata ? JSON.parse(text(messageRow.metadata)) as Record<string, unknown> : {} } catch { metadata = {} }
        const current = Array.isArray(metadata.concept_ids) ? metadata.concept_ids.filter((id): id is string => typeof id === 'string') : []
        metadata.concept_ids = [...new Set([...current, ...ids])]
        db.run('UPDATE messages SET metadata = ? WHERE id = ?', [JSON.stringify(metadata), targetId])
      } else if (targetType === 'session') {
        ids.forEach((conceptId) => db.run('INSERT OR IGNORE INTO session_concepts(session_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [targetId, conceptId, 'llm', now]))
      }
    })
  }

  /**
   * Persist LLM relation suggestions without granting them confirmation
   * authority. Validation has already limited refs to the current prompt and
   * response-local client refs; this final guard also tolerates legacy task
   * shapes while preventing duplicate, cyclic, or user-owned replacements.
   */
  function persistProposedConceptRelations(
    rawRelations: unknown,
    now: string,
    resolveConceptRef: (ref: string) => string | null,
  ): void {
    if (!Array.isArray(rawRelations)) return
    const pendingRelations: ConceptRelation[] = []
    const relationKeys = new Set<string>(relations.value.map((relation) => {
      const pair = relation.relationType === 'related'
        ? [relation.parentConceptId, relation.childConceptId].sort().join('|')
        : `${relation.parentConceptId}|${relation.childConceptId}`
      return `${relation.relationType}:${pair}`
    }))

    rawRelations.forEach((rawRelation) => {
      if (!rawRelation || typeof rawRelation !== 'object' || Array.isArray(rawRelation)) return
      const value = rawRelation as Record<string, unknown>
      const sourceRef = typeof value.source === 'string' ? value.source
        : typeof value.parent === 'string' ? value.parent
          : typeof value.source_name === 'string' ? value.source_name
            : typeof value.parent_name === 'string' ? value.parent_name : ''
      const targetRef = typeof value.target === 'string' ? value.target
        : typeof value.child === 'string' ? value.child
          : typeof value.target_name === 'string' ? value.target_name
            : typeof value.child_name === 'string' ? value.child_name : ''
      // Related edges are derived from shared Session/Message evidence. The
      // model may only propose hierarchy here; explicit related edits belong
      // to the maintenance action API.
      const relationType = value.type === 'hierarchy' ? 'hierarchy' as const : null
      const sourceRawId = resolveConceptRef(sourceRef)
      const targetRawId = resolveConceptRef(targetRef)
      if (!sourceRawId || !targetRawId || !relationType || sourceRawId === targetRawId) return

      const [sourceId, targetId] = [sourceRawId, targetRawId]
      if (relationType === 'hierarchy' && wouldCreateHierarchyCycle(sourceId, targetId, [...relations.value, ...pendingRelations])) return

      const relationKey = `${relationType}:${sourceId}|${targetId}`
      if (relationKeys.has(relationKey)) return
      relationKeys.add(relationKey)

      const relation: ConceptRelation = {
        id: createId('relation'),
        parentConceptId: sourceId,
        childConceptId: targetId,
        relationType,
        source: 'llm',
        status: 'proposed',
        createdAt: now,
        updatedAt: now,
      }
      pendingRelations.push(relation)
      // The unique key makes this a no-op for an existing user-confirmed
      // relation instead of replacing its source or status.
      db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [relation.id, sourceId, targetId, relationType, 'llm', 'proposed', now, now])
    })
  }

  function createMaintenanceTask(input: { conceptIds?: string[]; unitIds?: string[]; includeFullContent?: boolean } = {}): string {
    const requestedConceptIds = input.conceptIds?.length ? new Set(input.conceptIds) : null
    const requestedUnitIds = input.unitIds?.length ? new Set(input.unitIds) : null
    // Maintenance is graph-wide by design. A selected Concept/Session/unit is
    // retained only as an attention hint; omitting the rest of the active
    // graph makes hierarchy repair impossible and encourages flat roots.
    const conceptScope = activeConcepts.value.slice()
    const unitScope = units.value.filter((unit) => unit.sessionId && activeSessionIds.value.has(unit.sessionId))
    const focusUnitIds = requestedUnitIds
      ? [...requestedUnitIds]
      : requestedConceptIds
        ? unitScope.filter((unit) => unitConcepts.value.some((link) => link.unitId === unit.id && requestedConceptIds.has(link.conceptId))).map((unit) => unit.id)
        : []
    // Maintenance may create optional reading units only from messages that
    // are not already claimed by another unit; omit assigned messages from
    // the catalog to keep the prompt focused and avoid duplicate proposals.
    const activeMessages = messages.value.filter((message) => activeSessionIds.value.has(message.sessionId) && !message.unitId)
    if (!conceptScope.length && !unitScope.length && !activeMessages.length) throw new Error('没有可供维护检查的知识主题、阅读片段或消息')
    const conceptIds = new Set(conceptScope.map((concept) => concept.id))
    const hierarchyChildIds = new Set(relations.value
      .filter((relation) => relation.relationType === 'hierarchy' && relation.status !== 'rejected' && conceptIds.has(relation.parentConceptId) && conceptIds.has(relation.childConceptId))
      .map((relation) => relation.childConceptId))
    const rootConceptIds = conceptScope.filter((concept) => !hierarchyChildIds.has(concept.id)).map((concept) => concept.id)
    const focusedConceptPathIds = [...(requestedConceptIds ?? [])].flatMap((conceptId) => conceptExpansionPath(conceptId, true).slice(0, -1))
    const unassignedSessionIds = [...new Set(activeMessages.map((message) => message.sessionId))]
    const unreachableUnitIds = unitScope
      .filter((unit) => !unitConcepts.value.some((link) => link.unitId === unit.id && conceptIds.has(link.conceptId)))
      .map((unit) => unit.id)
    const catalogUnitIds = [...new Set([...focusUnitIds, ...unreachableUnitIds])]
    const initialDisclosureRefIds = [...new Set([...rootConceptIds, ...focusedConceptPathIds, ...unassignedSessionIds, ...catalogUnitIds])]
    const prompt = buildMaintenancePrompt({
      concepts: conceptScope.map((concept) => ({ id: concept.id, name: concept.name, aliases: aliases.value.filter((alias) => alias.conceptId === concept.id).map((alias) => alias.alias), summary: concept.summary ?? '', notes: concept.notes })),
      relations: relations.value.filter((relation) => conceptIds.has(relation.parentConceptId) && conceptIds.has(relation.childConceptId)).map((relation) => ({ sourceId: relation.parentConceptId, targetId: relation.childConceptId, type: relation.relationType, status: relation.status })),
      units: unitScope.map((unit) => ({ id: unit.id, title: unit.title ?? '', summary: unit.summary ?? '', session: sessions.value.find((session) => session.id === unit.sessionId)?.title ?? '', conceptIds: unitConcepts.value.filter((link) => link.unitId === unit.id).map((link) => link.conceptId) })),
      messages: activeMessages.map((message) => ({ id: message.id, sessionId: message.sessionId, role: message.role, content: message.content.slice(0, 600) })),
      // The first round contains graph roots, direct child references, roots
      // for unassigned-message Sessions, and units unreachable from an active
      // Concept. Entity details are available only through continuation.
      disclosure: promptDisclosureContext({
        unitIds: catalogUnitIds,
        sessionIds: unassignedSessionIds,
        expandedRefIds: initialDisclosureRefIds,
        includeFullContent: false,
        includeConceptDetails: false,
        includeMessageSummaries: false,
        scopeConceptRoots: false,
        auditPendingRefs: true,
      }),
      scope: { conceptIds: requestedConceptIds ? [...requestedConceptIds] : [], unitIds: requestedUnitIds ? [...requestedUnitIds] : [] },
    })
    let taskId = ''
    mutate(() => {
      const focusHash = stableHash(JSON.stringify({ concepts: [...(requestedConceptIds ?? [])].sort(), units: [...(requestedUnitIds ?? [])].sort() }))
      taskId = createTask({ type: 'maintenance', mode: config.value.llm.mode ?? 'prompt_paste', providerId: config.value.llm.defaultProvider, model: null, promptVersion: PROMPT_VERSION, inputRevision: `maintenance:${maintenanceStateHash()}:${focusHash}`, prompt, status: 'pending', scopeLabel: `全库知识图谱 · ${conceptScope.length} 个知识主题 · ${unitScope.length} 个知识单元` })
    })
    return taskId
  }

  function maintenanceStateHash(): string {
    const ordered = <T extends { id: string }>(items: T[]): T[] => [...items].sort((left, right) => left.id.localeCompare(right.id))
    return stableHash(JSON.stringify({
      concepts: ordered(activeConcepts.value.map((concept) => ({ id: concept.id, name: concept.name, summary: concept.summary, notes: concept.notes, updatedAt: concept.updatedAt }))),
      aliases: ordered(aliases.value.map((alias) => ({ id: alias.id, conceptId: alias.conceptId, alias: alias.alias }))),
      relations: ordered(relations.value.map((relation) => ({ id: relation.id, source: relation.parentConceptId, target: relation.childConceptId, type: relation.relationType, status: relation.status, updatedAt: relation.updatedAt }))),
      units: ordered(units.value.filter((unit) => activeSessionIds.value.has(unit.sessionId)).map((unit) => ({ id: unit.id, sessionId: unit.sessionId, title: unit.title, summary: unit.summary, revision: unit.revision, updatedAt: unit.updatedAt }))),
      unitConcepts: [...unitConcepts.value].sort((left, right) => `${left.unitId}:${left.conceptId}`.localeCompare(`${right.unitId}:${right.conceptId}`)),
      messages: ordered(messages.value.filter((message) => activeSessionIds.value.has(message.sessionId) && !message.unitId).map((message) => ({ id: message.id, sessionId: message.sessionId, order: message.orderInSession, content: stableHash(message.content) }))),
    }))
  }

  type MaintenanceDisclosureScope = {
    conceptIds: Set<string>
    sessionIds: Set<string>
    unitIds: Set<string>
    messageIds: Set<string>
    relationIds: Set<string>
    aliasIds: Set<string>
  }

  /**
   * Build the mutation whitelist from disclosed entity content, not from the
   * whole local database. A maintenance prompt may list opaque navigation
   * references, but an action is only authorized after the corresponding
   * expansion includes the entity's structured content.
   */
  function maintenanceDisclosureScope(task: LLMTask): MaintenanceDisclosureScope {
    const scope: MaintenanceDisclosureScope = {
      conceptIds: new Set(),
      sessionIds: new Set(),
      unitIds: new Set(),
      messageIds: new Set(),
      relationIds: new Set(),
      aliasIds: new Set(),
    }
    const context = parseDisclosureContext(task.prompt)
    ;(context?.expansions ?? []).forEach((expansion) => {
      if (!expansion.content) return
      let parsed: unknown
      try { parsed = JSON.parse(expansion.content) } catch { return }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const value = parsed as Record<string, unknown>
      const addStringIds = (raw: unknown, target: Set<string>): void => {
        if (!Array.isArray(raw)) return
        raw.forEach((id) => {
          if (typeof id === 'string' && id.trim()) target.add(id.trim())
        })
      }
      // Every structured expansion is an authorization boundary. Preserve
      // entity IDs that are nested in evidence records too: a model may
      // legitimately relink a Message/Unit/Session to a Concept mentioned by
      // that same disclosed evidence, or edit a relation endpoint shown in a
      // Concept's relation list.
      const concept = value.concept
      if (concept && typeof concept === 'object' && !Array.isArray(concept)) {
        const item = concept as Record<string, unknown>
        if (typeof item.id === 'string') scope.conceptIds.add(item.id)
        if (Array.isArray(item.aliases)) item.aliases.forEach((alias) => {
          if (alias && typeof alias === 'object' && !Array.isArray(alias) && typeof (alias as Record<string, unknown>).id === 'string') scope.aliasIds.add((alias as Record<string, unknown>).id as string)
        })
      }
      // A fully disclosed Concept carries evidence IDs alongside its
      // `concept` object. They are part of the same authorization boundary
      // even when their own expansion is requested in a later batch.
      const memberships = value.memberships
      if (memberships && typeof memberships === 'object' && !Array.isArray(memberships)) {
        const membershipValue = memberships as Record<string, unknown>
        addStringIds(membershipValue.session_ids, scope.sessionIds)
        addStringIds(membershipValue.unit_ids, scope.unitIds)
        addStringIds(membershipValue.message_ids, scope.messageIds)
        addStringIds(membershipValue.concept_ids, scope.conceptIds)
      }
      const session = value.session
      if (session && typeof session === 'object' && !Array.isArray(session)) {
        const item = session as Record<string, unknown>
        if (typeof item.id === 'string') scope.sessionIds.add(item.id)
        addStringIds(item.concept_ids, scope.conceptIds)
      }
      const unit = value.unit
      if (unit && typeof unit === 'object' && !Array.isArray(unit)) {
        const item = unit as Record<string, unknown>
        if (typeof item.id === 'string') scope.unitIds.add(item.id)
        addStringIds(item.concept_ids, scope.conceptIds)
        addStringIds(item.message_ids, scope.messageIds)
        if (typeof item.session_id === 'string') scope.sessionIds.add(item.session_id)
      }
      if (unit && typeof unit === 'object' && !Array.isArray(unit)) {
        const messageIds = (unit as Record<string, unknown>).message_ids
        addStringIds(messageIds, scope.messageIds)
      }
      const message = value.message
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        const item = message as Record<string, unknown>
        if (typeof item.id === 'string') scope.messageIds.add(item.id)
        if (typeof item.session_id === 'string') scope.sessionIds.add(item.session_id)
        if (typeof item.unit_id === 'string') scope.unitIds.add(item.unit_id)
        addStringIds(item.concept_ids, scope.conceptIds)
      }
      const relationsValue = value.relations
      if (Array.isArray(relationsValue)) relationsValue.forEach((relation) => {
        if (!relation || typeof relation !== 'object' || Array.isArray(relation)) return
        const item = relation as Record<string, unknown>
        if (typeof item.id === 'string') scope.relationIds.add(item.id)
        if (typeof item.sourceId === 'string') scope.conceptIds.add(item.sourceId)
        if (typeof item.targetId === 'string') scope.conceptIds.add(item.targetId)
        if (typeof item.source_concept_id === 'string') scope.conceptIds.add(item.source_concept_id)
        if (typeof item.target_concept_id === 'string') scope.conceptIds.add(item.target_concept_id)
      })
      const messagesValue = value.messages
      if (Array.isArray(messagesValue)) messagesValue.forEach((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
        const item = entry as Record<string, unknown>
        if (typeof item.id === 'string') scope.messageIds.add(item.id)
        if (typeof item.session_id === 'string') scope.sessionIds.add(item.session_id)
        if (typeof item.unit_id === 'string') scope.unitIds.add(item.unit_id)
        addStringIds(item.concept_ids, scope.conceptIds)
      })
      const unassigned = value.unassigned_messages
      if (Array.isArray(unassigned)) unassigned.forEach((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
        const item = entry as Record<string, unknown>
        if (typeof item.id === 'string') scope.messageIds.add(item.id)
        if (typeof item.session_id === 'string') scope.sessionIds.add(item.session_id)
        if (typeof item.unit_id === 'string') scope.unitIds.add(item.unit_id)
        addStringIds(item.concept_ids, scope.conceptIds)
      })
    })
    return scope
  }

  function maintenanceSuggestionErrors(value: unknown, onlyIndex?: number, scope?: MaintenanceDisclosureScope): { suggestions: MaintenanceSuggestion[]; errors: string[] } {
    const errors: string[] = []
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { suggestions: [], errors: ['维护结果必须是 JSON 对象'] }
    const rawSuggestions = (value as Record<string, unknown>).suggestions
    if (!Array.isArray(rawSuggestions)) return { suggestions: [], errors: ['suggestions 必须是数组'] }
    const suggestions = rawSuggestions.map((item) => item && typeof item === 'object' ? item as MaintenanceSuggestion : { type: '' as MaintenanceSuggestion['type'] })
    const actionDefinitions = new Map(MAINTENANCE_ACTION_API.map((definition) => [definition.type, definition]))
    suggestions.forEach((suggestion, index) => {
      if (onlyIndex !== undefined && index !== onlyIndex) return
      const raw = suggestion as unknown as Record<string, unknown>
      const inputType = typeof raw.type === 'string' ? raw.type : ''
      const canonicalType = inputType === 'relation' ? 'add_relation' : inputType === 'archive_concept' ? 'delete_concept' : inputType
      const definition = actionDefinitions.get(canonicalType as typeof MAINTENANCE_ACTION_API[number]['type'])
      if (!definition) {
        errors.push(`suggestions.${index}.type 不受支持`)
        return
      }
      const allowed = new Set(['type', 'reason', 'applied', ...Object.keys(definition.properties)])
      // Legacy parent/child endpoint names are accepted only by the
      // deprecated `relation` alias. Canonical `add_relation` stays aligned
      // with its MCP inputSchema and rejects those extra fields.
      if (inputType === 'relation') {
        ;['parent_concept_id', 'child_concept_id', 'target_concept_id', 'source_concept_id'].forEach((field) => allowed.add(field))
      }
      if (inputType === 'update_relation') {
        ;['new_source_concept_id', 'new_target_concept_id', 'new_relation_type'].forEach((field) => allowed.add(field))
      }
      if (inputType === 'unit_relink') allowed.add('replace')
      Object.keys(raw).filter((key) => !allowed.has(key)).forEach((key) => errors.push(`suggestions.${index}.${key} 不是 ${inputType} 允许的字段`))
      const itemErrorStart = errors.length
      if (typeof raw.reason !== 'string' || !raw.reason.trim()) errors.push(`suggestions.${index}.reason 必须是非空字符串`)
      if (Object.prototype.hasOwnProperty.call(raw, 'applied') && typeof raw.applied !== 'boolean') errors.push(`suggestions.${index}.applied 必须是布尔值`)
      definition.required.forEach((field) => {
        const compatibilityPresent = inputType === 'relation'
          && ((field === 'source_concept_id' && raw.parent_concept_id !== undefined) || (field === 'target_concept_id' && raw.child_concept_id !== undefined))
        if (!compatibilityPresent && (!Object.prototype.hasOwnProperty.call(raw, field) || raw[field] === undefined)) errors.push(`suggestions.${index}.${field} 为必填字段`)
      })
      Object.entries(definition.properties).forEach(([field, expected]) => {
        if (!Object.prototype.hasOwnProperty.call(raw, field) || raw[field] === undefined) return
        const actual = raw[field]
        const valid = expected === 'string' || expected === 'string?'
          ? typeof actual === 'string'
          : expected === 'string|null' || expected === 'string|null?'
            ? actual === null || typeof actual === 'string'
            : expected === 'string[]'
              ? Array.isArray(actual) && actual.every((item) => typeof item === 'string')
              : expected === 'boolean' || expected === 'boolean?'
                ? typeof actual === 'boolean'
                : Array.isArray(expected) ? typeof actual === 'string' && expected.includes(actual as never)
                  : false
        if (!valid) errors.push(`suggestions.${index}.${field} 类型不符合动作 API`)
      })
      const validateStringList = (field: string, maxLength = 120): void => {
        if (!Object.prototype.hasOwnProperty.call(raw, field) || raw[field] === undefined) return
        const values = raw[field]
        if (!Array.isArray(values)) return
        const seen = new Set<string>()
        values.forEach((value, valueIndex) => {
          if (typeof value !== 'string' || !value.trim()) {
            errors.push(`suggestions.${index}.${field}.${valueIndex} 必须是非空字符串`)
            return
          }
          const normalized = normalizeText(value)
          if (value.trim().length > maxLength) errors.push(`suggestions.${index}.${field}.${valueIndex} 不能超过 ${maxLength} 个字符`)
          if (seen.has(normalized)) errors.push(`suggestions.${index}.${field} 不能重复`)
          seen.add(normalized)
        })
      }
      validateStringList('aliases')
      validateStringList('parent_concept_ids')
      if (raw.parent_concept_id !== undefined && raw.parent_concept_id !== null && typeof raw.parent_concept_id !== 'string') errors.push(`suggestions.${index}.parent_concept_id 类型不符合动作 API`)
      ;['new_source_concept_id', 'new_target_concept_id'].forEach((field) => {
        if (raw[field] !== undefined && typeof raw[field] !== 'string') errors.push(`suggestions.${index}.${field} 类型不符合动作 API`)
      })
      if (raw.new_relation_type !== undefined && raw.new_relation_type !== 'hierarchy' && raw.new_relation_type !== 'related') errors.push(`suggestions.${index}.new_relation_type 类型不符合动作 API`)
      if (errors.length > itemErrorStart) return
      const requireConceptInScope = (id: unknown, path: string): void => {
        if (scope && typeof id === 'string' && id.trim() && !scope.conceptIds.has(id.trim())) errors.push(`suggestions.${index}.${path}: Concept ID 不在当前披露范围中`)
      }
      const requireEntityInScope = (ids: Set<string> | undefined, id: unknown, path: string): void => {
        if (ids && typeof id === 'string' && id.trim() && !ids.has(id.trim())) errors.push(`suggestions.${index}.${path}: ID 不在当前披露范围中`)
      }
      if (suggestion.type === 'create_concept') {
        ;(suggestion.parent_concept_ids ?? (suggestion.parent_concept_id ? [suggestion.parent_concept_id] : [])).forEach((id) => requireConceptInScope(id, 'parent_concept_id'))
      }
      if (suggestion.type === 'update_concept' || suggestion.type === 'delete_concept' || suggestion.type === 'archive_concept' || suggestion.type === 'restore_concept' || suggestion.type === 'alias' || suggestion.type === 'move_concept' || suggestion.type === 'set_hierarchy_parents') {
        requireConceptInScope(suggestion.concept_id, 'concept_id')
      }
      if (suggestion.type === 'merge') {
        requireConceptInScope(suggestion.source_concept_id, 'source_concept_id')
        requireConceptInScope(suggestion.target_concept_id, 'target_concept_id')
      }
      if (suggestion.type === 'add_relation' || suggestion.type === 'relation' || suggestion.type === 'update_relation') {
        requireConceptInScope(suggestion.source_concept_id ?? suggestion.parent_concept_id ?? suggestion.new_source_concept_id, 'source_concept_id')
        requireConceptInScope(suggestion.target_concept_id ?? suggestion.child_concept_id ?? suggestion.new_target_concept_id, 'target_concept_id')
      }
      if (suggestion.type === 'remove_hierarchy') {
        requireConceptInScope(suggestion.child_concept_id, 'child_concept_id')
        requireConceptInScope(suggestion.parent_concept_id, 'parent_concept_id')
      }
      if (suggestion.type === 'remove_alias') requireEntityInScope(scope?.aliasIds, suggestion.alias_id, 'alias_id')
      if (suggestion.type === 'update_relation' || suggestion.type === 'delete_relation' || suggestion.type === 'remove_relation' || suggestion.type === 'set_relation_status' || suggestion.type === 'confirm_relation' || suggestion.type === 'reject_relation') requireEntityInScope(scope?.relationIds, suggestion.relation_id, 'relation_id')
      if (suggestion.type === 'unit_relink' || suggestion.type === 'unit_revision') requireEntityInScope(scope?.unitIds, suggestion.unit_id, 'unit_id')
      if (suggestion.type === 'unit_create') {
        requireEntityInScope(scope?.sessionIds, suggestion.session_id, 'session_id')
        ;(suggestion.message_ids ?? []).forEach((id) => requireEntityInScope(scope?.messageIds, id, 'message_ids'))
      }
      if (suggestion.type === 'membership_relink') {
        const targetSet = suggestion.target_type === 'session' ? scope?.sessionIds : suggestion.target_type === 'unit' ? scope?.unitIds : scope?.messageIds
        requireEntityInScope(targetSet, suggestion.target_id, 'target_id')
        ;(suggestion.concept_ids ?? []).forEach((id) => requireConceptInScope(id, 'concept_ids'))
      }
      if (suggestion.type === 'merge') {
        const source = concepts.value.find((concept) => concept.id === suggestion.source_concept_id)
        const target = concepts.value.find((concept) => concept.id === suggestion.target_concept_id)
        if (!source || source.status !== 'active') errors.push(`suggestions.${index} 的源知识主题不存在或不是 active`)
        if (!target || target.status !== 'active') errors.push(`suggestions.${index} 的目标知识主题不存在或不是 active`)
        if (suggestion.source_concept_id === suggestion.target_concept_id) errors.push(`suggestions.${index} 不能合并自身`)
      }
      if (suggestion.type === 'alias') {
        if (!concepts.value.some((concept) => concept.id === suggestion.concept_id && concept.status === 'active')) errors.push(`suggestions.${index} 的知识主题不存在或已归档`)
        if (!suggestion.alias?.trim()) errors.push(`suggestions.${index}.alias 不能为空`)
        if (suggestion.alias?.trim()) {
          const normalizedAlias = normalizeText(suggestion.alias)
          const nameOwner = concepts.value.find((concept) => concept.status === 'active' && concept.id !== suggestion.concept_id && concept.normalizedName === normalizedAlias)
          const aliasOwner = aliases.value.find((alias) => alias.conceptId !== suggestion.concept_id && alias.normalizedAlias === normalizedAlias)
          if (nameOwner || aliasOwner) errors.push(`suggestions.${index}.alias 与其他知识主题名称或别名冲突`)
        }
      }
      if (suggestion.type === 'remove_alias') {
        if (!suggestion.alias_id || !aliases.value.some((alias) => alias.id === suggestion.alias_id)) errors.push(`suggestions.${index} 的 alias_id 不存在`)
      }
      if (suggestion.type === 'relation' || suggestion.type === 'add_relation') {
        const sourceId = suggestion.source_concept_id ?? suggestion.parent_concept_id
        const targetId = suggestion.target_concept_id ?? suggestion.child_concept_id
        if (!activeConcepts.value.some((concept) => concept.id === sourceId) || !activeConcepts.value.some((concept) => concept.id === targetId)) errors.push(`suggestions.${index} 的关系端点不存在或已归档`)
        if (sourceId === targetId) errors.push(`suggestions.${index} 不能连接自身`)
        if (suggestion.relation_type !== 'hierarchy' && suggestion.relation_type !== 'related') errors.push(`suggestions.${index}.relation_type 无效`)
        if (suggestion.relation_type === 'hierarchy' && sourceId && targetId && wouldCreateHierarchyCycle(sourceId, targetId, relations.value)) errors.push(`suggestions.${index} 会形成父子关系环`)
      }
      if (suggestion.type === 'update_relation') {
        const relation = relations.value.find((item) => item.id === suggestion.relation_id)
        if (!relation) errors.push(`suggestions.${index} 的 relation_id 不存在`)
        const hasChange = ['source_concept_id', 'target_concept_id', 'relation_type', 'new_source_concept_id', 'new_target_concept_id', 'new_relation_type', 'parent_concept_id', 'child_concept_id']
          .some((field) => Object.prototype.hasOwnProperty.call(raw, field) && raw[field] !== undefined)
        if (!hasChange) errors.push(`suggestions.${index} 至少需要一个关系端点或 relation_type 变更字段`)
        const sourceId = suggestion.source_concept_id ?? suggestion.new_source_concept_id ?? suggestion.parent_concept_id ?? relation?.parentConceptId
        const targetId = suggestion.target_concept_id ?? suggestion.new_target_concept_id ?? suggestion.child_concept_id ?? relation?.childConceptId
        const relationType = suggestion.relation_type ?? suggestion.new_relation_type ?? relation?.relationType
        if (!sourceId || !concepts.value.some((concept) => concept.id === sourceId)) errors.push(`suggestions.${index} 的关系 source 不存在`)
        if (!targetId || !concepts.value.some((concept) => concept.id === targetId)) errors.push(`suggestions.${index} 的关系 target 不存在`)
        if (sourceId === targetId) errors.push(`suggestions.${index} 不能连接自身`)
        if (relationType !== 'hierarchy' && relationType !== 'related') errors.push(`suggestions.${index}.relation_type 无效`)
        if (relationType === 'hierarchy' && sourceId && targetId && relation && wouldCreateHierarchyCycle(sourceId, targetId, relations.value.filter((item) => item.id !== relation.id))) errors.push(`suggestions.${index} 会形成父子关系环`)
      }
      if (suggestion.type === 'set_relation_status' || suggestion.type === 'confirm_relation' || suggestion.type === 'reject_relation') {
        if (!suggestion.relation_id || !relations.value.some((relation) => relation.id === suggestion.relation_id)) errors.push(`suggestions.${index} 的 relation_id 不存在`)
        if (suggestion.type === 'set_relation_status' && !['proposed', 'confirmed', 'rejected'].includes(String((suggestion as unknown as Record<string, unknown>).status))) errors.push(`suggestions.${index}.status 必须是 proposed、confirmed 或 rejected`)
      }
      if (suggestion.type === 'delete_relation') {
        if (!suggestion.relation_id || !relations.value.some((relation) => relation.id === suggestion.relation_id)) errors.push(`suggestions.${index} 的 relation_id 不存在`)
      }
      if (suggestion.type === 'remove_relation') {
        if (!suggestion.relation_id || !relations.value.some((relation) => relation.id === suggestion.relation_id)) errors.push(`suggestions.${index} 的 relation_id 不存在`)
      }
      if (suggestion.type === 'membership_relink') {
        if (!['session', 'message', 'unit'].includes(String(suggestion.target_type))) errors.push(`suggestions.${index}.target_type 必须是 session、message 或 unit`)
        if (!suggestion.target_id?.trim()) errors.push(`suggestions.${index}.target_id 不能为空`)
        else if (suggestion.target_type === 'session' && !activeSessions.value.some((session) => session.id === suggestion.target_id)) errors.push(`suggestions.${index} 的 Session 不存在或已归档`)
        else if (suggestion.target_type === 'message' && !messages.value.some((message) => message.id === suggestion.target_id)) errors.push(`suggestions.${index} 的 Message 不存在`)
        else if (suggestion.target_type === 'unit' && !units.value.some((unit) => unit.id === suggestion.target_id)) errors.push(`suggestions.${index} 的知识单元不存在`)
        if (!Array.isArray(suggestion.concept_ids)) errors.push(`suggestions.${index}.concept_ids 必须是数组`)
        else errors.push(...validateConceptIdList(suggestion.concept_ids, activeConcepts.value.map((concept) => concept.id)).map((issue) => `suggestions.${index}.${issue.path}: ${issue.message}`))
        if (typeof suggestion.replace !== 'boolean') errors.push(`suggestions.${index}.replace 必须是布尔值`)
      }
      if (suggestion.type === 'unit_relink') {
        if (!units.value.some((unit) => unit.id === suggestion.unit_id)) errors.push(`suggestions.${index} 的知识单元不存在`)
        if (!Array.isArray(suggestion.concept_ids)) errors.push(`suggestions.${index}.concept_ids 必须是数组（可选择多个知识主题）`)
        else {
          const listIssues = validateConceptIdList(suggestion.concept_ids, activeConcepts.value.map((concept) => concept.id))
          listIssues.forEach((issue) => errors.push(`suggestions.${index}.${issue.path}: ${issue.message}`))
          const seen = new Set<string>()
          suggestion.concept_ids.forEach((conceptId) => {
            if (typeof conceptId === 'string') {
              if (!activeConcepts.value.some((concept) => concept.id === conceptId)) errors.push(`suggestions.${index} 的知识主题 ${conceptId} 不存在或已归档`)
              if (seen.has(conceptId)) errors.push(`suggestions.${index}.concept_ids 不能重复`)
              seen.add(conceptId)
            }
          })
        }
        if (suggestion.replace !== undefined && typeof suggestion.replace !== 'boolean') errors.push(`suggestions.${index}.replace 必须是布尔值`)
      }
      if (suggestion.type === 'unit_revision') {
        if (!units.value.some((unit) => unit.id === suggestion.unit_id)) errors.push(`suggestions.${index} 的知识单元不存在`)
        if (!suggestion.title?.trim() && !suggestion.summary?.trim()) errors.push(`suggestions.${index} 至少需要标题或摘要`)
        errors.push(...validateUnitText(suggestion.title, suggestion.summary).map((issue) => `suggestions.${index}.${issue.path}：${issue.message}`))
      }
      if (suggestion.type === 'unit_create') {
        const sessionId = suggestion.session_id
        const session = sessionId ? activeSessions.value.find((item) => item.id === sessionId) : undefined
        if (!session) errors.push(`suggestions.${index} 的 Session 不存在或已归档`)
        if (!Array.isArray(suggestion.message_ids) || suggestion.message_ids.length === 0) errors.push(`suggestions.${index}.message_ids 必须至少包含一条消息`)
        else {
          const seen = new Set<string>()
          suggestion.message_ids.forEach((messageId) => {
            if (typeof messageId !== 'string' || !messageId.trim()) errors.push(`suggestions.${index}.message_ids 必须只包含非空字符串`)
            else if (seen.has(messageId)) errors.push(`suggestions.${index}.message_ids 不能重复`)
            else {
              seen.add(messageId)
              const message = messages.value.find((item) => item.id === messageId)
              if (!message) errors.push(`suggestions.${index} 的消息 ${messageId} 不存在`)
              else if (sessionId && message.sessionId !== sessionId) errors.push(`suggestions.${index} 的消息必须属于同一 Session`)
              else if (message.unitId) errors.push(`suggestions.${index} 的消息 ${messageId} 已属于阅读片段`)
            }
          })
        }
        if (suggestion.title != null) errors.push(...validateUnitText(suggestion.title, suggestion.summary).filter((issue) => issue.path === 'title').map((issue) => `suggestions.${index}.${issue.path}：${issue.message}`))
        if (suggestion.summary != null) errors.push(...validateUnitText(suggestion.title, suggestion.summary).filter((issue) => issue.path === 'summary').map((issue) => `suggestions.${index}.${issue.path}：${issue.message}`))
        if (suggestion.concept_ids !== undefined) {
          if (!Array.isArray(suggestion.concept_ids)) errors.push(`suggestions.${index}.concept_ids 必须是数组`)
          else errors.push(...validateConceptIdList(suggestion.concept_ids, activeConcepts.value.map((concept) => concept.id)).map((issue) => `suggestions.${index}.${issue.path}: ${issue.message}`))
        }
      }
      if (suggestion.type === 'create_concept') {
        if (!suggestion.name?.trim()) errors.push(`suggestions.${index}.name 不能为空`)
        else if (suggestion.name.trim().length > 120) errors.push(`suggestions.${index}.name 不能超过 120 个字符`)
        if (suggestion.summary != null && suggestion.summary.length > 120) errors.push(`suggestions.${index}.summary 不能超过 120 个字符`)
        if (suggestion.notes != null && suggestion.notes.length > 120) errors.push(`suggestions.${index}.notes 不能超过 120 个字符`)
        if (suggestion.parent_concept_id !== undefined && suggestion.parent_concept_ids !== undefined) errors.push(`suggestions.${index} 不能同时使用 parent_concept_id 和 parent_concept_ids`)
        const parentIds = suggestion.parent_concept_ids ?? (suggestion.parent_concept_id == null ? [] : [suggestion.parent_concept_id])
        parentIds.forEach((parentId) => {
          if (!concepts.value.some((concept) => concept.id === parentId && concept.status === 'active')) errors.push(`suggestions.${index} 的父知识主题不存在`)
        })
        if (suggestion.name?.trim()) {
          const normalizedName = normalizeText(suggestion.name)
          if (concepts.value.some((concept) => concept.normalizedName === normalizedName)
            || aliases.value.some((alias) => alias.normalizedAlias === normalizedName)) errors.push(`suggestions.${index}.name 与现有知识主题或别名冲突；如需复用请使用 update_concept、restore_concept 或 alias`)
        }
        if (Array.isArray(suggestion.aliases)) {
          const conceptName = normalizeText(suggestion.name ?? '')
          suggestion.aliases.forEach((alias) => {
            const normalizedAlias = normalizeText(alias)
            if (!normalizedAlias) return
            if (normalizedAlias === conceptName) errors.push(`suggestions.${index}.aliases 不能包含 Concept 自身名称`)
            const nameOwner = concepts.value.find((concept) => concept.status === 'active' && concept.normalizedName === normalizedAlias)
            const aliasOwner = aliases.value.find((item) => item.normalizedAlias === normalizedAlias)
            if (nameOwner || aliasOwner) errors.push(`suggestions.${index}.aliases 包含已被其他知识主题占用的别名`)
          })
        }
      }
      if (suggestion.type === 'update_concept') {
        if (!suggestion.concept_id || !concepts.value.some((concept) => concept.id === suggestion.concept_id && concept.status === 'active')) errors.push(`suggestions.${index} 的知识主题不存在`)
        if (suggestion.name != null && (!suggestion.name.trim() || suggestion.name.trim().length > 120)) errors.push(`suggestions.${index}.name 无效`)
        if (suggestion.summary != null && suggestion.summary.length > 120) errors.push(`suggestions.${index}.summary 不能超过 120 个字符`)
        if (suggestion.notes != null && suggestion.notes.length > 120) errors.push(`suggestions.${index}.notes 不能超过 120 个字符`)
        if (suggestion.name === undefined && suggestion.summary === undefined && suggestion.notes === undefined) errors.push(`suggestions.${index} 至少需要一个要更新的字段`)
      }
      if (suggestion.type === 'move_concept') {
        const childId = suggestion.concept_id
        if (!childId || !concepts.value.some((concept) => concept.id === childId && concept.status === 'active')) errors.push(`suggestions.${index} 的知识主题不存在`)
        if (suggestion.parent_concept_id != null && !concepts.value.some((concept) => concept.id === suggestion.parent_concept_id && concept.status === 'active')) errors.push(`suggestions.${index} 的父知识主题不存在`)
        if (childId && childId === suggestion.parent_concept_id) errors.push(`suggestions.${index} 不能将知识主题移动到自身`)
        if (childId && suggestion.parent_concept_id && wouldCreateHierarchyCycle(suggestion.parent_concept_id, childId, relations.value)) errors.push(`suggestions.${index} 会形成父子关系环`)
      }
      if (suggestion.type === 'set_hierarchy_parents') {
        const childId = suggestion.concept_id
        if (!childId || !concepts.value.some((concept) => concept.id === childId && concept.status === 'active')) errors.push(`suggestions.${index} 的知识主题不存在`)
        if (!Array.isArray(suggestion.parent_concept_ids)) errors.push(`suggestions.${index}.parent_concept_ids 必须是字符串数组`)
        else {
          const seen = new Set<string>()
          const remaining = relations.value.filter((relation) => !(relation.relationType === 'hierarchy' && relation.childConceptId === childId))
          suggestion.parent_concept_ids.forEach((parentId) => {
            if (typeof parentId !== 'string' || !parentId.trim()) errors.push(`suggestions.${index}.parent_concept_ids 必须只包含非空字符串`)
            else if (seen.has(parentId)) errors.push(`suggestions.${index}.parent_concept_ids 不能重复`)
            else {
              seen.add(parentId)
              if (!concepts.value.some((concept) => concept.id === parentId && concept.status === 'active')) errors.push(`suggestions.${index} 的父知识主题 ${parentId} 不存在或已归档`)
              if (parentId === childId) errors.push(`suggestions.${index} 不能将知识主题设置为自身的父主题`)
              if (childId && wouldCreateHierarchyCycle(parentId, childId, remaining)) errors.push(`suggestions.${index} 会形成父子关系环`)
            }
          })
        }
      }
      if (suggestion.type === 'remove_hierarchy') {
        if (!suggestion.child_concept_id || !concepts.value.some((concept) => concept.id === suggestion.child_concept_id)) errors.push(`suggestions.${index} 的子知识主题不存在`)
        if (suggestion.parent_concept_id != null && !concepts.value.some((concept) => concept.id === suggestion.parent_concept_id)) errors.push(`suggestions.${index} 的父知识主题不存在`)
      }
      if (suggestion.type === 'archive_concept' || suggestion.type === 'delete_concept') {
        const concept = suggestion.concept_id ? concepts.value.find((item) => item.id === suggestion.concept_id) : undefined
        if (!concept || concept.status === 'merged') errors.push(`suggestions.${index} 的知识主题不存在、已合并或不可归档`)
      }
      if (suggestion.type === 'restore_concept') {
        const concept = suggestion.concept_id ? concepts.value.find((item) => item.id === suggestion.concept_id) : undefined
        if (!concept || concept.status === 'merged') errors.push(`suggestions.${index} 的知识主题不存在、已合并或不可恢复`)
      }
    })
    return { suggestions, errors }
  }

  function applyMaintenanceSuggestion(taskId: string, suggestionIndex: number): { ok: boolean; error?: string } {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task || task.type !== 'maintenance' || !task.parsedResult) return { ok: false, error: '维护任务结果尚未校验' }
    let parsed: unknown
    try { parsed = JSON.parse(task.parsedResult) } catch { return { ok: false, error: '维护结果无法解析' } }
    // Revalidate only the selected operation against the current database.
    // Earlier suggestions may intentionally change the state needed by later
    // operations, such as delete_concept followed by restore_concept.
    const validation = maintenanceSuggestionErrors(parsed, suggestionIndex, maintenanceDisclosureScope(task))
    const suggestion = validation.suggestions[suggestionIndex]
    if (validation.errors.length || !suggestion) return { ok: false, error: validation.errors[0] ?? '找不到这条建议' }
    const raw = parsed as { suggestions: Array<MaintenanceSuggestion & { applied?: boolean }> }
    if (raw.suggestions[suggestionIndex]?.applied) return { ok: false, error: '这条建议已经应用' }
    const before = captureConceptOperationSnapshot()
    try {
      mutate(() => {
        const now = isoNow()
        if (suggestion.type === 'merge') {
          const sourceId = suggestion.source_concept_id as string
          const targetId = suggestion.target_concept_id as string
          mergeConceptRecords(sourceId, targetId, now)
        } else if (suggestion.type === 'alias') {
          db.run('INSERT OR IGNORE INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('alias'), suggestion.concept_id, suggestion.alias?.trim(), normalizeText(suggestion.alias ?? ''), 'maintenance', now])
        } else if (suggestion.type === 'remove_alias') {
          db.run('DELETE FROM concept_aliases WHERE id = ?', [suggestion.alias_id])
        } else if (suggestion.type === 'relation' || suggestion.type === 'add_relation') {
          const rawSourceId = suggestion.source_concept_id ?? suggestion.parent_concept_id
          const rawTargetId = suggestion.target_concept_id ?? suggestion.child_concept_id
          const [sourceId, targetId] = suggestion.relation_type === 'related' && rawSourceId && rawTargetId && rawSourceId > rawTargetId
            ? [rawTargetId, rawSourceId]
            : [rawSourceId, rawTargetId]
          if (suggestion.relation_type === 'hierarchy' && sourceId && targetId && wouldCreateHierarchyCycle(sourceId, targetId, relations.value)) throw new Error('这个父子关系会形成环，无法建立')
          db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [createId('relation'), sourceId, targetId, suggestion.relation_type, 'maintenance', 'proposed', now, now])
        } else if (suggestion.type === 'update_relation') {
          const relation = relations.value.find((item) => item.id === suggestion.relation_id)
          if (!relation) throw new Error('知识主题关系不存在')
          const rawSourceId = suggestion.source_concept_id ?? suggestion.new_source_concept_id ?? suggestion.parent_concept_id ?? relation.parentConceptId
          const rawTargetId = suggestion.target_concept_id ?? suggestion.new_target_concept_id ?? suggestion.child_concept_id ?? relation.childConceptId
          const relationType = suggestion.relation_type ?? suggestion.new_relation_type ?? relation.relationType
          const [sourceId, targetId] = relationType === 'related' && rawSourceId > rawTargetId ? [rawTargetId, rawSourceId] : [rawSourceId, rawTargetId]
          if (relationType === 'hierarchy' && wouldCreateHierarchyCycle(sourceId, targetId, relations.value.filter((item) => item.id !== relation.id))) throw new Error('这个父子关系会形成环，无法更新')
          const duplicate = db.query<Row>('SELECT id FROM concept_relations WHERE id <> ? AND parent_concept_id = ? AND child_concept_id = ? AND relation_type = ? LIMIT 1', [relation.id, sourceId, targetId, relationType])[0]
          if (!duplicate) db.run('UPDATE concept_relations SET parent_concept_id = ?, child_concept_id = ?, relation_type = ?, source = \'maintenance\', status = \'proposed\', updated_at = ? WHERE id = ?', [sourceId, targetId, relationType, now, relation.id])
        } else if (suggestion.type === 'set_relation_status' || suggestion.type === 'confirm_relation' || suggestion.type === 'reject_relation') {
          const status = suggestion.type === 'confirm_relation'
            ? 'confirmed'
            : suggestion.type === 'reject_relation'
              ? 'rejected'
              : suggestion.status
          if (!status) throw new Error('关系审核状态不完整')
          db.run('UPDATE concept_relations SET status = ?, updated_at = ? WHERE id = ?', [status, now, suggestion.relation_id])
        } else if (suggestion.type === 'delete_relation') {
          db.run('DELETE FROM concept_relations WHERE id = ?', [suggestion.relation_id])
        } else if (suggestion.type === 'remove_relation') {
          db.run('DELETE FROM concept_relations WHERE id = ?', [suggestion.relation_id])
        } else if (suggestion.type === 'membership_relink') {
          const ids = [...new Set(suggestion.concept_ids ?? [])]
          const targetType = suggestion.target_type
          const targetId = suggestion.target_id
          if (!targetType || !targetId) throw new Error('主题归属目标不完整')
          if (targetType === 'session') {
            if (suggestion.replace) db.run('DELETE FROM session_concepts WHERE session_id = ?', [targetId])
            ids.forEach((conceptId) => db.run('INSERT OR IGNORE INTO session_concepts(session_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [targetId, conceptId, 'maintenance', now]))
            db.run('UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?', [now, targetId])
          } else if (targetType === 'unit') {
            if (suggestion.replace) db.run('DELETE FROM unit_concepts WHERE unit_id = ?', [targetId])
            ids.forEach((conceptId) => db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [targetId, conceptId, 'maintenance', now]))
            const unit = units.value.find((item) => item.id === targetId)
            if (unit) db.run('UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?', [now, unit.sessionId])
          } else {
            const row = db.query<Row>('SELECT metadata, session_id FROM messages WHERE id = ?', [targetId])[0]
            if (!row) throw new Error('消息不存在')
            if (suggestion.replace) db.run('DELETE FROM message_concepts WHERE message_id = ?', [targetId])
            ids.forEach((conceptId) => db.run('INSERT OR IGNORE INTO message_concepts(message_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [targetId, conceptId, 'maintenance', now]))
            const metadata = parseMetadata(row.metadata)
            const current = suggestion.replace ? [] : (Array.isArray(metadata.concept_ids) ? metadata.concept_ids.filter((id): id is string => typeof id === 'string') : [])
            const next = [...new Set([...current, ...ids])]
            if (next.length) metadata.concept_ids = next
            else delete metadata.concept_ids
            db.run('UPDATE messages SET metadata = ? WHERE id = ?', [Object.keys(metadata).length ? JSON.stringify(metadata) : null, targetId])
            db.run('UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?', [now, text(row.session_id)])
          }
        } else if (suggestion.type === 'unit_create') {
          const sessionId = suggestion.session_id
          const messageIds = [...new Set(suggestion.message_ids ?? [])]
          if (!sessionId || messageIds.length === 0) throw new Error('创建阅读片段需要 Session 和消息')
          const session = sessions.value.find((item) => item.id === sessionId)
          if (!session) throw new Error('Session 不存在')
          const selectedMessages = messageIds.map((messageId) => messages.value.find((message) => message.id === messageId))
          if (selectedMessages.some((message) => !message || message.sessionId !== sessionId || message.unitId)) throw new Error('消息不存在、跨 Session 或已属于阅读片段')
          const maxOrder = units.value.filter((unit) => unit.sessionId === sessionId).reduce((max, unit) => Math.max(max, unit.orderInSession), -1)
          const unitId = createId('unit')
          db.run('INSERT INTO knowledge_units(id, session_id, title, summary, order_in_session, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', [unitId, sessionId, suggestion.title?.trim() || null, suggestion.summary?.trim() || null, maxOrder + 1, 'ready', now, now])
          messageIds.forEach((messageId) => db.run('UPDATE messages SET unit_id = ? WHERE id = ?', [unitId, messageId]))
          ;(suggestion.concept_ids ?? []).forEach((conceptId) => {
            db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unitId, conceptId, 'maintenance', now])
          })
          db.run('UPDATE sessions SET unit_count = (SELECT COUNT(*) FROM knowledge_units WHERE session_id = ?), revision = revision + 1, updated_at = ? WHERE id = ?', [sessionId, now, sessionId])
        } else if (suggestion.type === 'unit_relink') {
          // This is a replacement operation, so an empty list intentionally
          // clears stale memberships instead of leaving old links behind.
          if (suggestion.replace !== false) db.run('DELETE FROM unit_concepts WHERE unit_id = ?', [suggestion.unit_id])
          ;(suggestion.concept_ids ?? []).forEach((conceptId) => {
            db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [suggestion.unit_id, conceptId, 'maintenance', now])
          })
          const unit = units.value.find((item) => item.id === suggestion.unit_id)
          if (unit) db.run('UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?', [now, unit.sessionId])
        } else if (suggestion.type === 'unit_revision') {
          const unit = units.value.find((item) => item.id === suggestion.unit_id)
          if (!unit) throw new Error('知识单元不存在')
          const nextTitle = suggestion.title === undefined ? unit.title : suggestion.title.trim()
          const nextSummary = suggestion.summary === undefined ? unit.summary : suggestion.summary.trim()
          if (nextTitle !== unit.title || nextSummary !== unit.summary) {
            db.run('UPDATE knowledge_units SET title = ?, summary = ?, revision = revision + 1, status = \'ready\', updated_at = ? WHERE id = ?', [nextTitle || null, nextSummary || null, now, suggestion.unit_id])
            db.run('UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?', [now, unit.sessionId])
          }
        } else if (suggestion.type === 'create_concept') {
          const conceptId = ensureConcept(suggestion.name!.trim(), 'manual')
          if (suggestion.summary?.trim() || suggestion.notes?.trim()) {
            db.run('UPDATE concepts SET summary = ?, notes = ?, updated_at = ? WHERE id = ?', [suggestion.summary?.trim() ?? '', suggestion.notes ?? '', now, conceptId])
          }
          ;(suggestion.aliases ?? []).forEach((alias) => {
            db.run('INSERT OR IGNORE INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('alias'), conceptId, alias.trim(), normalizeText(alias), 'maintenance', now])
          })
          const parentIds = suggestion.parent_concept_ids ?? (suggestion.parent_concept_id == null ? [] : [suggestion.parent_concept_id])
          parentIds.forEach((parentId) => {
            if (wouldCreateHierarchyCycle(parentId, conceptId, relations.value)) throw new Error('这个父子关系会形成环，无法建立')
            db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, \'hierarchy\', ?, \'proposed\', ?, ?)', [createId('relation'), parentId, conceptId, 'maintenance', now, now])
          })
        } else if (suggestion.type === 'update_concept') {
          const current = concepts.value.find((concept) => concept.id === suggestion.concept_id)
          if (!current) throw new Error('知识主题不存在')
          const nextName = suggestion.name === undefined ? current.name : suggestion.name.trim()
          const normalizedName = normalizeText(nextName)
          const duplicate = db.query<Row>('SELECT id FROM concepts WHERE normalized_name = ? AND id <> ?', [normalizedName, current.id])[0]
          const aliasOwner = db.query<Row>('SELECT concept_id FROM concept_aliases WHERE normalized_alias = ?', [normalizedName])[0]
          if (duplicate || (aliasOwner && text(aliasOwner.concept_id) !== current.id)) throw new Error('已有同名知识主题或别名，请换一个名称')
          db.run('DELETE FROM concept_aliases WHERE concept_id = ? AND normalized_alias = ?', [current.id, normalizedName])
          db.run('UPDATE concepts SET name = ?, normalized_name = ?, summary = ?, notes = ?, updated_at = ? WHERE id = ?', [nextName, normalizedName, suggestion.summary === undefined ? current.summary : suggestion.summary.trim(), suggestion.notes === undefined ? current.notes : suggestion.notes, now, current.id])
        } else if (suggestion.type === 'move_concept') {
          const childId = suggestion.concept_id!
          if (suggestion.parent_concept_id && wouldCreateHierarchyCycle(suggestion.parent_concept_id, childId, relations.value)) throw new Error('这个父子关系会形成环，无法建立')
          db.run('DELETE FROM concept_relations WHERE child_concept_id = ? AND relation_type = \'hierarchy\'', [childId])
          if (suggestion.parent_concept_id) {
            db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, \'hierarchy\', ?, \'proposed\', ?, ?)', [createId('relation'), suggestion.parent_concept_id, childId, 'maintenance', now, now])
          }
        } else if (suggestion.type === 'set_hierarchy_parents') {
          const childId = suggestion.concept_id!
          const parentIds = [...new Set(suggestion.parent_concept_ids ?? [])]
          const remaining = relations.value.filter((relation) => !(relation.relationType === 'hierarchy' && relation.childConceptId === childId))
          parentIds.forEach((parentId) => {
            if (wouldCreateHierarchyCycle(parentId, childId, remaining)) throw new Error('这个父子关系会形成环，无法建立')
          })
          db.run('DELETE FROM concept_relations WHERE child_concept_id = ? AND relation_type = \'hierarchy\'', [childId])
          parentIds.forEach((parentId) => {
            db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, \'hierarchy\', ?, \'proposed\', ?, ?)', [createId('relation'), parentId, childId, 'maintenance', now, now])
          })
        } else if (suggestion.type === 'remove_hierarchy') {
          if (suggestion.parent_concept_id) db.run('DELETE FROM concept_relations WHERE parent_concept_id = ? AND child_concept_id = ? AND relation_type = \'hierarchy\'', [suggestion.parent_concept_id, suggestion.child_concept_id])
          else db.run('DELETE FROM concept_relations WHERE child_concept_id = ? AND relation_type = \'hierarchy\'', [suggestion.child_concept_id])
        } else if (suggestion.type === 'archive_concept' || suggestion.type === 'delete_concept') {
          const concept = concepts.value.find((item) => item.id === suggestion.concept_id)
          if (concept?.status === 'active') db.run('UPDATE concepts SET status = \'archived\', deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, suggestion.concept_id])
        } else if (suggestion.type === 'restore_concept') {
          const concept = concepts.value.find((item) => item.id === suggestion.concept_id)
          if (concept?.status === 'archived') db.run('UPDATE concepts SET status = \'active\', deleted_at = NULL, merged_into_id = NULL, updated_at = ? WHERE id = ?', [now, suggestion.concept_id])
        }
        raw.suggestions[suggestionIndex] = { ...raw.suggestions[suggestionIndex], applied: true }
        db.run('UPDATE llm_tasks SET parsed_result = ?, updated_at = ? WHERE id = ?', [JSON.stringify(raw), now, taskId])
        recordOperation(`应用维护建议：${suggestion.type}`, before, captureConceptOperationSnapshot())
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '应用维护建议失败' }
    }
  }

  type TaskApplyResult = { ok: boolean; errors: string[]; continued?: boolean }

  const disclosureTaskTypes = new Set<LLMTask['type']>(['concept_extraction', 'origin_concepts', 'conversation', 'maintenance'])

  function undisclosedReferenceIds(context: DisclosureContext): string[] {
    const expandedWithContent = new Set((context.expansions ?? []).filter((expansion) => expansion.content != null).map((expansion) => expansion.refID))
    const listed = new Set(context.roots.map((reference) => reference.refID))
    ;(context.expansions ?? []).forEach((expansion) => expansion.children?.forEach((reference) => listed.add(reference.refID)))
    return [...listed].filter((refID) => !expandedWithContent.has(refID))
  }

  function hasDisclosureCompletionPayload(task: LLMTask, data: Record<string, unknown>): boolean {
    if (task.type === 'conversation') {
      return typeof data.answer === 'string' && data.answer.trim().length > 0
        && Array.isArray(data.units) && data.units.length > 0
    }
    if (task.type === 'maintenance') {
      return typeof data.reason === 'string' && data.reason.trim().length > 0
        && Array.isArray(data.suggestions)
    }
    if (task.type === 'concept_extraction' || task.type === 'origin_concepts') {
      if (!Array.isArray(data.concepts) || !Array.isArray(data.memberships)) return false
      const hasDeclaredConcept = data.concepts.length > 0
        || (Array.isArray(data.concept_ids) && data.concept_ids.length > 0)
        || data.memberships.some((item) => item && typeof item === 'object' && !Array.isArray(item)
          && Array.isArray((item as Record<string, unknown>).concept_ids)
          && ((item as Record<string, unknown>).concept_ids as unknown[]).length > 0)
      return hasDeclaredConcept
    }
    return false
  }

  /** Queue a follow-up turn when the model asks to inspect known references. */
  function continueDisclosureTask(task: LLMTask, responseText: string, data: Record<string, unknown>): TaskApplyResult | null {
    // Tasks without a disclosure field must ignore an extra model key. This
    // keeps legacy contracts (triage, segmentation, metadata) strict without
    // accidentally turning arbitrary JSON into a continuation.
    if (!disclosureTaskTypes.has(task.type)) return null
    if (!Array.isArray(data.disclosure_requests) || data.disclosure_requests.length === 0) return null
    const current = parseDisclosureContext(task.prompt)
    if (!current) {
      const errors = ['响应请求展开引用，但当前 Prompt 没有可用的 DISCLOSURE_INDEX']
      markTask(task.id, 'needs_review', responseText, errors)
      return { ok: false, errors }
    }
    const currentRound = current.round ?? 0
    if (currentRound >= 8) {
      const errors = ['渐进式披露超过 8 轮，已暂停任务供检查']
      markTask(task.id, 'needs_review', responseText, errors)
      return { ok: false, errors }
    }
    const available = listedDisclosureRefIds(current)
    const requestErrors = validateDisclosureRequests(data.disclosure_requests, available).map((issue) => `${issue.path}: ${issue.message}`)
    if (requestErrors.length) {
      markTask(task.id, 'needs_review', responseText, requestErrors)
      return { ok: false, errors: requestErrors }
    }
    const requests = data.disclosure_requests as Array<{ refID: string; depth: number }>
    const requested = requests.map((item) => item.refID.trim())
    const expansionMap = new Map<string, NonNullable<DisclosureContext['expansions']>[number]>()
    ;(current.expansions ?? []).forEach((expansion) => expansionMap.set(expansion.refID, expansion))
    const expandedThisTurn = new Set<string>()
    let changedExpansion = false

    // Expand the returned directory, rather than reconstructing edges from
    // only one parent. This preserves multi-parent Concepts and follows the
    // exact Concept -> Unit -> Message shape shown to the model.
    for (const request of requests) {
      let frontier = [request.refID.trim()]
      const seenAtRequest = new Set<string>()
      for (let level = 0; level < request.depth && frontier.length; level += 1) {
        const generated = promptDisclosureContext({ includeFullContent: true, expandedRefIds: frontier, round: currentRound + 1 })
        const generatedById = new Map((generated.expansions ?? []).map((expansion) => [expansion.refID, expansion]))
        const next: string[] = []
        frontier.forEach((refID) => {
          if (seenAtRequest.has(refID)) return
          seenAtRequest.add(refID)
          const expansion = generatedById.get(refID) ?? expansionMap.get(refID)
          if (!expansion) return
          expandedThisTurn.add(refID)
          const previous = expansionMap.get(refID)
          if (!previous || JSON.stringify(previous) !== JSON.stringify(expansion)) changedExpansion = true
          expansionMap.set(refID, expansion)
          expansion.children?.forEach((child) => {
            if (!seenAtRequest.has(child.refID)) next.push(child.refID)
          })
        })
        frontier = [...new Set(next)]
      }
    }
    const nextContext: DisclosureContext = {
      roots: current.roots,
      expansions: [...expansionMap.values()],
      round: currentRound + 1,
      ...(current.auditPendingRefs ? { auditPendingRefs: true } : {}),
    }
    const nextPrompt = replaceDisclosureContext(task.prompt, nextContext)
    if (expandedThisTurn.size === 0 || !changedExpansion || nextPrompt === task.prompt) {
      const requestsAreAlreadyExpanded = requests.every((request) => expansionMap.has(request.refID.trim()))
      if (!changedExpansion && requestsAreAlreadyExpanded && hasDisclosureCompletionPayload(task, data)) {
        // Providers sometimes repeat the request that produced the current
        // round while also returning a complete result. The catalog already
        // contains that expansion, so treat only the redundant request as
        // empty and let the normal task-specific validator apply the result.
        data.disclosure_requests = []
        return null
      }
      const errors = expandedThisTurn.size === 0
        ? [`请求的引用当前没有可披露内容：${requested.join('、')}。请依据现有目录完成结果，或检查 refID 是否仍有效。`]
        : !changedExpansion && requestsAreAlreadyExpanded
          ? [`请求的引用已经展开：${requested.join('、')}。请清空 disclosure_requests，并依据当前目录返回完整结果。`]
          : ['请求的引用没有推进披露目录，请检查 refID、depth 或改用已有目录']
      markTask(task.id, 'needs_review', responseText, errors)
      return { ok: false, errors }
    }
    if (!transitionTask(task.id, 'continue_disclosure', {
      response: responseText,
      parsedResult: null,
      validationErrors: null,
      errorMessage: null,
      prompt: nextPrompt,
    })) {
      const errors = ['任务状态在披露续轮期间发生变化，请重新加载任务后再试']
      markTask(task.id, 'needs_review', responseText, errors)
      return { ok: false, errors }
    }
    return { ok: false, errors: [`已展开 ${requested.length} 个引用，任务已重新排队`], continued: true }
  }

  function applyTaskResult(taskId: string, responseText: string, options: { internal?: boolean } = {}): TaskApplyResult {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task) return { ok: false, errors: ['找不到任务'] }
    if (!['pending', 'running', 'needs_review'].includes(task.status)) {
      return { ok: false, errors: [`任务当前状态为${task.status}，请先重新排队后再应用结果`] }
    }
    // API execution owns the running state until the provider response has
    // been validated. A manual click in the task detail while that request is
    // in flight could submit the stale first-round response, clear its
    // disclosure_requests and incorrectly finish the task with no changes.
    // The executor passes `internal` for its own response; UI callers must
    // wait for the request (and any automatic disclosure continuation) to
    // settle before editing or validating a response.
    if (task.mode === 'api' && task.status === 'running' && !options.internal) {
      return { ok: false, errors: ['API 任务正在执行，请等待当前请求完成后再校验结果'] }
    }
    if (task.type === 'segmentation') return applySegmentationTask(taskId, responseText)

    const parsed = parseStructuredResponse(responseText)
    if (!parsed.data) {
      const errors = [parsed.error ?? '响应格式错误']
      markTask(taskId, 'needs_review', responseText, errors)
      return { ok: false, errors }
    }
    let data = parsed.data
    // Providers occasionally echo an existing Concept in the response-local
    // `concepts` array on a follow-up turn. Normalize only exact name/alias
    // matches against the disclosed catalog, rewrite all client_ref uses to
    // the opaque ID, and retain an audit trail in parsed_result. Near matches
    // and compound names still go through the strict validator unchanged.
    const reuseAudit = (task.type === 'origin_concepts' || task.type === 'conversation') && Array.isArray(data.concepts)
      ? normalizeOriginConceptResultForReuse(data, promptConceptCatalog(task))
      : { data, reused: [] }
    if (reuseAudit.reused.length) data = { ...reuseAudit.data, nexus_reuse: reuseAudit.reused }
    else data = reuseAudit.data
    const errors: string[] = []
    const conceptLimit = normalizeConceptLimit(config.value.llm.conceptLimit)
    if (task.type === 'maintenance') {
      const hasSuggestions = Array.isArray(data.suggestions) && data.suggestions.length > 0
      // An empty maintenance result is not auditable without the envelope
      // reason. Prompt-paste keeps compatibility with older non-empty action
      // payloads, while API responses always require the field because the
      // provider contract is machine-enforced.
      if ((task.mode === 'api' || !hasSuggestions) && (typeof data.reason !== 'string' || !data.reason.trim())) {
        const reasonErrors = ['reason 必须是非空字符串；维护响应不能省略总体审计说明']
        markTask(taskId, 'needs_review', responseText, reasonErrors)
        return { ok: false, errors: reasonErrors }
      }
      const taskStateHash = task.inputRevision.split(':')[1]
      if (!taskStateHash || taskStateHash !== maintenanceStateHash()) {
        const staleErrors = ['维护任务输入已变化：知识主题、关系、阅读片段或可选消息目录已更新，请重新发起知识维护。']
        markTask(taskId, 'stale', responseText, staleErrors)
        return { ok: false, errors: staleErrors }
      }
      if (Array.isArray(data.disclosure_requests) && data.disclosure_requests.length > 0 && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        const mixedErrors = ['维护响应不能同时返回 suggestions 和 disclosure_requests；请先完成披露审计，且中间轮必须令 suggestions=[]']
        markTask(taskId, 'needs_review', responseText, mixedErrors)
        return { ok: false, errors: mixedErrors }
      }
    }
    const disclosureContinuation = continueDisclosureTask(task, responseText, data)
    if (disclosureContinuation) return disclosureContinuation
    if (disclosureTaskTypes.has(task.type)) {
      const disclosure = parseDisclosureContext(task.prompt)
      errors.push(...validateDisclosureRequests(data.disclosure_requests, disclosure ? listedDisclosureRefIds(disclosure) : undefined).map((issue) => `${issue.path}: ${issue.message}`))
    }
    const inputParts = task.inputRevision.split(':')
    const targetId = inputParts[0]
    const targetRevision = inputParts[1]
    if (errors.length) {
      markTask(taskId, 'needs_review', responseText, errors)
      return { ok: false, errors }
    }

    if (task.type === 'maintenance' && (!Array.isArray(data.disclosure_requests) || data.disclosure_requests.length === 0)) {
      const currentDisclosure = parseDisclosureContext(task.prompt)
      const hiddenRefIds = currentDisclosure ? undisclosedReferenceIds(currentDisclosure) : []
      if (hiddenRefIds.length > 0) {
        // Include the exact pending IDs in the repair prompt. The original
        // DISCLOSURE_INDEX remains authoritative, but surfacing this computed
        // list makes a manually repaired response deterministic and prevents
        // the model from interpreting an empty suggestions array as a final
        // no-op. Keep the message bounded for very large graphs; the full
        // pending list is still present in the task Prompt.
        const preview = hiddenRefIds.slice(0, 64).join('、')
        const suffix = hiddenRefIds.length > 64 ? `（其余 ${hiddenRefIds.length - 64} 个请从 DISCLOSURE_INDEX.pending_ref_ids 读取）` : ''
        const hiddenErrors = [`维护审计尚有 ${hiddenRefIds.length} 个已列出但未展开的引用；请批量返回 disclosure_requests 后再给最终建议。待展开 refID：${preview}${suffix}`]
        markTask(taskId, 'needs_review', responseText, hiddenErrors)
        return { ok: false, errors: hiddenErrors }
      }
    }

    if (task.type === 'maintenance') {
      const disclosureScope = maintenanceDisclosureScope(task)
      const maintenanceTargetIds = [
        ...disclosureScope.unitIds,
        ...disclosureScope.sessionIds,
        ...disclosureScope.messageIds,
      ]
      errors.push(...validateConceptMembershipPayload(task, data, maintenanceTargetIds, disclosureScope.conceptIds))
      const validation = maintenanceSuggestionErrors(data, undefined, disclosureScope)
      if (errors.length) {
        markTask(taskId, 'needs_review', responseText, errors)
        return { ok: false, errors }
      }
      if (validation.errors.length) {
        markTask(taskId, 'needs_review', responseText, validation.errors)
        return { ok: false, errors: validation.errors }
      }
      // Preserve the provider's audited explanation verbatim. Older clients
      // did not send the envelope-level reason, so retain a clearly marked
      // derived fallback while the prompt migrates those clients; new API
      // responses are required to provide the field themselves.
      const suppliedReason = typeof data.reason === 'string' ? data.reason.trim() : ''
      const derivedReason = validation.suggestions.length
        ? `旧版响应未提供总体 reason；已收到 ${validation.suggestions.length} 条带逐条理由的建议。`
        : '模型检查后未发现需要修改的地方。'
      const normalizedMaintenance = {
        ...data,
        reason: suppliedReason || derivedReason,
        ...(suppliedReason ? {} : { reason_source: 'derived_compatibility' }),
      }
      mutate(() => {
        transitionTaskInTransaction(taskId, 'accept_validated_result', {
          response: responseText,
          parsedResult: JSON.stringify(normalizedMaintenance),
          validationErrors: null,
          errorMessage: null,
        })
      })
      return { ok: true, errors: [] }
    }

    if (task.type === 'session_triage') {
      const kind = data.kind
      const confidence = data.confidence
      const reason = data.reason
      const retainInGraph = data.retain_in_graph
      const triageSession = sessions.value.find((item) => item.id === targetId)
      if (!triageSession) errors.push('任务所属的会话不存在')
      if (!['knowledge', 'discussion', 'procedure', 'mixed'].includes(String(kind))) errors.push('kind 必须是 knowledge、discussion、procedure 或 mixed')
      if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push('confidence 必须是 0 到 1 之间的数字')
      if (typeof reason !== 'string' || !reason.trim()) errors.push('reason 必须是非空字符串')
      if (typeof retainInGraph !== 'boolean') errors.push('retain_in_graph 必须是布尔值')
      if (errors.length) {
        markTask(taskId, errors.some((error) => error.includes('版本')) ? 'stale' : 'needs_review', responseText, errors)
        return { ok: false, errors }
      }
      mutate(() => {
        const now = isoNow()
        db.run('UPDATE sessions SET knowledge_kind = ?, knowledge_confidence = ?, knowledge_judgment = ?, knowledge_retain_in_graph = ?, updated_at = ? WHERE id = ?', [kind, confidence, String(reason).trim(), retainInGraph ? 1 : 0, now, targetId])
        transitionTaskInTransaction(taskId, 'accept_validated_result', {
          response: responseText,
          parsedResult: JSON.stringify(data),
          validationErrors: null,
          errorMessage: null,
        })
        if (kind === 'knowledge') {
          const existingOriginTask = db.query<Row>('SELECT id FROM llm_tasks WHERE type = ? AND input_revision LIKE ? LIMIT 1', ['origin_concepts', `${targetId}:%`])[0]
          if (!existingOriginTask && triageSession) {
            createOriginConceptTasks(triageSession, messages.value.filter((message) => message.sessionId === targetId).sort((left, right) => left.orderInSession - right.orderInSession))
          }
        } else {
          tasks.value
            .filter((candidate) => candidate.type === 'origin_concepts' && candidate.inputRevision.startsWith(`${targetId}:`) && isActiveTaskStatus(candidate.status))
            .forEach((candidate) => {
              transitionTaskInTransaction(candidate.id, 'cancel', { errorMessage: '会话分类不是 knowledge，已跳过起始知识主题提取。' })
              abortControllers.get(candidate.id)?.abort()
            })
        }
      })
      return { ok: true, errors: [] }
    }

    const unit = units.value.find((item) => item.id === targetId)
    const session = sessions.value.find((item) => item.id === targetId)

    if (task.type === 'unit_metadata') {
      if (!unit) errors.push('任务所属的知识单元不存在')
      else if (String(unit.revision) !== targetRevision) errors.push('任务输入版本已过期，请重新生成 Prompt')
      const title = data.title
      const summary = data.summary
      if (typeof title !== 'string' || !title.trim()) errors.push('标题必须是非空字符串')
      if (typeof summary !== 'string' || !summary.trim()) errors.push('摘要必须是非空字符串')
      if (typeof title === 'string' || typeof summary === 'string') {
        errors.push(...validateUnitText(typeof title === 'string' ? title : unit?.title, typeof summary === 'string' ? summary : unit?.summary).map((issue) => issue.message))
      }
      if (errors.length) {
        markTask(taskId, errors.some((error) => error.includes('版本')) ? 'stale' : 'needs_review', responseText, errors)
        return { ok: false, errors }
      }
      mutate(() => {
        const now = isoNow()
        db.run("UPDATE knowledge_units SET title = ?, summary = ?, status = 'ready', updated_at = ? WHERE id = ?", [String(title).trim(), String(summary).trim(), now, targetId])
        transitionTaskInTransaction(taskId, 'accept_validated_result', {
          response: responseText,
          parsedResult: JSON.stringify(data),
          validationErrors: null,
          errorMessage: null,
        })
      })
      return { ok: true, errors: [] }
    }

    if (task.type === 'title' || task.type === 'summary') {
      if (!unit) errors.push('任务所属的知识单元不存在')
      else if (String(unit.revision) !== targetRevision) errors.push('任务输入版本已过期，请重新生成 Prompt')
      const field = task.type === 'title' ? 'title' : 'summary'
      const value = data[field]
      if (typeof value !== 'string' || !value.trim()) errors.push(`${field === 'title' ? '标题' : '摘要'}必须是非空字符串`)
      if (typeof value === 'string') errors.push(...validateUnitText(field === 'title' ? value : unit?.title, field === 'summary' ? value : unit?.summary).map((issue) => issue.message))
      if (errors.length) {
        markTask(taskId, errors.some((error) => error.includes('版本')) ? 'stale' : 'needs_review', responseText, errors)
        return { ok: false, errors }
      }
      mutate(() => {
        const now = isoNow()
        if (field === 'title') db.run("UPDATE knowledge_units SET title = ?, status = 'ready', updated_at = ? WHERE id = ?", [String(value).trim(), now, targetId])
        else db.run("UPDATE knowledge_units SET summary = ?, status = 'ready', updated_at = ? WHERE id = ?", [String(value).trim(), now, targetId])
        transitionTaskInTransaction(taskId, 'accept_validated_result', {
          response: responseText,
          parsedResult: JSON.stringify(data),
          validationErrors: null,
          errorMessage: null,
        })
      })
      return { ok: true, errors: [] }
    }

    if (task.type === 'concept_extraction' || task.type === 'origin_concepts') {
      const originMessages = task.type === 'origin_concepts' && session
        ? taskSessionMessages(task, session.id)
        : []
      const membershipTargets = task.type === 'concept_extraction'
        ? [
            ...(unit ? [unit.id] : []),
            ...messages.value.filter((message) => unit && message.unitId === unit.id).map((message) => message.id),
            ...(session ? [session.id] : []),
          ]
        : taskChunkBounds(task)
          ? originMessages.map((message) => message.id)
          : [
              ...(session ? [session.id] : []),
              ...originMessages.map((message) => message.id),
            ]
      if (task.type === 'origin_concepts') {
        errors.push(...validateOriginConceptResult(data, {
          targetIds: membershipTargets,
          conceptIds: promptConceptIds(task),
          conceptCatalog: promptConceptCatalog(task),
          maxConcepts: conceptLimit,
        }).map((issue) => `${issue.path}: ${issue.message}`))
      } else {
        errors.push(...validateConceptMembershipPayload(task, data, membershipTargets))
      }
      const rawConcepts = data.concepts
      const declaredConceptIds = Array.isArray(data.concept_ids) ? data.concept_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()) : []
      const membershipConceptIds = Array.isArray(data.memberships)
        ? data.memberships.flatMap((item) => item && typeof item === 'object' && !Array.isArray(item) && Array.isArray((item as Record<string, unknown>).concept_ids)
          ? ((item as Record<string, unknown>).concept_ids as unknown[]).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [])
        : []
      if (!Array.isArray(rawConcepts)) errors.push('concepts 必须是数组')
      else {
        if (rawConcepts.length > conceptLimit) errors.push(`一次最多提取 ${conceptLimit} 个 Concept`)
        if (rawConcepts.length === 0 && declaredConceptIds.length === 0 && membershipConceptIds.length === 0) errors.push('concepts 或 concept_ids 至少需要一项')
      }
      const candidates = Array.isArray(rawConcepts) ? rawConcepts.map((candidate) => {
        if (typeof candidate === 'string') return { clientRef: '', name: candidate, summary: '', aliases: [] as string[] }
        if (!candidate || typeof candidate !== 'object') return { clientRef: '', name: '', summary: '', aliases: [] as string[] }
        const item = candidate as Record<string, unknown>
        return {
          clientRef: typeof item.client_ref === 'string' ? item.client_ref.trim() : '',
          name: typeof item.name === 'string' ? item.name : '',
          summary: typeof item.summary === 'string' ? item.summary.trim() : '',
          aliases: Array.isArray(item.aliases) ? item.aliases.filter((alias): alias is string => typeof alias === 'string') : [],
        }
      }) : []
      candidates.forEach((candidate) => {
        if (task.type !== 'origin_concepts') errors.push(...validateConceptName(candidate.name).map((issue) => issue.message))
        if (candidate.summary.length > 120) errors.push('Concept 摘要不能超过 120 个字符')
      })
      if (errors.length) {
        markTask(taskId, 'needs_review', responseText, errors)
        return { ok: false, errors }
      }
      if (task.type === 'concept_extraction' && (!unit || String(unit.revision) !== targetRevision)) errors.push('任务输入版本已过期，请重新生成 Prompt')
      if (task.type === 'origin_concepts' && (!session || String(session.revision) !== targetRevision)) errors.push('任务输入版本已过期，请重新生成 Prompt')
      if (errors.length) {
        markTask(taskId, 'stale', responseText, errors)
        return { ok: false, errors }
      }
      mutate(() => {
        const now = isoNow()
        const conceptIds: string[] = []
        const conceptIdsByName = new Map<string, string>()
        candidates.forEach((candidate) => {
          const conceptId = ensureConcept(candidate.name, 'llm')
          conceptIds.push(conceptId)
          conceptIdsByName.set(normalizeText(candidate.name), conceptId)
          if (candidate.summary) db.run("UPDATE concepts SET summary = CASE WHEN summary = '' THEN ? ELSE summary END, updated_at = ? WHERE id = ?", [candidate.summary, now, conceptId])
          candidate.aliases.forEach((alias) => {
            const normalizedAlias = normalizeText(alias)
            if (!normalizedAlias || normalizedAlias === normalizeText(candidate.name)) return
            db.run('INSERT OR IGNORE INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('alias'), conceptId, alias.trim(), normalizedAlias, 'llm', now])
          })
        })
        const membershipDeclaredIds = Array.isArray(data.memberships)
          ? data.memberships.flatMap((item) => item && typeof item === 'object' && !Array.isArray(item) && Array.isArray((item as Record<string, unknown>).concept_ids)
            ? ((item as Record<string, unknown>).concept_ids as unknown[]).filter((value): value is string => typeof value === 'string').map((value) => value.trim())
            : [])
          : []
        const allConceptIds = [...new Set([...conceptIds, ...declaredConceptIds])]
        ;[...declaredConceptIds, ...membershipDeclaredIds].forEach((conceptId) => {
          const existing = activeConcepts.value.find((concept) => concept.id === conceptId)
          if (existing) conceptIdsByName.set(normalizeText(existing.name), conceptId)
        })
        const conceptIdsByClientRef = new Map<string, string>()
        candidates.forEach((candidate, index) => {
          if (candidate.clientRef) conceptIdsByClientRef.set(candidate.clientRef, conceptIds[index])
        })
        const resolveConceptRef = (ref: string): string | null => {
          const normalized = ref.trim()
          return conceptIdsByClientRef.get(normalized)
            ?? (activeConcepts.value.some((concept) => concept.id === normalized) ? normalized : null)
            ?? conceptIdsByName.get(normalizeText(normalized))
            ?? null
        }
        if (task.type === 'concept_extraction') {
          // Legacy unit extraction keeps its historical default association.
          persistConceptMemberships(data.memberships, now, resolveConceptRef)
          allConceptIds.forEach((conceptId) => db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unit!.id, conceptId, 'llm', now]))
        } else {
          // Direct extraction only persists explicit Session/Message evidence.
          // A technical window is not a KnowledgeUnit and never gets a
          // default membership.
          persistConceptMemberships(data.memberships, now, resolveConceptRef, false)
        }
        persistProposedConceptRelations(data.relations, now, resolveConceptRef)
        transitionTaskInTransaction(taskId, 'accept_validated_result', {
          response: responseText,
          parsedResult: JSON.stringify(data),
          validationErrors: null,
          errorMessage: null,
        })
      })
      return { ok: true, errors: [] }
    }

    if (task.type === 'conversation') {
      const answer = data.answer
      const rawUnits = data.units
      const hasSessionTitle = Object.prototype.hasOwnProperty.call(data, 'session_title')
      const hasSessionSummary = Object.prototype.hasOwnProperty.call(data, 'session_summary')
      const sessionTitle = typeof data.session_title === 'string' ? data.session_title.trim() : ''
      const sessionSummary = typeof data.session_summary === 'string' ? data.session_summary.trim() : ''
      const conversationSession = sessions.value.find((item) => item.id === targetId)
      const existingSessionUnits = units.value.filter((item) => item.sessionId === targetId)
      if (typeof answer !== 'string' || !answer.trim()) errors.push('answer 必须是非空字符串')
      if (!Array.isArray(rawUnits)) errors.push('units 必须是非空数组；每轮回答都要复用或创建阅读片段')
      if (Array.isArray(rawUnits) && rawUnits.length === 0) {
        errors.push(existingSessionUnits.length === 0
          ? '本 Session 尚无阅读片段，首轮回答必须创建一个阅读片段'
          : '每轮回答必须复用一个已有阅读片段或创建一个新的阅读片段')
      }
      if (hasSessionTitle && !sessionTitle) errors.push('session_title 必须是非空字符串')
      if (hasSessionSummary && !sessionSummary) errors.push('session_summary 必须是非空字符串')
      if (Array.from(sessionTitle).length > 60) errors.push('session_title 不能超过 60 个字符')
      if (Array.from(sessionSummary).length > 120) errors.push('session_summary 不能超过 120 个字符')
      const userMessage = messages.value.find((message) => {
        if (message.sessionId !== targetId || message.role !== 'user') return false
        return parseMetadata(message.metadata).taskId === task.id
      })
      const userMessageMetadata = parseMetadata(userMessage?.metadata)
      const plannedAssistantMessageId = typeof userMessageMetadata.answerMessageId === 'string' && userMessageMetadata.answerMessageId.trim()
        ? userMessageMetadata.answerMessageId.trim()
        : createId('message')
      if (!conversationSession) errors.push('找不到对话目标会话')
      else if (!userMessage) errors.push('找不到这次提问对应的消息')
      if (String(conversationSession?.revision ?? '') !== targetRevision) errors.push('任务输入版本已过期，请重新生成 Prompt')
      const directConceptsProvided = Object.prototype.hasOwnProperty.call(data, 'concepts')
      const rawDirectConcepts = directConceptsProvided && Array.isArray(data.concepts) ? data.concepts : []
      const directConcepts = rawDirectConcepts.map((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { clientRef: '', name: '', summary: '', aliases: [] as string[] }
        const value = candidate as Record<string, unknown>
        return {
          clientRef: typeof value.client_ref === 'string' ? value.client_ref.trim() : '',
          name: typeof value.name === 'string' ? value.name.trim() : '',
          summary: typeof value.summary === 'string' ? value.summary.trim() : '',
          aliases: Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === 'string') : [],
        }
      })
      const normalizedUnits = Array.isArray(rawUnits) ? rawUnits.map((item) => {
        const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
        const concepts = Array.isArray(value.concepts) ? value.concepts : []
        return {
          unitId: typeof value.unit_id === 'string' ? value.unit_id.trim() : '',
          title: typeof value.title === 'string' ? value.title.trim() : '',
          summary: typeof value.summary === 'string' ? value.summary.trim() : '',
          conceptIds: Array.isArray(value.concept_ids) ? value.concept_ids.filter((id): id is string => typeof id === 'string').map((id) => id.trim()) : [],
          conceptIdsRaw: value.concept_ids,
          conceptIdsProvided: Object.prototype.hasOwnProperty.call(value, 'concept_ids'),
          // Unit-local concepts are optional. Providers occasionally echo
          // malformed marker fragments (arrays or tag tuples) inside this
          // field; ignore those fragments rather than rejecting an otherwise
          // usable answer and reading excerpt.
          concepts: concepts.flatMap((concept) => {
            if (typeof concept === 'string') return [{ name: concept, summary: '', aliases: [] as string[] }]
            if (!concept || typeof concept !== 'object' || Array.isArray(concept)) return []
            const item = concept as Record<string, unknown>
            if (typeof item.name !== 'string' || !item.name.trim()) return []
            return [{ name: item.name, summary: typeof item.summary === 'string' ? item.summary.trim() : '', aliases: Array.isArray(item.aliases) ? item.aliases.filter((alias): alias is string => typeof alias === 'string') : [] }]
          }),
        }
      }) : []
      normalizedUnits.forEach((unit) => {
        if (!unit.unitId && !unit.title) errors.push('新建对话阅读片段标题不能为空')
        if (!unit.unitId && validateUnitText(unit.title, unit.summary).length) errors.push('新建对话阅读片段标题或摘要超出长度限制')
        unit.concepts.forEach((concept) => {
          errors.push(...validateConceptName(concept.name).map((issue) => `对话返回的${issue.message}`))
          if (concept.summary.length > 120) errors.push('对话返回的知识主题摘要不能超过 120 个字符')
        })
        if (unit.conceptIdsProvided) {
          errors.push(...validateConceptIdList(unit.conceptIdsRaw, promptConceptIds(task)).map((issue) => `${issue.path}: ${issue.message}`))
        }
        if (unit.unitId) {
          const existingUnit = units.value.find((candidate) => candidate.id === unit.unitId)
          if (!existingUnit || existingUnit.sessionId !== targetId) errors.push(`unit_id ${unit.unitId} 不属于当前 Session`)
        }
      })
      // Memberships describe evidence for this answer only. Historical
      // messages remain available as conversation context, but accepting them
      // as target IDs lets a provider accidentally relink an unrelated turn
      // (or a copied ID from another Session).
      const conversationTargetIds = [targetId, userMessage?.id, plannedAssistantMessageId].filter((id): id is string => Boolean(id))
      if (directConceptsProvided) {
        errors.push(...validateOriginConceptResult({
          concepts: data.concepts,
          memberships: data.memberships,
          ...(Object.prototype.hasOwnProperty.call(data, 'relations') ? { relations: data.relations } : {}),
        }, {
          targetIds: conversationTargetIds,
          conceptIds: promptConceptIds(task),
          conceptCatalog: promptConceptCatalog(task),
          maxConcepts: conceptLimit,
        }).map((issue) => `${issue.path}: ${issue.message}`))
        errors.push(...validateConceptIdList(data.concept_ids, promptConceptIds(task)).map((issue) => `${issue.path}: ${issue.message}`))
      } else {
        // Older conversation prompts had no response-local Concept contract
        // and could target an already existing optional KnowledgeUnit.
        errors.push(...validateConceptMembershipPayload(task, data, [
          ...conversationTargetIds,
          ...units.value.filter((unit) => unit.sessionId === targetId).map((unit) => unit.id),
        ]))
        // Legacy responses may still carry relation suggestions. Validate
        // their endpoints against the disclosed catalog before applying them.
        if (Object.prototype.hasOwnProperty.call(data, 'relations')) {
          errors.push(...validateOriginConceptResult({ concepts: [], memberships: [], relations: data.relations }, {
            targetIds: conversationTargetIds,
            conceptIds: promptConceptIds(task),
            conceptCatalog: promptConceptCatalog(task),
          }).map((issue) => `${issue.path}: ${issue.message}`))
        }
      }
      if (errors.length) {
        markTask(taskId, errors.some((error) => error.includes('版本')) ? 'stale' : 'needs_review', responseText, errors)
        return { ok: false, errors }
      }
      mutate(() => {
        const now = isoNow()
        const meta = userMessageMetadata as { mode?: string; parentNodeId?: string | null; topicId?: string | null; answerMessageId?: string | null }
        const followUp = meta.mode === 'follow_up'
        // Determine where the answer branches from.
        let parentNodeId: string
        let parentDepth: number
        if (followUp) {
          const parentRow = db.query<Row>('SELECT id, depth FROM nav_tree_nodes WHERE id = ?', [meta.parentNodeId ?? ''])[0]
          if (!parentRow) throw new Error('找不到要继续的探索节点')
          parentNodeId = text(parentRow.id)
          parentDepth = number(parentRow.depth)
        } else {
          const rootRow = db.query<Row>('SELECT id FROM nav_tree_nodes WHERE session_id = ? AND parent_id IS NULL LIMIT 1', [targetId])[0]
          if (rootRow) {
            parentNodeId = text(rootRow.id)
            parentDepth = -1
          } else {
            parentNodeId = createId('nav')
            db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, NULL, NULL, ?, 0, ?)', [parentNodeId, targetId, conversationSession?.title ?? '新的知识对话', now])
            parentDepth = -1
          }
        }
        // The opening question already owns the session root. Keep its first
        // answer on that same card; only follow-up questions create a child
        // branch. This prevents the initial Q&A from being split into two
        // apparently duplicated cards in the conversation view.
        const branchNodeId = followUp ? createId('nav') : parentNodeId
        if (followUp) {
          db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [branchNodeId, targetId, parentNodeId, meta.topicId ?? null, normalizedUnits[0]?.title || '对话回答', parentDepth + 1, now])
        }
        const sessionMessages = messages.value.filter((message) => message.sessionId === targetId).sort((left, right) => left.orderInSession - right.orderInSession)
        const assistantOrder = sessionMessages.length ? sessionMessages[sessionMessages.length - 1].orderInSession + 1 : 1
        const assistantMessageId = plannedAssistantMessageId
        db.run('INSERT INTO messages(id, session_id, unit_id, role, content, order_in_session, timestamp, metadata) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)', [assistantMessageId, targetId, 'assistant', String(answer).trim(), assistantOrder, now, JSON.stringify({ taskId, navNodeId: branchNodeId })])
        const unitOffset = units.value.filter((unit) => unit.sessionId === targetId).length
        const declaredTopLevelConceptIds = Array.isArray(data.concept_ids)
          ? data.concept_ids.filter((value): value is string => typeof value === 'string').map((value) => value.trim())
          : []
        const directConceptIdsByRef = new Map<string, string>()
        directConcepts.forEach((candidate) => {
          const conceptId = ensureConcept(candidate.name, 'llm')
          directConceptIdsByRef.set(candidate.clientRef, conceptId)
          if (candidate.summary) db.run("UPDATE concepts SET summary = CASE WHEN summary = '' THEN ? ELSE summary END, updated_at = ? WHERE id = ?", [candidate.summary, now, conceptId])
          candidate.aliases.forEach((alias) => {
            const normalizedAlias = normalizeText(alias)
            if (!normalizedAlias || normalizedAlias === normalizeText(candidate.name)) return
            db.run('INSERT OR IGNORE INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('alias'), conceptId, alias.trim(), normalizedAlias, 'llm', now])
          })
        })
        const resolveConversationConceptRef = (ref: string): string | null => {
          const normalized = ref.trim()
          return directConceptIdsByRef.get(normalized)
            ?? (activeConcepts.value.some((concept) => concept.id === normalized) ? normalized : null)
        }
        // Conversation results may carry a small, evidence-backed relation
        // set. Persist them as proposed so the user can confirm/reject them
        // from the graph maintenance UI; hierarchy remains cycle-checked.
        const relationKeys = new Set<string>(relations.value.map((relation) => {
          const pair = relation.relationType === 'related'
            ? [relation.parentConceptId, relation.childConceptId].sort().join('|')
            : `${relation.parentConceptId}|${relation.childConceptId}`
          return `${relation.relationType}:${pair}`
        }))
        const pendingRelations: ConceptRelation[] = []
        if (directConceptsProvided && Array.isArray(data.relations)) data.relations.slice(0, 2).forEach((rawRelation) => {
          if (!rawRelation || typeof rawRelation !== 'object' || Array.isArray(rawRelation)) return
          const value = rawRelation as Record<string, unknown>
          const source = typeof value.source === 'string' ? value.source : ''
          const target = typeof value.target === 'string' ? value.target : ''
          const sourceId = resolveConversationConceptRef(source)
          const targetId = resolveConversationConceptRef(target)
          // Conversation output cannot author related edges. They are derived
          // from persisted memberships after the answer is applied.
          const relationType = value.type === 'hierarchy' ? 'hierarchy' as const : null
          if (!sourceId || !targetId || !relationType || sourceId === targetId) return
          const [parentId, childId] = [sourceId, targetId]
          if (relationType === 'hierarchy' && wouldCreateHierarchyCycle(parentId, childId, [...relations.value, ...pendingRelations])) return
          const pair = `${parentId}|${childId}`
          const key = `${relationType}:${pair}`
          if (relationKeys.has(key)) return
          relationKeys.add(key)
          const relation: ConceptRelation = { id: createId('relation'), parentConceptId: parentId, childConceptId: childId, relationType, source: 'llm', status: 'proposed', createdAt: now, updatedAt: now }
          pendingRelations.push(relation)
          db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [relation.id, parentId, childId, relationType, 'llm', 'proposed', now, now])
        })
        normalizedUnits.forEach((item, index) => {
          const unitId = item.unitId || createId('unit')
          if (!item.unitId) {
            db.run('INSERT INTO knowledge_units(id, session_id, title, summary, order_in_session, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', [unitId, targetId, item.title, item.summary || null, unitOffset + index, 'ready', now, now])
          }
          if (index === 0 && userMessage) db.run('UPDATE messages SET unit_id = ? WHERE id IN (?, ?)', [unitId, userMessage.id, assistantMessageId])
          db.run('INSERT OR IGNORE INTO nav_tree_node_units(node_id, unit_id, order_in_node) VALUES (?, ?, ?)', [branchNodeId, unitId, index])
          const explicitIds = [...new Set([...declaredTopLevelConceptIds, ...item.conceptIds])]
          explicitIds.forEach((conceptId) => db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unitId, conceptId, 'llm', now]))
          item.concepts.forEach((candidate) => {
            const conceptId = ensureConcept(candidate.name, 'llm')
            db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unitId, conceptId, 'llm', now])
            if (candidate.summary) db.run("UPDATE concepts SET summary = CASE WHEN summary = '' THEN ? ELSE summary END, updated_at = ? WHERE id = ?", [candidate.summary, now, conceptId])
            candidate.aliases.forEach((alias) => {
              const normalizedAlias = normalizeText(alias)
              if (normalizedAlias && normalizedAlias !== normalizeText(candidate.name)) db.run('INSERT OR IGNORE INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('alias'), conceptId, alias.trim(), normalizedAlias, 'llm', now])
            })
          })
        })
        persistConceptMemberships(data.memberships, now, resolveConversationConceptRef, false)
        persistProposedConceptRelations(data.relations, now, resolveConversationConceptRef)
        const currentTitle = conversationSession?.title ?? '新的知识对话'
        const fallbackTitle = normalizedUnits[0]?.title || compactSessionText(userMessage?.content, 60)
        const nextTitle = conversationSession && isGeneratedConversationTitle(conversationSession)
          ? sessionTitle || fallbackTitle || currentTitle
          : currentTitle
        const fallbackSummary = compactSessionText(answer, 120)
        const nextSummary = sessionSummary || conversationSession?.summary?.trim() || fallbackSummary
        // Derive counts from rows after the assistant insert. This keeps the
        // Session state correct for both new conversations and follow-ups,
        // including answers that contain no KnowledgeUnit.
        db.run('UPDATE sessions SET title = ?, summary = ?, message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?), unit_count = (SELECT COUNT(*) FROM knowledge_units WHERE session_id = ?), revision = revision + 1, updated_at = ? WHERE id = ?', [nextTitle, nextSummary, targetId, targetId, now, targetId])
        if (nextTitle !== currentTitle) db.run('UPDATE nav_tree_nodes SET label = ? WHERE session_id = ? AND parent_id IS NULL', [nextTitle, targetId])
        transitionTaskInTransaction(taskId, 'accept_validated_result', {
          response: responseText,
          parsedResult: JSON.stringify(data),
          validationErrors: null,
          errorMessage: null,
        })
      })
      return { ok: true, errors: [] }
    }

    mutate(() => transitionTaskInTransaction(taskId, 'accept_validated_result', {
      response: responseText,
      parsedResult: JSON.stringify(data),
      validationErrors: null,
      errorMessage: null,
    }))
    return { ok: true, errors: [] }
  }

  function retryTask(taskId: string): void {
    if (tasks.value.find((task) => task.id === taskId)?.type === 'segmentation') return
    transitionTask(taskId, 'retry', { errorMessage: null, validationErrors: null })
  }

  function cancelTask(taskId: string): void {
    transitionTask(taskId, 'cancel')
    abortControllers.get(taskId)?.abort()
  }

  const outdatedPromptError = 'Prompt 版本已更新，请重新生成任务'

  function rejectOutdatedPendingTask(task: LLMTask): boolean {
    if (task.status !== 'pending' || task.promptVersion === PROMPT_VERSION) return false
    markTask(task.id, 'stale', undefined, [outdatedPromptError])
    return true
  }

  async function executeTask(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task) return { ok: false, error: '找不到任务' }
    if (executingTaskIds.has(taskId)) return { ok: false, error: '任务正在处理中' }
    if (rejectOutdatedPendingTask(task)) return { ok: false, error: outdatedPromptError }
    if (task.type === 'segmentation') return { ok: false, error: LEGACY_SEGMENTATION_RETIRED_REASON }
    if (task.mode !== 'api') return { ok: false, error: 'Prompt 粘贴模式需要手动执行 Prompt' }
    const provider = config.value.llm.providers.find((item) => item.id === task.providerId) ?? config.value.llm.providers.find((item) => item.id === config.value.llm.defaultProvider)
    if (!provider?.baseUrl || !provider.apiKey) return { ok: false, error: '请先在设置中填写 API Base URL 和 API Key' }
    const targetId = task.inputRevision.split(':')[0]
    const ownerUnit = units.value.find((item) => item.id === targetId)
    const session = sessions.value.find((item) => item.id === (ownerUnit?.sessionId ?? targetId))
    executingTaskIds.add(taskId)
    clearStreamingTaskText(taskId)
    try {
      transitionTask(taskId, 'start')
      const started = tasks.value.find((item) => item.id === taskId)
      if (!started || started.status !== 'running') {
        executingTaskIds.delete(taskId)
        return { ok: false, error: `任务当前状态为${started?.status ?? '未知'}，无法执行` }
      }
    } catch (error) {
      executingTaskIds.delete(taskId)
      throw error
    }
    let lastError: Error | null = null
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController()
        abortControllers.set(taskId, controller)
        const timeout = window.setTimeout(() => controller.abort(), 45_000)
        try {
          const requestBody: Record<string, unknown> = {
            model: task.model || provider.model,
            temperature: 0,
            messages: [{ role: 'user', content: task.prompt }],
          }
          if (config.value.llm.stream && task.type === 'conversation') requestBody.stream = true
          // Expose maintenance operations as OpenAI-compatible functions when
          // the provider supports tool calling. The resulting calls are still
          // converted into suggestions and pass the same local validator.
          if (task.type === 'maintenance') {
            requestBody.tools = listMaintenanceMcpTools().map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            }))
            requestBody.tool_choice = 'auto'
          }
          const response = await httpRequest(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          })
          if (!response.ok) {
            const retryable = response.status === 408 || response.status === 429 || response.status >= 500
            throw Object.assign(new Error(`Provider 返回 HTTP ${response.status}`), { retryable })
          }
          let payload: {
            choices?: Array<{
              message?: {
                content?: string | null
                tool_calls?: Array<{ function?: { name?: string; arguments?: string | Record<string, unknown> } }>
              }
            }>
          }
          const isEventStream = response.headers?.get?.('content-type')?.toLocaleLowerCase().includes('text/event-stream') ?? false
          if (config.value.llm.stream && task.type === 'conversation' && response.body && isEventStream) {
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let streamed = ''
            for (;;) {
              const chunk = await reader.read()
              if (chunk.done) break
              buffer += decoder.decode(chunk.value, { stream: true })
              const lines = buffer.split(/\r?\n/)
              buffer = lines.pop() ?? ''
              for (const line of lines) {
                const data = line.trim().replace(/^data:\s*/, '')
                if (!data || data === '[DONE]') continue
                try {
                  const delta = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> }
                  const text = delta.choices?.[0]?.delta?.content
                  if (typeof text === 'string') {
                    streamed += text
                    setStreamingTaskText(taskId, streamed)
                  }
                } catch {
                  // Providers occasionally split a JSON event across chunks;
                  // keep it in the next buffer and continue collecting output.
                }
              }
            }
            // Some providers omit the final newline before [DONE]. Parse any
            // complete event left in the buffer as well.
            const tail = buffer.trim().replace(/^data:\s*/, '')
            if (tail && tail !== '[DONE]') {
              try {
                const delta = JSON.parse(tail) as { choices?: Array<{ delta?: { content?: string | null } }> }
                const text = delta.choices?.[0]?.delta?.content
                if (typeof text === 'string') {
                  streamed += text
                  setStreamingTaskText(taskId, streamed)
                }
              } catch {
                // Ignore an incomplete trailing SSE frame.
              }
            }
            payload = { choices: [{ message: { content: streamed } }] }
          } else {
            payload = await response.json() as {
              choices?: Array<{
                message?: {
                  content?: string | null
                  tool_calls?: Array<{ function?: { name?: string; arguments?: string | Record<string, unknown> } }>
                }
              }>
            }
          }
          const message = payload.choices?.[0]?.message
          let content = typeof message?.content === 'string' ? message.content : ''
          if (task.type === 'maintenance' && message?.tool_calls?.length) {
            const suggestions = message.tool_calls.map((call) => maintenanceToolCallSuggestion(call.function?.name ?? '', call.function?.arguments ?? ''))
            if (suggestions.some((suggestion) => !suggestion)) throw new Error('Provider 返回了无法识别的维护工具调用')
            const validSuggestions = suggestions.filter((suggestion): suggestion is Record<string, unknown> => Boolean(suggestion))
            const reasons = validSuggestions
              .map((suggestion) => typeof suggestion.reason === 'string' ? suggestion.reason.trim() : '')
              .filter(Boolean)
            content = JSON.stringify({
              reason: reasons.length
                ? `模型通过维护工具提出 ${validSuggestions.length} 条建议：${reasons.slice(0, 3).join('；')}`
                : `模型通过维护工具提出 ${validSuggestions.length} 条建议，请逐条核对证据。`,
              suggestions: validSuggestions,
              disclosure_requests: [],
            })
          }
          if (!content) throw new Error('Provider 没有返回可用内容')
          const result = applyTaskResult(taskId, content, { internal: true })
          clearStreamingTaskText(taskId)
          if (result.continued) {
            // Disclosure continuation re-queues the same task. Release this
            // request's guard before immediately starting the next round.
            executingTaskIds.delete(taskId)
            return await executeTask(taskId)
          }
          return result.ok ? { ok: true } : { ok: false, error: result.errors[0] }
        } catch (error) {
          const current = tasks.value.find((item) => item.id === taskId)
          if (current?.status === 'cancelled') return { ok: false, error: '任务已取消' }
          if (controller.signal.aborted) lastError = new Error('API 请求超时')
          else lastError = error instanceof Error ? error : new Error('API 请求失败')
          const retryable = Boolean((error as { retryable?: boolean })?.retryable) || controller.signal.aborted || lastError.message.includes('Failed to fetch')
          if (!retryable || attempt === 2) break
          await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt))
        } finally {
          window.clearTimeout(timeout)
          abortControllers.delete(taskId)
        }
      }
      const message = lastError?.message ?? 'API 请求失败'
      clearStreamingTaskText(taskId)
      markTask(taskId, 'failed', undefined, [message])
      return { ok: false, error: message }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'API 请求失败'
      const current = tasks.value.find((item) => item.id === taskId)
      clearStreamingTaskText(taskId)
      if (current?.status !== 'cancelled') markTask(taskId, 'failed', undefined, [message])
      return { ok: false, error: message }
    } finally {
      executingTaskIds.delete(taskId)
    }
  }

  async function runQueue(): Promise<void> {
    if (queueRunning.value) return
    queueRunning.value = true
    try {
      while (!queuePaused.value) {
        tasks.value
          .filter((task) => task.status === 'pending' && task.mode === 'api' && task.promptVersion !== PROMPT_VERSION)
          .forEach(rejectOutdatedPendingTask)
        // Legacy databases may contain origin tasks created before triage was
        // introduced. Once a session is classified as non-knowledge those
        // tasks are ineligible forever; retire them explicitly so the queue
        // cannot appear stuck with an un-runnable pending item.
        const ineligibleOrigins = tasks.value.filter((task) => {
          if (task.type !== 'origin_concepts' || task.status !== 'pending') return false
          const sessionId = ownerSessionId(task)
          const kind = sessions.value.find((session) => session.id === sessionId)?.knowledgeKind
          return kind != null && kind !== 'unknown' && kind !== 'knowledge'
        })
        if (ineligibleOrigins.length) {
          mutate(() => ineligibleOrigins.forEach((task) => transitionTaskInTransaction(task.id, 'cancel', {
            errorMessage: '会话分类不是 knowledge，已跳过起始知识主题提取。',
          })))
          ineligibleOrigins.forEach((task) => abortControllers.get(task.id)?.abort())
        }
        const pending = tasks.value.filter((task) => task.status === 'pending' && task.mode === 'api')
        if (!pending.length) break
        const triagePending = pending.filter((task) => task.type === 'session_triage')
        const runnable = (triagePending.length ? triagePending : pending).filter((task) => {
          if (task.type !== 'origin_concepts') return true
          const sessionId = ownerSessionId(task)
          return sessions.value.find((session) => session.id === sessionId)?.knowledgeKind === 'knowledge'
        })
        // Keep at most one in-flight task per owning session so dependent
        // tasks of the same session always run in order.
        const batch: LLMTask[] = []
        const busySessions = new Set<string>()
        const limit = normalizeApiConcurrency(config.value.llm.concurrency)
        for (const task of runnable) {
          const owner = ownerSessionId(task)
          if (owner && busySessions.has(owner)) continue
          if (owner) busySessions.add(owner)
          batch.push(task)
          if (batch.length >= limit) break
        }
        if (!batch.length) break
        queueActiveCount.value += batch.length
        await Promise.all(batch.map((task) => executeTask(task.id)))
        queueActiveCount.value = Math.max(0, queueActiveCount.value - batch.length)
      }
    } finally {
      queueActiveCount.value = 0
      queueRunning.value = false
    }
  }

  function ownerSessionId(task: LLMTask): string | null {
    const targetId = task.inputRevision.split(':')[0]
    const ownerUnit = units.value.find((item) => item.id === targetId)
    return ownerUnit?.sessionId ?? targetId ?? null
  }

  function startQueue(): void {
    queuePaused.value = false
    void runQueue()
  }

  function pauseQueue(): void {
    queuePaused.value = true
  }

  function resumeQueue(): void {
    queuePaused.value = false
    void runQueue()
  }

  function segmentationInput(task: LLMTask): { sessionId: string; revision: string; start: number; end: number; total: number } {
    const parts = task.inputRevision.split(':')
    if (parts[2] === 'chunk') {
      return { sessionId: parts[0], revision: parts[1], start: Number(parts[3]), end: Number(parts[4]), total: Number(parts[5]) }
    }
    return { sessionId: parts[0], revision: parts[1], start: 0, end: Number.MAX_SAFE_INTEGER, total: 1 }
  }

  function writeSegmentation(session: Session, sessionMessages: Message[], segmentation: { units: Array<{ message_indices: number[]; title_hint?: string }>; unassigned_message_indices: number[] }, segmentationTaskIds: string[], task: LLMTask, responseText: string): void {
    mutate(() => {
      const now = isoNow()
      tasks.value
        .filter((candidate) => candidate.inputRevision.startsWith(`${session.id}:${session.revision}`) && isActiveTaskStatus(candidate.status) && !segmentationTaskIds.includes(candidate.id))
        .forEach((candidate) => transitionTaskInTransaction(candidate.id, 'invalidate'))
      const oldUnits = db.query<Row>('SELECT id FROM knowledge_units WHERE session_id = ?', [session.id]).map((row) => text(row.id))
      oldUnits.forEach((unitId) => db.run('DELETE FROM knowledge_units WHERE id = ?', [unitId]))
      db.run('UPDATE messages SET unit_id = NULL WHERE session_id = ?', [session.id])
      const root = db.query<Row>('SELECT id FROM nav_tree_nodes WHERE session_id = ? AND parent_id IS NULL LIMIT 1', [session.id])[0]
      const rootId = root ? text(root.id) : createId('nav')
      if (!root) db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, NULL, NULL, ?, 0, ?)', [rootId, session.id, session.title, now])
      segmentation.units.forEach((unitResult, index) => {
        const unitId = createId('unit')
        const unitMessages = unitResult.message_indices.map((messageIndex) => sessionMessages[messageIndex]).filter(Boolean)
        db.run('INSERT INTO knowledge_units(id, session_id, title, summary, order_in_session, status, revision, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)', [unitId, session.id, unitResult.title_hint || null, index, unitResult.title_hint ? 'ready' : 'pending', now, now])
        unitMessages.forEach((message) => {
          db.run('UPDATE messages SET unit_id = ? WHERE id = ?', [unitId, message.id])
          const metadataRow = db.query<Row>('SELECT metadata FROM messages WHERE id = ?', [message.id])[0]
          let metadata: Record<string, unknown> | null = null
          try { metadata = metadataRow?.metadata ? JSON.parse(text(metadataRow.metadata)) as Record<string, unknown> : null } catch { metadata = null }
          const declared = metadata?.concept_ids
          if (Array.isArray(declared)) declared.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).forEach((conceptId) => {
            db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unitId, conceptId.trim(), 'llm', now])
          })
        })
        const nodeId = createId('nav')
        db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, ?, NULL, ?, 1, ?)', [nodeId, session.id, rootId, unitResult.title_hint || '待命名知识单元', now])
        db.run('INSERT INTO nav_tree_node_units(node_id, unit_id, order_in_node) VALUES (?, ?, 0)', [nodeId, unitId])
        const createdUnit = unitFromRow(db.query<Row>('SELECT * FROM knowledge_units WHERE id = ?', [unitId])[0])
        createTask({ type: 'unit_metadata', mode: task.mode, providerId: task.providerId, model: task.model, promptVersion: PROMPT_VERSION, inputRevision: `${unitId}:1`, prompt: buildTitleSummaryPrompt(session, createdUnit, unitMessages, []), status: 'pending', scopeLabel: `${session.title} · 标题与摘要` })
        createTask({ type: 'concept_extraction', mode: task.mode, providerId: task.providerId, model: task.model, promptVersion: PROMPT_VERSION, inputRevision: `${unitId}:1`, prompt: buildConceptPrompt(session, createdUnit, unitMessages, [], promptDisclosureContext(), config.value.llm.conceptLimit), status: 'pending', scopeLabel: `${session.title} · 知识主题` })
      })
      db.run('UPDATE sessions SET message_count = ?, unit_count = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [sessionMessages.length, segmentation.units.length, now, session.id])
      const refreshedSession = sessionFromRow(db.query<Row>('SELECT * FROM sessions WHERE id = ?', [session.id])[0])
      tasks.value
        .filter((candidate) => candidate.type === 'origin_concepts' && candidate.scopeLabel?.startsWith(`${session.title} · 起始知识主题`) && candidate.status === 'stale')
        .forEach((candidate) => {
          if (transitionTaskInTransaction(candidate.id, 'retry', { validationErrors: null, errorMessage: null })) {
            db.run('UPDATE llm_tasks SET input_revision = ?, updated_at = ? WHERE id = ?', [`${session.id}:${refreshedSession.revision}`, now, candidate.id])
          }
        })
      segmentationTaskIds.forEach((id) => {
        if (transitionTaskInTransaction(id, 'accept_validated_result', {
          response: id === task.id ? responseText : undefined,
          parsedResult: JSON.stringify(segmentation),
          validationErrors: null,
          errorMessage: null,
        })) return
        // A completed chunk can be included in a combined result. It is
        // already terminal; refresh only its audit payload in that case.
        db.run("UPDATE llm_tasks SET response = COALESCE(?, response), parsed_result = COALESCE(parsed_result, ?), validation_errors = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'success'", [id === task.id ? responseText : null, JSON.stringify(segmentation), now, id])
      })
    })
    // The first transaction creates the new units and refreshes reactive
    // arrays. Rebuild the requeued origin prompt afterwards so its disclosure
    // catalog sees those units and any metadata-derived memberships.
    const refreshedSession = sessions.value.find((item) => item.id === session.id)
    const originTasks = tasks.value.filter((item) => item.type === 'origin_concepts' && item.status === 'pending' && item.inputRevision.startsWith(`${session.id}:`))
    if (refreshedSession && originTasks.length) {
      const originPrompt = buildOriginConceptPrompt(refreshedSession, messages.value.filter((message) => message.sessionId === session.id).sort((left, right) => left.orderInSession - right.orderInSession), promptDisclosureContext(), undefined, config.value.llm.conceptLimit)
      mutate(() => originTasks.forEach((originTask) => db.run('UPDATE llm_tasks SET prompt = ?, prompt_version = ?, updated_at = ? WHERE id = ?', [originPrompt, PROMPT_VERSION, isoNow(), originTask.id])))
    }
  }

  function applySegmentationTask(taskId: string, responseText: string): { ok: boolean; errors: string[] } {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task || task.type !== 'segmentation') return { ok: false, errors: ['找不到分段任务'] }
    let parsed: unknown
    try {
      parsed = JSON.parse(responseText)
    } catch {
      const match = responseText.match(/\{[\s\S]*\}/)
      if (!match) {
        const errors = ['响应不是有效 JSON']
        markTask(taskId, 'needs_review', responseText, errors)
        return { ok: false, errors }
      }
      try {
        parsed = JSON.parse(match[0])
      } catch {
        const errors = ['无法从响应中解析 JSON']
        markTask(taskId, 'needs_review', responseText, errors)
        return { ok: false, errors }
      }
    }
    const input = segmentationInput(task)
    const sessionId = input.sessionId
    const session = sessions.value.find((item) => item.id === sessionId)
    if (!session) return { ok: false, errors: ['任务所属会话不存在'] }
    const sessionMessages = messages.value.filter((message) => message.sessionId === sessionId).sort((a, b) => a.orderInSession - b.orderInSession)
    const expectedIndices = input.total > 1 ? sessionMessages.slice(input.start, input.end).map((message) => message.orderInSession) : undefined
    const validation = validateSegmentationResult(parsed, sessionMessages.length, expectedIndices)
    if (!validation.data) {
      const errors = validation.issues.map((issue) => `${issue.path}: ${issue.message}`)
      markTask(taskId, 'needs_review', responseText, errors)
      return { ok: false, errors }
    }
    if (input.revision !== String(session.revision)) {
      const errors = ['任务输入版本已过期，请重新生成 Prompt']
      markTask(taskId, 'stale', responseText, errors)
      return { ok: false, errors }
    }
    const segmentation = validation.data
    if (input.total > 1) {
      mutate(() => {
        if (!transitionTaskInTransaction(taskId, 'accept_validated_result', {
          response: responseText,
          parsedResult: JSON.stringify(segmentation),
          validationErrors: null,
          errorMessage: null,
        })) throw new Error('分段任务状态已变化，请重新加载后再试')
      })
      const chunkRows = db.query<Row>('SELECT * FROM llm_tasks WHERE type = ? AND input_revision LIKE ? AND status = ? ORDER BY created_at', ['segmentation', `${session.id}:${session.revision}:chunk:%`, 'success'])
      if (chunkRows.length < input.total) return { ok: true, errors: [] }
      const combined = combineSegmentationChunks(chunkRows.map((row) => JSON.parse(text(row.parsed_result)) as { units: Array<{ message_indices: number[]; title_hint?: string }>; unassigned_message_indices: number[] }), sessionMessages.length)
      if (!combined.data) {
        const errors = combined.errors
        markTask(taskId, 'needs_review', responseText, errors)
        return { ok: false, errors }
      }
      writeSegmentation(session, sessionMessages, combined.data, chunkRows.map((row) => text(row.id)), task, responseText)
      return { ok: true, errors: [] }
    }
    writeSegmentation(session, sessionMessages, segmentation, [taskId], task, responseText)
    return { ok: true, errors: [] }
  }

  function persistConfig(): void {
    writeConfig(config.value)
  }

  function updateConfig(patch: Partial<AppConfig>): void {
    const nextLlm = { ...config.value.llm, ...(patch.llm ?? {}) }
    nextLlm.concurrency = normalizeApiConcurrency(nextLlm.concurrency, config.value.llm.concurrency)
    nextLlm.conceptLimit = normalizeConceptLimit(nextLlm.conceptLimit, config.value.llm.conceptLimit)
    nextLlm.tokenBudget = normalizeTokenBudget(nextLlm.tokenBudget, config.value.llm.tokenBudget)
    config.value = {
      ...config.value,
      ...patch,
      llm: nextLlm,
      ui: { ...config.value.ui, ...(patch.ui ?? {}), graph: { ...config.value.ui.graph, ...(patch.ui?.graph ?? {}) } },
      storage: { ...config.value.storage, ...(patch.storage ?? {}) },
    }
    persistConfig()
  }

  function selectContext(unitId: string, selected: boolean): void {
    if (selected && !selectedContextIds.value.includes(unitId)) selectedContextIds.value.push(unitId)
    if (!selected) selectedContextIds.value = selectedContextIds.value.filter((id) => id !== unitId)
  }

  function selectMessageContext(messageId: string, selected: boolean): void {
    if (!messages.value.some((message) => message.id === messageId)) return
    if (selected && !selectedContextMessageIds.value.includes(messageId)) selectedContextMessageIds.value.push(messageId)
    if (!selected) selectedContextMessageIds.value = selectedContextMessageIds.value.filter((id) => id !== messageId)
  }

  function reorderContext(ids: string[]): void {
    selectedContextIds.value = ids.filter((id) => units.value.some((unit) => unit.id === id))
  }

  function clearContext(): void {
    selectedContextIds.value = []
    selectedContextMessageIds.value = []
  }

  function saveGraphLayout(entry: Omit<GraphLayoutEntry, 'layoutVersion'>): void {
    const layoutVersion = graphViewport.value.layoutVersion + 1
    db.transaction(() => db.run('INSERT INTO graph_layout(node_type, ref_id, x, y, fixed, layout_version) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(node_type, ref_id) DO UPDATE SET x = excluded.x, y = excluded.y, fixed = excluded.fixed, layout_version = excluded.layout_version', [entry.nodeType, entry.refId, entry.x, entry.y, entry.fixed ? 1 : 0, layoutVersion]))
    const existing = graphLayout.value.find((item) => item.nodeType === entry.nodeType && item.refId === entry.refId)
    const next = { ...entry, layoutVersion }
    graphLayout.value = existing
      ? graphLayout.value.map((item) => item === existing ? next : item)
      : [...graphLayout.value, next]
  }

  function saveGraphViewport(viewport: Omit<GraphViewport, 'layoutVersion'>): void {
    const layoutVersion = graphViewport.value.layoutVersion + 1
    db.transaction(() => db.run('INSERT INTO graph_viewport(id, x, y, scale, layout_version) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y, scale = excluded.scale, layout_version = excluded.layout_version', [viewport.x, viewport.y, viewport.scale, layoutVersion]))
    // 同步内存值：GraphCanvas 重渲染时按该值恢复缩放，过期会导致缩放被重置。
    graphViewport.value = { ...viewport, layoutVersion }
  }

  function resetGraphLayout(): void {
    const layoutVersion = graphViewport.value.layoutVersion + 1
    mutate(() => {
      db.run('DELETE FROM graph_layout')
      db.run('INSERT INTO graph_viewport(id, x, y, scale, layout_version) VALUES (1, 0, 0, 1, ?) ON CONFLICT(id) DO UPDATE SET x = 0, y = 0, scale = 1, layout_version = excluded.layout_version', [layoutVersion])
    })
    graphViewport.value = { x: 0, y: 0, scale: 1, layoutVersion }
  }

  function renderedPhrase(phraseId: string, topicId?: string): string {
    const phrase = quickPhrases.value.find((item) => item.id === phraseId)
    const topic = topicId ? concepts.value.find((concept) => concept.id === topicId)?.name ?? '' : ''
    const contextUnit = selectedUnits.value.find((unit) => unit.id !== selectedContextIds.value[0])
    const context = contextUnit ? unitConceptNames(contextUnit.id).join('、') || contextUnit.title || '' : ''
    return phrase ? renderQuickPhrase(phrase.template, topic, context) : ''
  }

  function addQuickPhrase(template: string): string {
    const normalized = template.trim()
    if (!normalized) throw new Error('快捷短语不能为空')
    const id = createId('phrase')
    mutate(() => db.run('INSERT INTO quick_phrases(id, template, is_builtin, sort_order) VALUES (?, ?, 0, ?)', [id, normalized, quickPhrases.value.length]))
    return id
  }

  function updateQuickPhrase(id: string, template: string): void {
    const normalized = template.trim()
    if (!normalized) throw new Error('快捷短语不能为空')
    mutate(() => db.run('UPDATE quick_phrases SET template = ? WHERE id = ? AND is_builtin = 0', [normalized, id]))
  }

  function removeQuickPhrase(id: string): void {
    mutate(() => db.run('DELETE FROM quick_phrases WHERE id = ? AND is_builtin = 0', [id]))
  }

  function buildConversationHistory(sessionId: string, maxMessages = 40, branchNodeId?: string, excludeMessageId?: string): string {
    const sessionMessages = messages.value
      .filter((message) => message.sessionId === sessionId)
      .sort((left, right) => left.orderInSession - right.orderInSession)
    const pathNodeIds = branchNodeId ? (() => {
      const byId = new Map(navNodes.value.filter((node) => node.sessionId === sessionId).map((node) => [node.id, node]))
      const ids = new Set<string>()
      const seen = new Set<string>()
      let current = byId.get(branchNodeId)
      while (current && !seen.has(current.id)) {
        seen.add(current.id)
        ids.add(current.id)
        current = current.parentId ? byId.get(current.parentId) : undefined
      }
      return ids
    })() : null
    const rootNodeIds = new Set(navNodes.value
      .filter((node) => node.sessionId === sessionId && !node.parentId)
      .map((node) => node.id))
    const history = sessionMessages.filter((message) => {
      if (excludeMessageId && message.id === excludeMessageId) return false
      if (!pathNodeIds) return true
      const branchId = conversationMessageBranchNodeId(message, sessionMessages)
      if (branchId != null) return pathNodeIds.has(branchId)
      // Imported and legacy messages predate the navigation metadata. They
      // are presented on the synthetic root card, so continuing from any
      // descendant of that root must keep them in the conversation context.
      return [...rootNodeIds].some((rootId) => pathNodeIds.has(rootId))
    })
    if (!history.length) return ''
    const visible = history.length > maxMessages ? history.slice(-maxMessages) : history
    const omitted = history.length - visible.length
    const prefix = omitted > 0 ? `（已省略较早的 ${omitted} 条消息）\n` : ''
    return prefix + visible.map((message) => `消息 #${message.orderInSession + 1} [${message.role}]\n${message.content}`).join('\n\n')
  }

  function buildNavigationPath(sessionId: string, nodeId: string): string {
    const byId = new Map(navNodes.value.filter((node) => node.sessionId === sessionId).map((node) => [node.id, node]))
    const path: NavTreeNode[] = []
    const seen = new Set<string>()
    let current = byId.get(nodeId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      path.unshift(current)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return path.map((node, index) => `${index + 1}. ${node.label}`).join('\n')
  }

  function buildConversationContext(sourceUnitIds: string[], sourceMessageIds: string[], includeFullContent: boolean): string {
    const sourceUnits = sourceUnitIds.map((id) => units.value.find((unit) => unit.id === id)).filter(Boolean) as KnowledgeUnit[]
    const unitBlocks = sourceUnits.map((unit, index) => {
      const session = sessions.value.find((item) => item.id === unit.sessionId)
      const full = includeFullContent ? `\n原文：${unitMessages(unit.id).map((message) => `${message.role}: ${message.content}`).join('\n')}` : ''
      return `# ${index + 1} ${unit.title || '未命名知识单元'}\n来源 Session：${session?.title || ''}\n摘要：${unit.summary || ''}\nConcept：${unitConceptNames(unit.id).join('、')}${full}`
    })
    const messageBlocks = sourceMessageIds.map((id, index) => {
      const message = messages.value.find((item) => item.id === id)
      if (!message) return ''
      const session = sessions.value.find((item) => item.id === message.sessionId)
      return `# 消息 ${index + 1}\n来源 Session：${session?.title || ''}\n角色：${message.role}\n原文：${message.content}`
    }).filter(Boolean)
    return [...unitBlocks, ...messageBlocks].join('\n\n')
  }

  /** Start a brand-new session seeded with one user question. */
  function createConversationTask(input: { question: string; topicId?: string; topicIds?: string[]; parentNodeId?: string; sourceUnitIds?: string[]; sourceMessageIds?: string[]; includeFullContent?: boolean }): string {
    const question = input.question.trim()
    if (!question) throw new Error('问题不能为空')
    const sourceUnitIds = input.sourceUnitIds ?? selectedContextIds.value
    const sourceMessageIds = input.sourceMessageIds ?? selectedContextMessageIds.value
    const sourceSession = input.parentNodeId ? navNodes.value.find((node) => node.id === input.parentNodeId)?.sessionId : undefined
    const targetSessionId = createId('session')
    const assistantMessageId = createId('message')
    const now = isoNow()
    const topicIds = [...new Set((input.topicIds?.length ? input.topicIds : input.topicId ? [input.topicId] : [])
      .filter((id) => concepts.value.some((concept) => concept.id === id && concept.status === 'active')))]
    const primaryTopicId = topicIds[0]
    const topic = primaryTopicId ? concepts.value.find((concept) => concept.id === primaryTopicId)?.name : undefined
    const selectedTopicNames = topicIds.map((id) => concepts.value.find((concept) => concept.id === id)?.name).filter(Boolean) as string[]
    const topicContext = selectedTopicNames.length ? `\n\n用户选定知识主题：${selectedTopicNames.join('、')}` : ''
    const context = `${buildConversationContext(sourceUnitIds, sourceMessageIds, input.includeFullContent ?? false)}${topicContext}`
    mutate(() => {
      db.run('INSERT INTO sessions(id, source, platform, model, external_session_id, title, created_at, updated_at, message_count, unit_count, revision, local_only) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, 0, 1, 0)', [targetSessionId, 'in_app', 'local', null, topic ? `围绕 ${topic} 的新对话` : '新的知识对话', now, now])
      const messageId = createId('message')
      db.run('INSERT INTO messages(id, session_id, unit_id, role, content, order_in_session, timestamp, metadata) VALUES (?, ?, NULL, ?, ?, 0, ?, ?)', [messageId, targetSessionId, 'user', question, now, JSON.stringify({ mode: 'new', topicId: primaryTopicId ?? null, topicIds })])
      // A topic chosen in the composer is an explicit fact about both the new
      // Session and its opening Message. Keep it immediately queryable even
      // before the first assistant result creates an optional KnowledgeUnit.
      topicIds.forEach((topicId) => {
        db.run('INSERT OR IGNORE INTO session_concepts(session_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [targetSessionId, topicId, 'manual', now])
        db.run('INSERT OR IGNORE INTO message_concepts(message_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [messageId, topicId, 'manual', now])
      })
      const rootId = createId('nav')
      db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [rootId, targetSessionId, null, primaryTopicId ?? null, topic ? `围绕 ${topic}` : '新的知识对话', 0, now])
      const selectedTopicPath = topicIds.flatMap((topicId) => conceptExpansionPath(topicId, true))
      const taskId = createTask({ type: 'conversation', mode: config.value.llm.mode ?? 'prompt_paste', providerId: config.value.llm.defaultProvider, model: null, promptVersion: PROMPT_VERSION, inputRevision: `${targetSessionId}:1`, prompt: buildConversationPrompt({ question, topic, context, targetSessionId, targetMessageId: messageId, targetAssistantMessageId: assistantMessageId, navigationPath: `1. ${topic ? `围绕 ${topic}` : '新的知识对话'}`, conversationHistory: '', sessionTitle: topic ? `围绕 ${topic} 的新对话` : '新的知识对话', sessionSummary: '', availableUnits: [], conceptLimit: config.value.llm.conceptLimit, disclosure: promptDisclosureContext({ unitIds: sourceUnitIds, messageIds: sourceMessageIds, expandedRefIds: selectedTopicPath, includeFullContent: input.includeFullContent ?? false }) }), status: 'pending', scopeLabel: `新对话 · ${topic || '知识探索'}` })
      db.run('UPDATE messages SET metadata = ? WHERE id = ?', [JSON.stringify({ mode: 'new', topicId: primaryTopicId ?? null, topicIds, parentNodeId: rootId, taskId, answerMessageId: assistantMessageId, sourceSessionId: sourceSession ?? null }), messageId])
      writeSourceReferences(targetSessionId, sourceUnitIds, sourceMessageIds, input.includeFullContent ?? false)
    })
    return targetSessionId
  }

  function writeSourceReferences(targetSessionId: string, sourceUnitIds: string[], sourceMessageIds: string[], includeFullContent: boolean): void {
    let order = 0
    sourceUnitIds.forEach((unitId) => {
      const unit = units.value.find((item) => item.id === unitId)
      if (!unit) return
      db.run('INSERT INTO context_references(id, target_session_id, source_session_id, source_unit_id, source_message_id, order_in_context, include_full_content) VALUES (?, ?, ?, ?, NULL, ?, ?)', [createId('context'), targetSessionId, unit.sessionId, unit.id, order++, includeFullContent ? 1 : 0])
    })
    sourceMessageIds.forEach((messageId) => {
      const message = messages.value.find((item) => item.id === messageId)
      if (!message) return
      db.run('INSERT INTO context_references(id, target_session_id, source_session_id, source_unit_id, source_message_id, order_in_context, include_full_content) VALUES (?, ?, ?, NULL, ?, ?, 1)', [createId('context'), targetSessionId, message.sessionId, message.id, order++])
    })
  }

  /**
   * Continue exploring inside an existing session: the question becomes a new
   * message and its answer will branch from the given navigation node.
   */
  function createFollowUpTask(input: { sessionId: string; parentNodeId: string; question: string; topicId?: string; topicIds?: string[]; sourceUnitIds?: string[]; sourceMessageIds?: string[]; includeFullContent?: boolean }): string {
    const question = input.question.trim()
    if (!question) throw new Error('问题不能为空')
    const session = sessions.value.find((item) => item.id === input.sessionId)
    if (!session) throw new Error('找不到目标会话')
    const unfinished = tasks.value.find((task) =>
      task.type === 'conversation'
      && task.inputRevision.startsWith(`${input.sessionId}:`)
      && ['pending', 'running', 'needs_review'].includes(task.status),
    )
    if (unfinished) throw new Error('当前会话已有待完成的追问，请先处理上一条结果')
    const parentNode = navNodes.value.find((node) => node.id === input.parentNodeId && node.sessionId === input.sessionId)
    if (!parentNode) throw new Error('找不到要继续的探索节点')
    const now = isoNow()
    const revision = session.revision
    const nextOrder = messages.value.filter((message) => message.sessionId === session.id).length
    const assistantMessageId = createId('message')
    const context = buildConversationContext(input.sourceUnitIds ?? [], input.sourceMessageIds ?? [], input.includeFullContent ?? false)
    const topicIds = [...new Set((input.topicIds?.length ? input.topicIds : input.topicId ? [input.topicId] : [])
      .filter((id) => concepts.value.some((concept) => concept.id === id && concept.status === 'active')))]
    const primaryTopicId = topicIds[0]
    const topic = primaryTopicId ? concepts.value.find((concept) => concept.id === primaryTopicId)?.name : undefined
    const selectedTopicNames = topicIds.map((id) => concepts.value.find((concept) => concept.id === id)?.name).filter(Boolean) as string[]
    const topicContext = selectedTopicNames.length ? `\n\n用户选定知识主题：${selectedTopicNames.join('、')}` : ''
    const contextWithTopics = `${context}${topicContext}`
    // A follow-up must know which Concepts this Session has already created
    // or reused; otherwise a previously hidden child can be emitted again as
    // a duplicate new Concept. Expand only the ancestor paths already visited
    // by this Session, preserving the progressive disclosure contract while
    // making existing markers and refIDs available to the next answer.
    const sessionMessageIds = new Set(messages.value.filter((message) => message.sessionId === session.id).map((message) => message.id))
    const sessionUnitIds = new Set(units.value.filter((unit) => unit.sessionId === session.id).map((unit) => unit.id))
    const currentSessionConceptIds = new Set<string>()
    sessionConcepts.value.filter((link) => link.sessionId === session.id).forEach((link) => currentSessionConceptIds.add(link.conceptId))
    messageConcepts.value.filter((link) => sessionMessageIds.has(link.messageId)).forEach((link) => currentSessionConceptIds.add(link.conceptId))
    unitConcepts.value.filter((link) => sessionUnitIds.has(link.unitId)).forEach((link) => currentSessionConceptIds.add(link.conceptId))
    messages.value.filter((message) => message.sessionId === session.id).forEach((message) => {
      const ids = message.metadata?.concept_ids
      if (Array.isArray(ids)) ids.filter((id): id is string => typeof id === 'string').forEach((id) => currentSessionConceptIds.add(id))
    })
    // A topic explicitly selected for this follow-up is authoritative input
    // even when it has not yet been linked to the Session by a prior answer.
    // Include its ancestor path in DISCLOSURE_INDEX so the model can reuse
    // the real ID instead of echoing it as a response-local Concept.
    topicIds.forEach((topicId) => currentSessionConceptIds.add(topicId))
    const expandedSessionConceptPaths = [...currentSessionConceptIds].flatMap((conceptId) => conceptExpansionPath(conceptId, true))
    let taskId = ''
    mutate(() => {
      const messageId = createId('message')
      db.run('INSERT INTO messages(id, session_id, unit_id, role, content, order_in_session, timestamp, metadata) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)', [messageId, session.id, 'user', question, nextOrder, now, JSON.stringify({ mode: 'follow_up', parentNodeId: parentNode.id, topicId: primaryTopicId ?? null, topicIds })])
      topicIds.forEach((topicId) => {
        db.run('INSERT OR IGNORE INTO session_concepts(session_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [session.id, topicId, 'manual', now])
        db.run('INSERT OR IGNORE INTO message_concepts(message_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [messageId, topicId, 'manual', now])
      })
      db.run('UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?', [now, session.id])
      taskId = createTask({ type: 'conversation', mode: config.value.llm.mode ?? 'prompt_paste', providerId: config.value.llm.defaultProvider, model: null, promptVersion: PROMPT_VERSION, inputRevision: `${session.id}:${revision}`, prompt: buildConversationPrompt({ question, topic, context: contextWithTopics, navigationPath: buildNavigationPath(session.id, parentNode.id), conversationHistory: buildConversationHistory(session.id, 40, parentNode.id, messageId), sessionTitle: session.title, sessionSummary: session.summary ?? '', availableUnits: units.value.filter((unit) => unit.sessionId === session.id).map((unit) => ({ id: unit.id, title: unit.title ?? '', summary: unit.summary ?? '' })), conceptLimit: config.value.llm.conceptLimit, targetSessionId: session.id, targetMessageId: messageId, targetAssistantMessageId: assistantMessageId, disclosure: promptDisclosureContext({ unitIds: input.sourceUnitIds ?? [], messageIds: input.sourceMessageIds ?? [], includeFullContent: input.includeFullContent ?? false, expandedRefIds: expandedSessionConceptPaths }) }), status: 'pending', scopeLabel: `${session.title} · 追问` })
      db.run('UPDATE messages SET metadata = ? WHERE id = ?', [JSON.stringify({ mode: 'follow_up', topicId: primaryTopicId ?? null, topicIds, parentNodeId: parentNode.id, taskId, answerMessageId: assistantMessageId }), messageId])
      writeSourceReferences(session.id, input.sourceUnitIds ?? [], input.sourceMessageIds ?? [], input.includeFullContent ?? false)
    })
    return taskId
  }

  function setSelectedSession(sessionId: string | null): void {
    selectedSessionId.value = sessionId
  }

  function search(query: string): { concepts: Concept[]; units: KnowledgeUnit[]; messages: Message[] } {
    if (!normalizeText(query)) return { concepts: [], units: [], messages: [] }
    const ftsRanks = new Map(db.searchFts(query).map((match) => [`${match.kind}:${match.refId}`, match.rank]))
    const matches = searchKnowledge(query, {
      concepts: activeConcepts.value,
      aliases: aliases.value,
      units: units.value.filter((unit) => activeSessionIds.value.has(unit.sessionId)),
      messages: messages.value.filter((message) => activeSessionIds.value.has(message.sessionId)),
    }, ftsRanks)
    return {
      concepts: matches.concepts.map((match) => match.item),
      units: matches.units.map((match) => match.item),
      messages: matches.messages.map((match) => match.item),
    }
  }

  async function createDatabaseBackup(): Promise<string | null> {
    const backup = await db.createBackup()
    return backup.reference
  }

  function clearAllData(): void {    mutate(() => {
      db.run('DELETE FROM context_references')
      db.run('DELETE FROM nav_tree_node_units')
      db.run('DELETE FROM nav_tree_nodes')
      db.run('DELETE FROM unit_concepts')
      db.run('DELETE FROM session_concepts')
      db.run('DELETE FROM message_concepts')
      db.run('DELETE FROM concept_relations')
      db.run('DELETE FROM concept_aliases')
      db.run('DELETE FROM manual_graph_edges')
      db.run('DELETE FROM knowledge_units')
      db.run('DELETE FROM messages')
      db.run('DELETE FROM sessions')
      db.run('DELETE FROM concepts')
      db.run('DELETE FROM llm_tasks')
      db.run('DELETE FROM graph_layout')
      db.run('DELETE FROM graph_viewport')
      db.run('DELETE FROM operation_log')
    })
    selectedContextIds.value = []
    selectedContextMessageIds.value = []
  }

  return {
    ready,
    loading,
    sessions,
    messages,
    units,
    concepts,
    aliases,
    unitConcepts,
    sessionConcepts,
    messageConcepts,
    relations,
    navNodes,
    navNodeUnits,
    tasks,
    contextReferences,
    manualEdges,
    graphRevision,
    config,
    configWarning,
    selectedContextIds,
    selectedContextMessageIds,
    selectedSessionId,
    lastImport,
    queueRunning,
    queuePaused,
    queueActiveCount,
    streamingTaskText,
    streamingTaskPreview,
    activeSessions,
    activeConcepts,
    pendingTaskCount,
    selectedUnits,
    selectedContextMessages,
    stats,
    init,
    refreshFromDb,
    viewGraph,
    createTask,
    exportKnowledgeBase,
    importKnowledgeBase,
    graphStats,
    unitMessages,
    unitConceptNames,
    promptDisclosureContext,
    hierarchyRelations,
    conceptParentIds,
    conceptChildIds,
    conceptParents,
    conceptChildren,
    conceptAncestors,
    conceptDescendants,
    rootConcepts,
    conceptExpansionPath,
    toggleConceptExpansion,
    importPayload,
    importJsonText,
    importJsonTextWithMode,
    updateUnit,
    updateConcept,
    updateConceptNotes,
    toggleSessionLocalOnly,
    createConcept,
    addConceptToUnit,
    setMessageConcept,
    setSessionConcept,
    setUnitConcept,
    createRelation,
    setConceptParent,
    addConceptChild,
    promoteConcept,
    removeConceptFromParent,
    confirmRelation,
    mergeConcept,
    deleteConcept,
    restoreConcept,
    markTask,
    applyTaskResult,
    createMaintenanceTask,
    maintenanceActionApi: MAINTENANCE_ACTION_API,
    maintenanceMcpTools: listMaintenanceMcpTools(),
    formatMaintenanceActionApi,
    maintenanceSuggestionErrors,
    applyMaintenanceSuggestion,
    retryTask,
    cancelTask,
    executeTask,
    startQueue,
    pauseQueue,
    resumeQueue,
    applySegmentationTask,
    persistConfig,
    updateConfig,
    changeDatabasePath,
    selectContext,
    selectMessageContext,
    reorderContext,
    clearContext,
    setSelectedSession,
    search,
    createDatabaseBackup,
    clearAllData,
    addManualGraphEdge,
    removeManualGraphEdge,
    operationLogs,
    undoOperation,
    deleteRelation,
    promoteConceptChild,
    graphLayout,
    graphViewport,
    saveGraphLayout,
    saveGraphViewport,
    resetGraphLayout,
    buildRepairPrompt,
    quickPhrases,
    renderedPhrase,
    addQuickPhrase,
    updateQuickPhrase,
    removeQuickPhrase,
    createConversationTask,
    createFollowUpTask,
  }
})
