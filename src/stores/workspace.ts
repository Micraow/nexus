import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/services/db'
import { httpRequest } from '@/services/http'
import { parseConfigText, readConfigText, writeConfig } from '@/services/config'
import { buildGraph, graphStats } from '@/services/graph'
import { buildSearchDocuments, searchKnowledge } from '@/services/search'
import { buildConceptPrompt, buildConversationPrompt, buildMaintenancePrompt, buildRepairPrompt, buildSegmentationPrompt, buildSessionTriagePrompt, buildTitleSummaryPrompt, PROMPT_VERSION, renderQuickPhrase } from '@/services/prompts'
import { importPayloadSchema, parseImportPayload, validateSegmentationResult, validateUnitText } from '@/services/validation'
import { combineSegmentationChunks, splitMessageChunks } from '@/utils/chunks'
import { wouldCreateHierarchyCycle } from '@/utils/graph-rules'
import { createId, isoNow, normalizeText, parseIsoTimestamp, stableHash } from '@/utils/id'
import { parseMetadata } from '@/utils/metadata'
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
  ImportPayload,
  ImportReport,
  KnowledgeUnit,
  LLMTask,
  MaintenanceSuggestion,
  ManualGraphEdge,
  Message,
  NavTreeNode,
  NavTreeNodeUnit,
  OperationLog,
  QuickPhrase,
  Session,
  UnitConcept,
} from '@/types/domain'
import type { GraphWorkerResponse } from '@/workers/graph.worker'

type Row = Record<string, unknown>

const DEFAULT_CONFIG: AppConfig = {
  llm: { mode: null, defaultProvider: null, concurrency: 2, tokenBudget: 8000, providers: [], taskOverrides: {} },
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
    notes: text(row.notes),
    status: text(row.status) as Concept['status'],
    mergedIntoId: row.merged_into_id == null ? null : text(row.merged_into_id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    deletedAt: row.deleted_at == null ? null : text(row.deleted_at),
  }
}

function taskFromRow(row: Row): LLMTask {
  return {
    id: text(row.id),
    type: text(row.type) as LLMTask['type'],
    mode: text(row.mode) as LLMTask['mode'],
    providerId: row.provider_id == null ? null : text(row.provider_id),
    model: row.model == null ? null : text(row.model),
    promptVersion: text(row.prompt_version),
    inputRevision: text(row.input_revision),
    prompt: text(row.prompt),
    response: row.response == null ? null : text(row.response),
    parsedResult: row.parsed_result == null ? null : text(row.parsed_result),
    validationErrors: row.validation_errors == null ? null : text(row.validation_errors),
    status: text(row.status) as LLMTask['status'],
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
  const graphPendingKeys = new Set<string>()
  const graphTick = ref(0)
  let lastGraphSnapshot: GraphSnapshot | null = null
  let graphWorker: Worker | null = null
  const queueRunning = ref(false)
  const queuePaused = ref(false)
  const queueActiveCount = ref(0)
  const abortControllers = new Map<string, AbortController>()

  const activeSessions = computed(() => sessions.value.filter((session) => !session.deletedAt))
  const activeSessionIds = computed(() => new Set(activeSessions.value.map((session) => session.id)))
  const activeConcepts = computed(() => concepts.value.filter((concept) => concept.status === 'active'))
  const pendingTaskCount = computed(() => tasks.value.filter((task) => ['pending', 'running', 'needs_review'].includes(task.status)).length)
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
    graphPendingKeys.clear()
    lastGraphSnapshot = null
    db.rebuildSearchDocuments(buildSearchDocuments({
      concepts: concepts.value,
      aliases: aliases.value,
      units: units.value.filter((unit) => activeSessionIds.value.has(unit.sessionId)),
      messages: messages.value.filter((message) => activeSessionIds.value.has(message.sessionId)),
    }))
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

  function mutate(callback: () => void): void {
    db.transaction(() => {
      callback()
      db.bumpGraphRevision()
    })
    refreshFromDb()
  }

  interface GraphViewOptions {
    showUnits?: boolean
    showMessages?: boolean
    showProposed?: boolean
    showRetainedSessions?: boolean
    expandedConceptIds?: string[]
  }

  function graphCacheKey(options: GraphViewOptions): string {
    const expanded = [...(options.expandedConceptIds ?? [])].sort().join(',')
    return `${graphRevision.value}:${options.showUnits ? 1 : 0}:${options.showMessages ? 1 : 0}:${options.showProposed ? 1 : 0}:${options.showRetainedSessions ? 1 : 0}:${expanded}`
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

  function graphInputFor(options: GraphViewOptions) {
    const activeUnits = units.value.filter((unit) => activeSessionIds.value.has(unit.sessionId))
    const activeUnitIds = new Set(activeUnits.map((unit) => unit.id))
    return {
      concepts: concepts.value,
      units: activeUnits,
      messages: messages.value.filter((message) => activeSessionIds.value.has(message.sessionId)),
      sessions: sessions.value.filter((session) => activeSessionIds.value.has(session.id)),
      unitConcepts: unitConcepts.value.filter((link) => activeUnitIds.has(link.unitId)),
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
        const prepared = applyGraphLayout(snapshot)
        graphSnapshots.set(key, prepared)
        lastGraphSnapshot = prepared
        graphTick.value += 1
      }
      graphWorker = worker
    } catch {
      graphWorker = null
    }
    return graphWorker
  }

  function computeGraphSync(key: string, options: GraphViewOptions): void {
    const snapshot = applyGraphLayout(buildGraph(graphInputFor(options)))
    graphSnapshots.set(key, snapshot)
    lastGraphSnapshot = snapshot
  }

  /** Cached graph view; heavy co-occurrence computation runs inside a worker. */
  function viewGraph(options: GraphViewOptions = {}): GraphSnapshot {
    void graphTick.value
    const key = graphCacheKey(options)
    const cached = graphSnapshots.get(key)
    if (cached) {
      lastGraphSnapshot = cached
      return cached
    }
    const worker = ensureGraphWorker()
    if (worker) {
      if (!graphPendingKeys.has(key)) {
        graphPendingKeys.add(key)
        // Pinia 的响应式代理无法结构化克隆，必须先还原成普通 JSON 数据。
        worker.postMessage({ key, ...toPlainJson(graphInputFor(options)) })
      }
    } else {
      computeGraphSync(key, options)
    }
    return lastGraphSnapshot ?? applyGraphLayout({ nodes: [], edges: [], revision: graphRevision.value })
  }

  function unitMessages(unitId: string): Message[] {
    return messages.value.filter((message) => message.unitId === unitId).sort((a, b) => a.orderInSession - b.orderInSession)
  }

  function unitConceptNames(unitId: string): string[] {
    const ids = unitConcepts.value.filter((link) => link.unitId === unitId).map((link) => link.conceptId)
    return ids.map((id) => concepts.value.find((concept) => concept.id === id)?.name).filter(Boolean) as string[]
  }

  function createTask(task: Omit<LLMTask, 'id' | 'createdAt' | 'updatedAt' | 'retryCount'>): string {
    const id = createId('task')
    const now = isoNow()
    db.run(
      `INSERT INTO llm_tasks(id, type, mode, provider_id, model, prompt_version, input_revision, prompt, response, parsed_result, validation_errors, status, retry_count, error_message, created_at, updated_at, scope_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [id, task.type, task.mode, task.providerId ?? null, task.model ?? null, task.promptVersion, task.inputRevision, task.prompt, task.response ?? null, task.parsedResult ?? null, task.validationErrors ?? null, task.status, task.errorMessage ?? null, now, now, task.scopeLabel ?? null],
    )
    return id
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
      records.sessions.forEach((item: Session) => db.run('INSERT INTO sessions(id, source, platform, model, external_session_id, title, created_at, updated_at, message_count, unit_count, knowledge_kind, knowledge_confidence, knowledge_judgment, knowledge_retain_in_graph, revision, local_only, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.source, item.platform, item.model ?? null, item.externalSessionId ?? null, item.title, item.createdAt, item.updatedAt, item.messageCount, item.unitCount, item.knowledgeKind ?? 'unknown', item.knowledgeConfidence ?? null, item.knowledgeJudgment ?? null, item.knowledgeRetainInGraph ? 1 : 0, item.revision, item.localOnly ? 1 : 0, item.deletedAt ?? null]))
      records.concepts.forEach((item: Concept) => db.run('INSERT INTO concepts(id, name, normalized_name, notes, status, merged_into_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.name, item.normalizedName, item.notes, item.status, item.mergedIntoId ?? null, item.createdAt, item.updatedAt, item.deletedAt ?? null]))
      records.units.forEach((item: KnowledgeUnit) => db.run('INSERT INTO knowledge_units(id, session_id, title, summary, order_in_session, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.sessionId, item.title ?? null, item.summary ?? null, item.orderInSession, item.status, item.revision, item.createdAt, item.updatedAt]))
      records.messages.forEach((item: Message) => db.run('INSERT INTO messages(id, session_id, unit_id, role, content, order_in_session, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.sessionId, item.unitId ?? null, item.role, item.content, item.orderInSession, item.timestamp ?? null, item.metadata ? JSON.stringify(item.metadata) : null]))
      records.aliases.forEach((item: ConceptAlias) => db.run('INSERT INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [item.id, item.conceptId, item.alias, item.normalizedAlias, item.source, item.createdAt]))
      records.unit_concepts.forEach((item: UnitConcept) => db.run('INSERT INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [item.unitId, item.conceptId, item.source, item.createdAt]))
      records.relations.forEach((item: ConceptRelation) => db.run('INSERT INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.parentConceptId, item.childConceptId, item.relationType, item.source, item.status, item.createdAt, item.updatedAt]))
      records.nav_nodes.forEach((item: NavTreeNode) => db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.sessionId, item.parentId ?? null, item.triggerConceptId ?? null, item.label, item.depth, item.createdAt]))
      records.nav_node_units.forEach((item: NavTreeNodeUnit) => db.run('INSERT INTO nav_tree_node_units(node_id, unit_id, order_in_node) VALUES (?, ?, ?)', [item.nodeId, item.unitId, item.orderInNode]))
      records.context_references.forEach((item: ContextReference) => db.run('INSERT INTO context_references(id, target_session_id, source_session_id, source_unit_id, source_message_id, order_in_context, include_full_content) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.targetSessionId, item.sourceSessionId, item.sourceUnitId ?? null, item.sourceMessageId ?? null, item.orderInContext, item.includeFullContent ? 1 : 0]))
      records.tasks.forEach((item: LLMTask) => db.run('INSERT INTO llm_tasks(id, type, mode, provider_id, model, prompt_version, input_revision, prompt, response, parsed_result, validation_errors, status, retry_count, error_message, created_at, updated_at, scope_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.type, item.mode, item.providerId ?? null, item.model ?? null, item.promptVersion, item.inputRevision, item.prompt, item.response ?? null, item.parsedResult ?? null, item.validationErrors ?? null, item.status, item.retryCount, item.errorMessage ?? null, item.createdAt, item.updatedAt, item.scopeLabel ?? null]))
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
          db.run(
            'INSERT INTO messages(id, session_id, role, content, order_in_session, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [createId('message'), sessionId, role, message.content ?? '', index, parseIsoTimestamp(message.timestamp) ?? null, message.metadata ? JSON.stringify(message.metadata) : null],
          )
        })
        const rootId = createId('nav')
        db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, NULL, NULL, ?, 0, ?)', [rootId, sessionId, conversation.title?.trim() || '起始对话', now])
        const session = sessionFromRow(db.query<Row>('SELECT * FROM sessions WHERE id = ?', [sessionId])[0])
        const importedMessages = db.query<Row>('SELECT * FROM messages WHERE session_id = ? ORDER BY order_in_session', [sessionId]).map(messageFromRow)
        const chunks = splitMessageChunks(importedMessages, config.value.llm.tokenBudget)
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
        chunks.forEach((chunk, chunkIndex) => {
          const chunkSuffix = chunks.length > 1 ? `:chunk:${chunk.start}:${chunk.end}:${chunks.length}` : ''
          const taskId = createTask({
            type: 'segmentation',
            mode: config.value.llm.mode ?? 'prompt_paste',
            providerId: config.value.llm.defaultProvider,
            model: null,
            promptVersion: PROMPT_VERSION,
            inputRevision: `${session.id}:${session.revision}${chunkSuffix}`,
            prompt: buildSegmentationPrompt(session, chunk.messages, chunks.length > 1 ? `${chunkIndex + 1}/${chunks.length}（全局索引 ${chunk.start}～${chunk.end - 1}，含相邻重叠消息）` : undefined),
            status: 'pending',
            scopeLabel: chunks.length > 1 ? `${session.title} · 分段 ${chunkIndex + 1}/${chunks.length}` : session.title,
          })
          report.taskIds.push(taskId)
        })
        const originTaskId = createTask({
          type: 'origin_concepts',
          mode: config.value.llm.mode ?? 'prompt_paste',
          providerId: config.value.llm.defaultProvider,
          model: null,
          promptVersion: PROMPT_VERSION,
          inputRevision: `${session.id}:${session.revision}`,
          prompt: `请从下面的 Session 中提取 1～8 个核心 Concept，并给出有明确证据的 Concept 关系。探讨或流程内容也可以提取其中稳定的知识；不要为了凑数建立关系。关系必须有消息中的直接证据，不能因为两个主题共同出现或“看起来有关”就连接；最多返回 0～2 条最强关系。hierarchy 使用 source 作为父主题、target 作为子主题；related 是无向关联，不存在父子顺序。只返回 JSON：{"concepts":[{"name":"...","aliases":[]}],"relations":[{"source":"Concept 名称","target":"Concept 名称","type":"hierarchy|related"}]}\n\n${importedMessages.map((message) => `${message.role}: ${message.content}`).join('\n')}`,
          status: 'pending',
          scopeLabel: `${session.title} · 起始知识主题`,
        })
        report.taskIds.push(originTaskId)
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
      db.run("UPDATE llm_tasks SET status = 'stale', updated_at = ? WHERE input_revision LIKE ? AND status IN ('pending', 'running', 'needs_review')", [now, `${unitId}:%`])
    })
  }

  function updateConceptNotes(conceptId: string, notes: string): void {
    mutate(() => db.run('UPDATE concepts SET notes = ?, updated_at = ? WHERE id = ?', [notes, isoNow(), conceptId]))
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
    db.run('INSERT INTO concepts(id, name, normalized_name, notes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, name.trim(), normalized, '', 'active', now, now])
    void source
    return id
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
      relations: db.query<Row>('SELECT * FROM concept_relations'),
      manual_edges: db.query<Row>('SELECT * FROM manual_graph_edges'),
      graph_layout: db.query<Row>('SELECT * FROM graph_layout'),
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
      relations: Row[]
      manual_edges: Row[]
      graph_layout: Row[]
      knowledge_units?: Row[]
      sessions?: Row[]
      tasks?: Row[]
    }
    db.run('DELETE FROM unit_concepts')
    db.run('DELETE FROM concept_aliases')
    db.run('DELETE FROM concept_relations')
    db.run('DELETE FROM manual_graph_edges')
    db.run('DELETE FROM graph_layout')
    db.run('DELETE FROM concepts')
    snapshot.concepts.forEach((row) => db.run('INSERT INTO concepts(id, name, normalized_name, notes, status, merged_into_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [text(row.id), text(row.name), text(row.normalized_name), text(row.notes), text(row.status), row.merged_into_id ?? null, text(row.created_at), text(row.updated_at), row.deleted_at ?? null]))
    snapshot.aliases.forEach((row) => db.run('INSERT INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [text(row.id), text(row.concept_id), text(row.alias), text(row.normalized_alias), text(row.source), text(row.created_at)]))
    snapshot.unit_concepts.forEach((row) => db.run('INSERT INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [text(row.unit_id), text(row.concept_id), text(row.source), text(row.created_at)]))
    snapshot.relations.forEach((row) => db.run('INSERT INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [text(row.id), text(row.parent_concept_id), text(row.child_concept_id), text(row.relation_type), text(row.source), text(row.status), text(row.created_at), text(row.updated_at)]))
    snapshot.manual_edges.forEach((row) => db.run('INSERT INTO manual_graph_edges(id, source_type, source_ref_id, target_type, target_ref_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [text(row.id), text(row.source_type), text(row.source_ref_id), text(row.target_type), text(row.target_ref_id), row.label ?? null, text(row.created_at)]))
    snapshot.graph_layout.forEach((row) => db.run('INSERT INTO graph_layout(node_type, ref_id, x, y, fixed, layout_version) VALUES (?, ?, ?, ?, ?, ?)', [text(row.node_type), text(row.ref_id), number(row.x), number(row.y), bool(row.fixed) ? 1 : 0, number(row.layout_version, 1)]))
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

    const mergedNotes = [text(target.notes), text(source.notes) ? `来自 ${sourceName} 的笔记：${text(source.notes)}` : ''].filter(Boolean).join('\n\n')
    db.run('UPDATE concepts SET notes = ?, updated_at = ? WHERE id = ?', [mergedNotes, now, targetId])
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
    mutate(() => {
      const task = tasks.value.find((item) => item.id === taskId)
      if (!task) return
      const nextPrompt = status === 'needs_review' && response ? buildRepairPrompt(response, errors ?? []) : task.prompt
      db.run('UPDATE llm_tasks SET status = ?, response = COALESCE(?, response), validation_errors = ?, error_message = ?, prompt = ?, retry_count = retry_count + ?, updated_at = ? WHERE id = ?', [status, response ?? null, errors ? JSON.stringify(errors) : null, errors?.[0] ?? null, nextPrompt, status === 'failed' || status === 'needs_review' ? 1 : 0, isoNow(), taskId])
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

  function createMaintenanceTask(input: { conceptIds?: string[]; unitIds?: string[]; includeFullContent?: boolean } = {}): string {
    const requestedConceptIds = input.conceptIds?.length ? new Set(input.conceptIds) : null
    const requestedUnitIds = input.unitIds?.length ? new Set(input.unitIds) : null
    const inferredConceptIds = requestedUnitIds
      ? new Set(unitConcepts.value.filter((link) => requestedUnitIds.has(link.unitId)).map((link) => link.conceptId))
      : null
    const conceptScope = (requestedConceptIds ? [...requestedConceptIds] : inferredConceptIds ? [...inferredConceptIds] : activeConcepts.value.map((concept) => concept.id))
      .map((id) => concepts.value.find((concept) => concept.id === id))
      .filter(Boolean) as Concept[]
    const inferredUnitIds = requestedConceptIds
      ? new Set(unitConcepts.value.filter((link) => requestedConceptIds.has(link.conceptId)).map((link) => link.unitId))
      : null
    const unitScope = (requestedUnitIds ? [...requestedUnitIds] : inferredUnitIds ? [...inferredUnitIds] : units.value.filter((unit) => unit.sessionId && activeSessionIds.value.has(unit.sessionId)).map((unit) => unit.id))
      .map((id) => units.value.find((unit) => unit.id === id))
      .filter(Boolean) as KnowledgeUnit[]
    if (!conceptScope.length && !unitScope.length) throw new Error('没有可供维护检查的知识主题或知识单元')
    const conceptIds = new Set(conceptScope.map((concept) => concept.id))
    const unitIds = new Set(unitScope.map((unit) => unit.id))
    const prompt = buildMaintenancePrompt({
      concepts: conceptScope.map((concept) => ({ id: concept.id, name: concept.name, aliases: aliases.value.filter((alias) => alias.conceptId === concept.id).map((alias) => alias.alias), notes: concept.notes })),
      relations: relations.value.filter((relation) => conceptIds.has(relation.parentConceptId) || conceptIds.has(relation.childConceptId)).map((relation) => ({ sourceId: relation.parentConceptId, targetId: relation.childConceptId, type: relation.relationType, status: relation.status })),
      units: unitScope.map((unit) => ({ id: unit.id, title: unit.title ?? '', summary: unit.summary ?? '', session: sessions.value.find((session) => session.id === unit.sessionId)?.title ?? '', conceptIds: unitConcepts.value.filter((link) => link.unitId === unit.id).map((link) => link.conceptId) })),
      includeMessages: input.includeFullContent ? unitScope.map((unit) => `## ${unit.id}\n${unitMessages(unit.id).map((message) => `${message.role}: ${message.content}`).join('\n')}`).join('\n\n') : undefined,
    })
    let taskId = ''
    mutate(() => {
      taskId = createTask({ type: 'maintenance', mode: config.value.llm.mode ?? 'prompt_paste', providerId: config.value.llm.defaultProvider, model: null, promptVersion: PROMPT_VERSION, inputRevision: `maintenance:${stableHash(JSON.stringify({ concepts: [...conceptIds], units: [...unitIds] }))}`, prompt, status: 'pending', scopeLabel: `维护建议 · ${conceptScope.length} 个知识主题 · ${unitScope.length} 个知识单元` })
    })
    return taskId
  }

  function maintenanceSuggestionErrors(value: unknown): { suggestions: MaintenanceSuggestion[]; errors: string[] } {
    const errors: string[] = []
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { suggestions: [], errors: ['维护结果必须是 JSON 对象'] }
    const rawSuggestions = (value as Record<string, unknown>).suggestions
    if (!Array.isArray(rawSuggestions)) return { suggestions: [], errors: ['suggestions 必须是数组'] }
    const suggestions = rawSuggestions.map((item) => item && typeof item === 'object' ? item as MaintenanceSuggestion : { type: '' as MaintenanceSuggestion['type'] })
    suggestions.forEach((suggestion, index) => {
      if (!['merge', 'alias', 'relation', 'unit_relink', 'unit_revision'].includes(String(suggestion.type))) errors.push(`suggestions.${index}.type 不受支持`)
      if (suggestion.type === 'merge') {
        if (!concepts.value.some((concept) => concept.id === suggestion.source_concept_id)) errors.push(`suggestions.${index} 的源知识主题不存在`)
        if (!concepts.value.some((concept) => concept.id === suggestion.target_concept_id)) errors.push(`suggestions.${index} 的目标知识主题不存在`)
        if (suggestion.source_concept_id === suggestion.target_concept_id) errors.push(`suggestions.${index} 不能合并自身`)
      }
      if (suggestion.type === 'alias') {
        if (!concepts.value.some((concept) => concept.id === suggestion.concept_id)) errors.push(`suggestions.${index} 的知识主题不存在`)
        if (!suggestion.alias?.trim()) errors.push(`suggestions.${index}.alias 不能为空`)
      }
      if (suggestion.type === 'relation') {
        const sourceId = suggestion.source_concept_id ?? suggestion.parent_concept_id
        const targetId = suggestion.target_concept_id ?? suggestion.child_concept_id
        if (!concepts.value.some((concept) => concept.id === sourceId) || !concepts.value.some((concept) => concept.id === targetId)) errors.push(`suggestions.${index} 的关系端点不存在`)
        if (sourceId === targetId) errors.push(`suggestions.${index} 不能连接自身`)
        if (suggestion.relation_type !== 'hierarchy' && suggestion.relation_type !== 'related') errors.push(`suggestions.${index}.relation_type 无效`)
        if (suggestion.relation_type === 'hierarchy' && sourceId && targetId && wouldCreateHierarchyCycle(sourceId, targetId, relations.value)) errors.push(`suggestions.${index} 会形成父子关系环`)
      }
      if (suggestion.type === 'unit_relink') {
        if (!units.value.some((unit) => unit.id === suggestion.unit_id)) errors.push(`suggestions.${index} 的知识单元不存在`)
        if (!concepts.value.some((concept) => concept.id === suggestion.concept_id)) errors.push(`suggestions.${index} 的知识主题不存在`)
      }
      if (suggestion.type === 'unit_revision') {
        if (!units.value.some((unit) => unit.id === suggestion.unit_id)) errors.push(`suggestions.${index} 的知识单元不存在`)
        if (!suggestion.title?.trim() && !suggestion.summary?.trim()) errors.push(`suggestions.${index} 至少需要标题或摘要`)
        errors.push(...validateUnitText(suggestion.title, suggestion.summary).map((issue) => `suggestions.${index}.${issue.path}：${issue.message}`))
      }
    })
    return { suggestions, errors }
  }

  function applyMaintenanceSuggestion(taskId: string, suggestionIndex: number): { ok: boolean; error?: string } {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task || task.type !== 'maintenance' || !task.parsedResult) return { ok: false, error: '维护任务结果尚未校验' }
    let parsed: unknown
    try { parsed = JSON.parse(task.parsedResult) } catch { return { ok: false, error: '维护结果无法解析' } }
    const validation = maintenanceSuggestionErrors(parsed)
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
        } else if (suggestion.type === 'relation') {
          const rawSourceId = suggestion.source_concept_id ?? suggestion.parent_concept_id
          const rawTargetId = suggestion.target_concept_id ?? suggestion.child_concept_id
          const [sourceId, targetId] = suggestion.relation_type === 'related' && rawSourceId && rawTargetId && rawSourceId > rawTargetId
            ? [rawTargetId, rawSourceId]
            : [rawSourceId, rawTargetId]
          db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [createId('relation'), sourceId, targetId, suggestion.relation_type, 'maintenance', 'proposed', now, now])
        } else if (suggestion.type === 'unit_relink') {
          db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [suggestion.unit_id, suggestion.concept_id, 'maintenance', now])
        } else if (suggestion.type === 'unit_revision') {
          const unit = units.value.find((item) => item.id === suggestion.unit_id)
          if (!unit) throw new Error('知识单元不存在')
          db.run('UPDATE knowledge_units SET title = COALESCE(?, title), summary = COALESCE(?, summary), revision = revision + 1, status = \'ready\', updated_at = ? WHERE id = ?', [suggestion.title?.trim() || null, suggestion.summary?.trim() || null, now, suggestion.unit_id])
          db.run('UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?', [now, unit.sessionId])
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

  function applyTaskResult(taskId: string, responseText: string): { ok: boolean; errors: string[] } {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task) return { ok: false, errors: ['找不到任务'] }
    if (task.type === 'segmentation') return applySegmentationTask(taskId, responseText)
    const parsed = parseStructuredResponse(responseText)
    if (!parsed.data) {
      const errors = [parsed.error ?? '响应格式错误']
      markTask(taskId, 'needs_review', responseText, errors)
      return { ok: false, errors }
    }
    const data = parsed.data
    const errors: string[] = []
    const inputParts = task.inputRevision.split(':')
    const targetId = inputParts[0]
    const targetRevision = inputParts[1]

    if (task.type === 'maintenance') {
      const validation = maintenanceSuggestionErrors(data)
      if (validation.errors.length) {
        markTask(taskId, 'needs_review', responseText, validation.errors)
        return { ok: false, errors: validation.errors }
      }
      mutate(() => {
        db.run('UPDATE llm_tasks SET status = ?, response = ?, parsed_result = ?, validation_errors = NULL, error_message = NULL, updated_at = ? WHERE id = ?', ['success', responseText, JSON.stringify(data), isoNow(), taskId])
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
        db.run('UPDATE llm_tasks SET status = ?, response = ?, parsed_result = ?, validation_errors = NULL, error_message = NULL, updated_at = ? WHERE id = ?', ['success', responseText, JSON.stringify(data), now, taskId])
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
        db.run('UPDATE llm_tasks SET status = ?, response = ?, parsed_result = ?, validation_errors = NULL, updated_at = ? WHERE id = ?', ['success', responseText, JSON.stringify(data), now, taskId])
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
        db.run('UPDATE llm_tasks SET status = ?, response = ?, parsed_result = ?, validation_errors = NULL, updated_at = ? WHERE id = ?', ['success', responseText, JSON.stringify(data), now, taskId])
      })
      return { ok: true, errors: [] }
    }

    if (task.type === 'concept_extraction' || task.type === 'origin_concepts') {
      const rawConcepts = data.concepts
      if (!Array.isArray(rawConcepts) || rawConcepts.length === 0) errors.push('concepts 必须是非空数组')
      const candidates = Array.isArray(rawConcepts) ? rawConcepts.map((candidate) => {
        if (typeof candidate === 'string') return { name: candidate, aliases: [] as string[] }
        if (!candidate || typeof candidate !== 'object') return { name: '', aliases: [] as string[] }
        const item = candidate as Record<string, unknown>
        return { name: typeof item.name === 'string' ? item.name : '', aliases: Array.isArray(item.aliases) ? item.aliases.filter((alias): alias is string => typeof alias === 'string') : [] }
      }) : []
      candidates.forEach((candidate) => { if (!normalizeText(candidate.name)) errors.push('Concept 名称不能为空') })
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
          candidate.aliases.forEach((alias) => {
            const normalizedAlias = normalizeText(alias)
            if (!normalizedAlias || normalizedAlias === normalizeText(candidate.name)) return
            db.run('INSERT OR IGNORE INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('alias'), conceptId, alias.trim(), normalizedAlias, 'llm', now])
          })
        })
        if (task.type === 'concept_extraction' && unit) {
          conceptIds.forEach((conceptId) => db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unit.id, conceptId, 'llm', now]))
        }
        if (task.type === 'origin_concepts' && session) {
          units.value.filter((item) => item.sessionId === session.id).forEach((sessionUnit) => conceptIds.forEach((conceptId) => db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [sessionUnit.id, conceptId, 'llm', now])))
        }
        const pendingRelations: ConceptRelation[] = []
        const relationKeys = new Set<string>(relations.value.map((relation) => {
          const pair = relation.relationType === 'related'
            ? [relation.parentConceptId, relation.childConceptId].sort().join('|')
            : `${relation.parentConceptId}|${relation.childConceptId}`
          return `${relation.relationType}:${pair}`
        }))
        if (Array.isArray(data.relations)) data.relations.slice(0, 2).forEach((rawRelation) => {
          if (!rawRelation || typeof rawRelation !== 'object') return
          const value = rawRelation as Record<string, unknown>
          const sourceName = typeof value.source === 'string' ? value.source : typeof value.parent === 'string' ? value.parent : typeof value.source_name === 'string' ? value.source_name : typeof value.parent_name === 'string' ? value.parent_name : ''
          const targetName = typeof value.target === 'string' ? value.target : typeof value.child === 'string' ? value.child : typeof value.target_name === 'string' ? value.target_name : typeof value.child_name === 'string' ? value.child_name : ''
          const sourceRawId = conceptIdsByName.get(normalizeText(sourceName))
          const targetRawId = conceptIdsByName.get(normalizeText(targetName))
          const relationType = value.type === 'related' ? 'related' as const : value.type === 'hierarchy' ? 'hierarchy' as const : null
          if (!sourceRawId || !targetRawId || !relationType || sourceRawId === targetRawId) return
          const [sourceId, targetId] = relationType === 'related' && sourceRawId > targetRawId ? [targetRawId, sourceRawId] : [sourceRawId, targetRawId]
          if (relationType === 'hierarchy' && wouldCreateHierarchyCycle(sourceId, targetId, [...relations.value, ...pendingRelations])) return
          const pair = relationType === 'related' ? [sourceId, targetId].sort().join('|') : `${sourceId}|${targetId}`
          const relationKey = `${relationType}:${pair}`
          if (relationKeys.has(relationKey)) return
          relationKeys.add(relationKey)
          const relation: ConceptRelation = { id: createId('relation'), parentConceptId: sourceId, childConceptId: targetId, relationType, source: 'llm', status: 'proposed', createdAt: now, updatedAt: now }
          pendingRelations.push(relation)
          db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [relation.id, sourceId, targetId, relationType, 'llm', 'proposed', now, now])
        })
        db.run('UPDATE llm_tasks SET status = ?, response = ?, parsed_result = ?, validation_errors = NULL, updated_at = ? WHERE id = ?', ['success', responseText, JSON.stringify(data), now, taskId])
      })
      return { ok: true, errors: [] }
    }

    if (task.type === 'conversation') {
      const answer = data.answer
      const rawUnits = data.units
      if (typeof answer !== 'string' || !answer.trim()) errors.push('answer 必须是非空字符串')
      if (!Array.isArray(rawUnits) || rawUnits.length === 0) errors.push('units 必须是非空数组')
      const conversationSession = sessions.value.find((item) => item.id === targetId)
      const userMessage = messages.value.find((message) => {
        if (message.sessionId !== targetId || message.role !== 'user') return false
        return parseMetadata(message.metadata).taskId === task.id
      })
      if (!conversationSession) errors.push('找不到对话目标会话')
      else if (!userMessage) errors.push('找不到这次提问对应的消息')
      if (String(conversationSession?.revision ?? '') !== targetRevision) errors.push('任务输入版本已过期，请重新生成 Prompt')
      const normalizedUnits = Array.isArray(rawUnits) ? rawUnits.map((item) => {
        const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
        const concepts = Array.isArray(value.concepts) ? value.concepts : []
        return {
          title: typeof value.title === 'string' ? value.title.trim() : '',
          summary: typeof value.summary === 'string' ? value.summary.trim() : '',
          concepts: concepts.map((concept) => typeof concept === 'string' ? { name: concept, aliases: [] as string[] } : concept && typeof concept === 'object' ? { name: typeof (concept as Record<string, unknown>).name === 'string' ? String((concept as Record<string, unknown>).name) : '', aliases: Array.isArray((concept as Record<string, unknown>).aliases) ? ((concept as Record<string, unknown>).aliases as unknown[]).filter((alias): alias is string => typeof alias === 'string') : [] } : { name: '', aliases: [] as string[] }),
        }
      }) : []
      normalizedUnits.forEach((unit) => {
        if (!unit.title) errors.push('对话知识单元标题不能为空')
        if (validateUnitText(unit.title, unit.summary).length) errors.push('对话知识单元标题或摘要超出长度限制')
        unit.concepts.forEach((concept) => { if (!normalizeText(concept.name)) errors.push('对话返回的知识主题名称不能为空') })
      })
      if (errors.length) {
        markTask(taskId, errors.some((error) => error.includes('版本')) ? 'stale' : 'needs_review', responseText, errors)
        return { ok: false, errors }
      }
      mutate(() => {
        const now = isoNow()
        const meta = parseMetadata(userMessage?.metadata) as { mode?: string; parentNodeId?: string | null; topicId?: string | null }
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
        const branchNodeId = createId('nav')
        db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [branchNodeId, targetId, parentNodeId, meta.topicId ?? null, normalizedUnits[0]?.title || '对话回答', parentDepth + 1, now])
        const sessionMessages = messages.value.filter((message) => message.sessionId === targetId).sort((left, right) => left.orderInSession - right.orderInSession)
        const assistantOrder = sessionMessages.length ? sessionMessages[sessionMessages.length - 1].orderInSession + 1 : 1
        const assistantMessageId = createId('message')
        db.run('INSERT INTO messages(id, session_id, unit_id, role, content, order_in_session, timestamp, metadata) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)', [assistantMessageId, targetId, 'assistant', String(answer).trim(), assistantOrder, now, JSON.stringify({ taskId })])
        const unitOffset = units.value.filter((unit) => unit.sessionId === targetId).length
        normalizedUnits.forEach((item, index) => {
          const unitId = createId('unit')
          db.run('INSERT INTO knowledge_units(id, session_id, title, summary, order_in_session, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', [unitId, targetId, item.title, item.summary || null, unitOffset + index, item.summary ? 'ready' : 'pending', now, now])
          if (index === 0 && userMessage) db.run('UPDATE messages SET unit_id = ? WHERE id IN (?, ?)', [unitId, userMessage.id, assistantMessageId])
          db.run('INSERT INTO nav_tree_node_units(node_id, unit_id, order_in_node) VALUES (?, ?, ?)', [branchNodeId, unitId, index])
          item.concepts.forEach((candidate) => {
            const conceptId = ensureConcept(candidate.name, 'llm')
            db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unitId, conceptId, 'llm', now])
            candidate.aliases.forEach((alias) => {
              const normalizedAlias = normalizeText(alias)
              if (normalizedAlias && normalizedAlias !== normalizeText(candidate.name)) db.run('INSERT OR IGNORE INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('alias'), conceptId, alias.trim(), normalizedAlias, 'llm', now])
            })
          })
        })
        if (followUp) {
          db.run('UPDATE sessions SET unit_count = unit_count + ?, revision = revision + 1, updated_at = ? WHERE id = ?', [normalizedUnits.length, now, targetId])
        } else {
          db.run('UPDATE sessions SET message_count = 2, unit_count = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [normalizedUnits.length, now, targetId])
        }
        db.run('UPDATE llm_tasks SET status = ?, response = ?, parsed_result = ?, validation_errors = NULL, error_message = NULL, updated_at = ? WHERE id = ?', ['success', responseText, JSON.stringify(data), now, taskId])
      })
      return { ok: true, errors: [] }
    }

    mutate(() => db.run('UPDATE llm_tasks SET status = ?, response = ?, parsed_result = ?, validation_errors = NULL, updated_at = ? WHERE id = ?', ['success', responseText, JSON.stringify(data), isoNow(), taskId]))
    return { ok: true, errors: [] }
  }

  function retryTask(taskId: string): void {
    mutate(() => db.run("UPDATE llm_tasks SET status = 'pending', error_message = NULL, validation_errors = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'needs_review', 'stale', 'cancelled')", [isoNow(), taskId]))
  }

  function cancelTask(taskId: string): void {
    mutate(() => db.run("UPDATE llm_tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'running')", [isoNow(), taskId]))
    abortControllers.get(taskId)?.abort()
  }

  async function executeTask(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task) return { ok: false, error: '找不到任务' }
    if (task.mode !== 'api') return { ok: false, error: 'Prompt 粘贴模式需要手动执行 Prompt' }
    const provider = config.value.llm.providers.find((item) => item.id === task.providerId) ?? config.value.llm.providers.find((item) => item.id === config.value.llm.defaultProvider)
    if (!provider?.baseUrl || !provider.apiKey) return { ok: false, error: '请先在设置中填写 API Base URL 和 API Key' }
    const targetId = task.inputRevision.split(':')[0]
    const ownerUnit = units.value.find((item) => item.id === targetId)
    const session = sessions.value.find((item) => item.id === (ownerUnit?.sessionId ?? targetId))
    if (session?.localOnly) return { ok: false, error: '该会话已标记为仅本地，禁止 API 任务；可以改用 Prompt 粘贴模式' }
    mutate(() => db.run("UPDATE llm_tasks SET status = 'running', updated_at = ? WHERE id = ?", [isoNow(), taskId]))
    let lastError: Error | null = null
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController()
        abortControllers.set(taskId, controller)
        const timeout = window.setTimeout(() => controller.abort(), 45_000)
        try {
          const response = await httpRequest(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
            body: JSON.stringify({ model: task.model || provider.model, temperature: 0, messages: [{ role: 'user', content: task.prompt }] }),
            signal: controller.signal,
          })
          if (!response.ok) {
            const retryable = response.status === 408 || response.status === 429 || response.status >= 500
            throw Object.assign(new Error(`Provider 返回 HTTP ${response.status}`), { retryable })
          }
          const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
          const content = payload.choices?.[0]?.message?.content
          if (!content) throw new Error('Provider 没有返回可用内容')
          const result = applyTaskResult(taskId, content)
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
      markTask(taskId, 'failed', undefined, [message])
      return { ok: false, error: message }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'API 请求失败'
      const current = tasks.value.find((item) => item.id === taskId)
      if (current?.status !== 'cancelled') markTask(taskId, 'failed', undefined, [message])
      return { ok: false, error: message }
    }
  }

  async function runQueue(): Promise<void> {
    if (queueRunning.value) return
    queueRunning.value = true
    try {
      while (!queuePaused.value) {
        const pending = tasks.value.filter((task) => task.status === 'pending' && task.mode === 'api')
        if (!pending.length) break
        // Keep at most one in-flight task per owning session so dependent
        // tasks of the same session always run in order.
        const batch: LLMTask[] = []
        const busySessions = new Set<string>()
        const limit = Math.max(1, Math.min(4, config.value.llm.concurrency))
        for (const task of pending) {
          const owner = ownerSessionId(task)
          if (owner && busySessions.has(owner)) continue
          if (owner) busySessions.add(owner)
          batch.push(task)
          if (batch.length >= limit) break
        }
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
      db.run("UPDATE llm_tasks SET status = 'stale', updated_at = ? WHERE input_revision LIKE ? AND status IN ('pending', 'running', 'needs_review')", [now, `${session.id}:${session.revision}%`])
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
        unitMessages.forEach((message) => db.run('UPDATE messages SET unit_id = ? WHERE id = ?', [unitId, message.id]))
        const nodeId = createId('nav')
        db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, ?, NULL, ?, 1, ?)', [nodeId, session.id, rootId, unitResult.title_hint || '待命名知识单元', now])
        db.run('INSERT INTO nav_tree_node_units(node_id, unit_id, order_in_node) VALUES (?, ?, 0)', [nodeId, unitId])
        const createdUnit = unitFromRow(db.query<Row>('SELECT * FROM knowledge_units WHERE id = ?', [unitId])[0])
        createTask({ type: 'unit_metadata', mode: task.mode, providerId: task.providerId, model: task.model, promptVersion: PROMPT_VERSION, inputRevision: `${unitId}:1`, prompt: buildTitleSummaryPrompt(session, createdUnit, unitMessages, []), status: 'pending', scopeLabel: `${session.title} · 标题与摘要` })
        createTask({ type: 'concept_extraction', mode: task.mode, providerId: task.providerId, model: task.model, promptVersion: PROMPT_VERSION, inputRevision: `${unitId}:1`, prompt: buildConceptPrompt(session, createdUnit, unitMessages, []), status: 'pending', scopeLabel: `${session.title} · 知识主题` })
      })
      db.run('UPDATE sessions SET message_count = ?, unit_count = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [sessionMessages.length, segmentation.units.length, now, session.id])
      const refreshedSession = sessionFromRow(db.query<Row>('SELECT * FROM sessions WHERE id = ?', [session.id])[0])
      db.run("UPDATE llm_tasks SET status = 'pending', input_revision = ?, validation_errors = NULL, error_message = NULL, updated_at = ? WHERE type = 'origin_concepts' AND scope_label LIKE ? AND status = 'stale'", [`${session.id}:${refreshedSession.revision}`, now, `${session.title} · 起始知识主题%`])
      segmentationTaskIds.forEach((id) => db.run('UPDATE llm_tasks SET status = ?, response = CASE WHEN id = ? THEN ? ELSE response END, parsed_result = COALESCE(parsed_result, ?), validation_errors = NULL, error_message = NULL, updated_at = ? WHERE id = ?', ['success', id, responseText, JSON.stringify(segmentation), now, id]))
    })
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
      mutate(() => db.run('UPDATE llm_tasks SET status = ?, response = ?, parsed_result = ?, validation_errors = NULL, error_message = NULL, updated_at = ? WHERE id = ?', ['success', responseText, JSON.stringify(segmentation), isoNow(), taskId]))
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
    config.value = {
      ...config.value,
      ...patch,
      llm: { ...config.value.llm, ...(patch.llm ?? {}) },
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
  function createConversationTask(input: { question: string; topicId?: string; parentNodeId?: string; sourceUnitIds?: string[]; sourceMessageIds?: string[]; includeFullContent?: boolean }): string {
    const question = input.question.trim()
    if (!question) throw new Error('问题不能为空')
    const sourceUnitIds = input.sourceUnitIds ?? selectedContextIds.value
    const sourceMessageIds = input.sourceMessageIds ?? selectedContextMessageIds.value
    const sourceSession = input.parentNodeId ? navNodes.value.find((node) => node.id === input.parentNodeId)?.sessionId : undefined
    const targetSessionId = createId('session')
    const now = isoNow()
    const topic = input.topicId ? concepts.value.find((concept) => concept.id === input.topicId)?.name : undefined
    const context = buildConversationContext(sourceUnitIds, sourceMessageIds, input.includeFullContent ?? false)
    mutate(() => {
      db.run('INSERT INTO sessions(id, source, platform, model, external_session_id, title, created_at, updated_at, message_count, unit_count, revision, local_only) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, 0, 1, 0)', [targetSessionId, 'in_app', 'local', null, topic ? `围绕 ${topic} 的新对话` : '新的知识对话', now, now])
      const messageId = createId('message')
      db.run('INSERT INTO messages(id, session_id, unit_id, role, content, order_in_session, timestamp, metadata) VALUES (?, ?, NULL, ?, ?, 0, ?, ?)', [messageId, targetSessionId, 'user', question, now, JSON.stringify({ mode: 'new', topicId: input.topicId ?? null })])
      const rootId = createId('nav')
      db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [rootId, targetSessionId, null, input.topicId ?? null, topic ? `围绕 ${topic}` : '新的知识对话', 0, now])
      const taskId = createTask({ type: 'conversation', mode: config.value.llm.mode ?? 'prompt_paste', providerId: config.value.llm.defaultProvider, model: null, promptVersion: PROMPT_VERSION, inputRevision: `${targetSessionId}:1`, prompt: buildConversationPrompt({ question, topic, context }), status: 'pending', scopeLabel: `新对话 · ${topic || '知识探索'}` })
      db.run('UPDATE messages SET metadata = ? WHERE id = ?', [JSON.stringify({ mode: 'new', topicId: input.topicId ?? null, parentNodeId: rootId, taskId, sourceSessionId: sourceSession ?? null }), messageId])
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
  function createFollowUpTask(input: { sessionId: string; parentNodeId: string; question: string; topicId?: string; sourceUnitIds?: string[]; sourceMessageIds?: string[]; includeFullContent?: boolean }): string {
    const question = input.question.trim()
    if (!question) throw new Error('问题不能为空')
    const session = sessions.value.find((item) => item.id === input.sessionId)
    if (!session) throw new Error('找不到目标会话')
    const parentNode = navNodes.value.find((node) => node.id === input.parentNodeId && node.sessionId === input.sessionId)
    if (!parentNode) throw new Error('找不到要继续的探索节点')
    const now = isoNow()
    const revision = session.revision
    const nextOrder = messages.value.filter((message) => message.sessionId === session.id).length
    const context = buildConversationContext(input.sourceUnitIds ?? [], input.sourceMessageIds ?? [], input.includeFullContent ?? false)
    const topic = input.topicId ? concepts.value.find((concept) => concept.id === input.topicId)?.name : undefined
    let taskId = ''
    mutate(() => {
      const messageId = createId('message')
      db.run('INSERT INTO messages(id, session_id, unit_id, role, content, order_in_session, timestamp, metadata) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)', [messageId, session.id, 'user', question, nextOrder, now, JSON.stringify({ mode: 'follow_up', parentNodeId: parentNode.id })])
      db.run('UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?', [now, session.id])
      taskId = createTask({ type: 'conversation', mode: config.value.llm.mode ?? 'prompt_paste', providerId: config.value.llm.defaultProvider, model: null, promptVersion: PROMPT_VERSION, inputRevision: `${session.id}:${revision}`, prompt: buildConversationPrompt({ question, topic, context }), status: 'pending', scopeLabel: `${session.title} · 追问` })
      db.run('UPDATE messages SET metadata = ? WHERE id = ?', [JSON.stringify({ mode: 'follow_up', topicId: input.topicId ?? null, parentNodeId: parentNode.id, taskId }), messageId])
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
    importPayload,
    importJsonText,
    importJsonTextWithMode,
    updateUnit,
    updateConceptNotes,
    toggleSessionLocalOnly,
    addConceptToUnit,
    setUnitConcept,
    createRelation,
    confirmRelation,
    mergeConcept,
    deleteConcept,
    restoreConcept,
    markTask,
    applyTaskResult,
    createMaintenanceTask,
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
