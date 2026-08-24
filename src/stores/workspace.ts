import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/services/db'
import { parseConfigText, readConfigText, writeConfig } from '@/services/config'
import { buildGraph, graphStats } from '@/services/graph'
import { buildConceptPrompt, buildRepairPrompt, buildSegmentationPrompt, buildSummaryPrompt, buildTitlePrompt, PROMPT_VERSION } from '@/services/prompts'
import { importPayloadSchema, parseImportPayload, validateSegmentationResult, validateUnitText } from '@/services/validation'
import { createId, isoNow, normalizeText, parseIsoTimestamp, stableHash } from '@/utils/id'
import type {
  AppConfig,
  Concept,
  ConceptAlias,
  ConceptRelation,
  ContextReference,
  GraphSnapshot,
  ImportPayload,
  ImportReport,
  KnowledgeUnit,
  LLMTask,
  ManualGraphEdge,
  Message,
  NavTreeNode,
  NavTreeNodeUnit,
  Session,
  UnitConcept,
} from '@/types/domain'

type Row = Record<string, unknown>

const DEFAULT_CONFIG: AppConfig = {
  llm: { mode: null, defaultProvider: null, concurrency: 2, providers: [], taskOverrides: {} },
  prompts: { overrideDir: '' },
  ui: { theme: 'system', reducedMotion: false, graph: { showUnits: false, showMessages: false, showProposed: false } },
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
    revision: number(row.revision, 1),
    localOnly: bool(row.local_only),
    deletedAt: row.deleted_at == null ? null : text(row.deleted_at),
  }
}

function messageFromRow(row: Row): Message {
  let metadata: Record<string, unknown> | null = null
  if (row.metadata) {
    try {
      metadata = JSON.parse(text(row.metadata)) as Record<string, unknown>
    } catch {
      metadata = null
    }
  }
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
  const graphRevision = ref(1)
  const config = ref<AppConfig>(structuredClone(DEFAULT_CONFIG))
  const selectedContextIds = ref<string[]>([])
  const selectedSessionId = ref<string | null>(null)
  const lastImport = ref<ImportReport | null>(null)
  const graphCache = new Map<string, GraphSnapshot>()

  const activeSessions = computed(() => sessions.value.filter((session) => !session.deletedAt))
  const activeSessionIds = computed(() => new Set(activeSessions.value.map((session) => session.id)))
  const activeConcepts = computed(() => concepts.value.filter((concept) => concept.status === 'active'))
  const pendingTaskCount = computed(() => tasks.value.filter((task) => ['pending', 'running', 'needs_review'].includes(task.status)).length)
  const selectedUnits = computed(() => selectedContextIds.value.map((id) => units.value.find((unit) => unit.id === id)).filter(Boolean) as KnowledgeUnit[])
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
    graphRevision.value = Number(db.getMeta('graph_revision') ?? '1')
    graphCache.clear()
  }

  async function init(): Promise<void> {
    if (ready.value || loading.value) return
    loading.value = true
    await db.init()
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
        config.value = structuredClone(DEFAULT_CONFIG)
      }
    }
    refreshFromDb()
    ready.value = true
    loading.value = false
  }

  function mutate(callback: () => void): void {
    db.transaction(() => {
      callback()
      db.bumpGraphRevision()
    })
    refreshFromDb()
  }

  function getGraph(options: { showUnits?: boolean; showMessages?: boolean; showProposed?: boolean; expandedConceptIds?: string[] } = {}): GraphSnapshot {
    const expanded = [...(options.expandedConceptIds ?? [])].sort().join(',')
    const key = `${graphRevision.value}:${options.showUnits ? 1 : 0}:${options.showMessages ? 1 : 0}:${options.showProposed ? 1 : 0}:${expanded}`
    const cached = graphCache.get(key)
    if (cached) return cached
    const snapshot = buildGraph({
      concepts: concepts.value,
      units: units.value.filter((unit) => activeSessionIds.value.has(unit.sessionId)),
      messages: messages.value.filter((message) => activeSessionIds.value.has(message.sessionId)),
      unitConcepts: unitConcepts.value.filter((link) => units.value.some((unit) => unit.id === link.unitId && activeSessionIds.value.has(unit.sessionId))),
      relations: relations.value,
      manualEdges: manualEdges.value,
      revision: graphRevision.value,
      ...options,
    })
    graphCache.set(key, snapshot)
    return snapshot
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
      ;['context_references', 'nav_tree_node_units', 'nav_tree_nodes', 'manual_graph_edges', 'unit_concepts', 'concept_aliases', 'concept_relations', 'knowledge_units', 'messages', 'llm_tasks', 'sessions', 'concepts'].forEach((table) => db.run(`DELETE FROM ${table}`))
      const records = parsed as any
      records.sessions.forEach((item: Session) => db.run('INSERT INTO sessions(id, source, platform, model, external_session_id, title, created_at, updated_at, message_count, unit_count, revision, local_only, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.source, item.platform, item.model ?? null, item.externalSessionId ?? null, item.title, item.createdAt, item.updatedAt, item.messageCount, item.unitCount, item.revision, item.localOnly ? 1 : 0, item.deletedAt ?? null]))
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
        const taskId = createTask({
          type: 'segmentation',
          mode: config.value.llm.mode ?? 'prompt_paste',
          providerId: config.value.llm.defaultProvider,
          model: null,
          promptVersion: PROMPT_VERSION,
          inputRevision: `${session.id}:${session.revision}`,
          prompt: buildSegmentationPrompt(session, importedMessages),
          status: 'pending',
          scopeLabel: session.title,
        })
        report.taskIds.push(taskId)
        const originTaskId = createTask({
          type: 'origin_concepts',
          mode: config.value.llm.mode ?? 'prompt_paste',
          providerId: config.value.llm.defaultProvider,
          model: null,
          promptVersion: PROMPT_VERSION,
          inputRevision: `${session.id}:${session.revision}`,
          prompt: `请从下面的 Session 中提取 1～3 个核心 Concept，只返回 JSON：{"concepts":["..."]}\n\n${importedMessages.map((message) => `${message.role}: ${message.content}`).join('\n')}`,
          status: 'pending',
          scopeLabel: `${session.title} · 起源 Concept`,
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
        if (!unit || !concept) throw new Error('KnowledgeUnit 或 Concept 不存在')
        const belongsToUnitSession = messages.value.some((message) => message.unitId === unitId && message.sessionId === unit.sessionId)
        if (!belongsToUnitSession) throw new Error('KnowledgeUnit 必须包含当前 Session 的消息')
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
      if (!unit) throw new Error('KnowledgeUnit 不存在')
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

  function wouldCreateCycle(parentId: string, childId: string): boolean {
    if (parentId === childId) return true
    const children = new Map<string, string[]>()
    relations.value.filter((relation) => relation.relationType === 'hierarchy' && relation.status !== 'rejected').forEach((relation) => {
      const current = children.get(relation.parentConceptId) ?? []
      current.push(relation.childConceptId)
      children.set(relation.parentConceptId, current)
    })
    const stack = [childId]
    const visited = new Set<string>()
    while (stack.length) {
      const current = stack.pop() as string
      if (current === parentId) return true
      if (visited.has(current)) continue
      visited.add(current)
      stack.push(...(children.get(current) ?? []))
    }
    return false
  }

  function createRelation(parentId: string, childId: string, relationType: ConceptRelation['relationType'], status: ConceptRelation['status'] = 'confirmed'): void {
    if (relationType === 'hierarchy' && wouldCreateCycle(parentId, childId)) throw new Error('这个父子关系会形成环，无法建立')
    mutate(() => {
      const now = isoNow()
      db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [createId('relation'), parentId, childId, relationType, status === 'confirmed' ? 'manual' : 'llm', status, now, now])
    })
  }

  function confirmRelation(relationId: string, status: 'confirmed' | 'rejected'): void {
    mutate(() => db.run('UPDATE concept_relations SET status = ?, updated_at = ? WHERE id = ?', [status, isoNow(), relationId]))
  }

  function mergeConcept(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return
    mutate(() => {
      const source = concepts.value.find((concept) => concept.id === sourceId)
      const target = concepts.value.find((concept) => concept.id === targetId)
      if (!source || !target) throw new Error('找不到需要合并的 Concept')
      const now = isoNow()
      db.run('INSERT OR IGNORE INTO concept_aliases(id, concept_id, alias, normalized_alias, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [createId('alias'), targetId, source.name, normalizeText(source.name), 'merge', now])
      db.run('INSERT OR IGNORE INTO unit_concepts(unit_id, concept_id, source, created_at) SELECT unit_id, ?, ?, created_at FROM unit_concepts WHERE concept_id = ?', [targetId, 'merge', sourceId])
      db.run('DELETE FROM unit_concepts WHERE concept_id = ?', [sourceId])
      const sourceRelations = db.query<Row>('SELECT * FROM concept_relations WHERE parent_concept_id = ? OR child_concept_id = ?', [sourceId, sourceId])
      sourceRelations.forEach((relation) => {
        const parentId = text(relation.parent_concept_id) === sourceId ? targetId : text(relation.parent_concept_id)
        const childId = text(relation.child_concept_id) === sourceId ? targetId : text(relation.child_concept_id)
        if (parentId === childId) return
        db.run('INSERT OR IGNORE INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [createId('relation'), parentId, childId, text(relation.relation_type), text(relation.source), text(relation.status), text(relation.created_at), now])
      })
      db.run('DELETE FROM concept_relations WHERE parent_concept_id = ? OR child_concept_id = ?', [sourceId, sourceId])
      const mergedNotes = [target.notes, source.notes ? `来自 ${source.name} 的笔记：${source.notes}` : ''].filter(Boolean).join('\n\n')
      db.run('UPDATE concepts SET notes = ?, updated_at = ? WHERE id = ?', [mergedNotes, now, targetId])
      db.run('UPDATE concepts SET status = ?, merged_into_id = ?, deleted_at = ?, updated_at = ? WHERE id = ?', ['merged', targetId, now, now, sourceId])
    })
  }

  function deleteConcept(conceptId: string): void {
    mutate(() => {
      const now = isoNow()
      db.run('UPDATE concepts SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?', ['archived', now, now, conceptId])
    })
  }

  function restoreConcept(conceptId: string): void {
    mutate(() => db.run('UPDATE concepts SET status = ?, deleted_at = NULL, merged_into_id = NULL, updated_at = ? WHERE id = ?', ['active', isoNow(), conceptId]))
  }

  function markTask(taskId: string, status: LLMTask['status'], response?: string, errors?: string[]): void {
    mutate(() => {
      const task = tasks.value.find((item) => item.id === taskId)
      if (!task) return
      const nextPrompt = status === 'needs_review' && response ? buildRepairPrompt(response, errors ?? []) : task.prompt
      db.run('UPDATE llm_tasks SET status = ?, response = COALESCE(?, response), validation_errors = ?, prompt = ?, retry_count = retry_count + ?, updated_at = ? WHERE id = ?', [status, response ?? null, errors ? JSON.stringify(errors) : null, nextPrompt, status === 'failed' || status === 'needs_review' ? 1 : 0, isoNow(), taskId])
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
    const unit = units.value.find((item) => item.id === targetId)
    const session = sessions.value.find((item) => item.id === targetId)

    if (task.type === 'title' || task.type === 'summary') {
      if (!unit) errors.push('任务所属 KnowledgeUnit 不存在')
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
        db.run(`UPDATE knowledge_units SET ${field} = ?, status = 'ready', updated_at = ? WHERE id = ?`, [String(value).trim(), now, targetId])
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
        candidates.forEach((candidate) => {
          const conceptId = ensureConcept(candidate.name, 'llm')
          conceptIds.push(conceptId)
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
        db.run('UPDATE llm_tasks SET status = ?, response = ?, parsed_result = ?, validation_errors = NULL, updated_at = ? WHERE id = ?', ['success', responseText, JSON.stringify(data), now, taskId])
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
    if (session?.localOnly) return { ok: false, error: '仅本地 Session 禁止 API 任务，请切换 Prompt 粘贴模式' }
    mutate(() => db.run("UPDATE llm_tasks SET status = 'running', updated_at = ? WHERE id = ?", [isoNow(), taskId]))
    try {
      const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({ model: task.model || provider.model, temperature: 0, messages: [{ role: 'user', content: task.prompt }] }),
      })
      if (!response.ok) throw new Error(`Provider 返回 HTTP ${response.status}`)
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      const content = payload.choices?.[0]?.message?.content
      if (!content) throw new Error('Provider 没有返回可用内容')
      const result = applyTaskResult(taskId, content)
      return result.ok ? { ok: true } : { ok: false, error: result.errors[0] }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'API 请求失败'
      markTask(taskId, 'failed', undefined, [message])
      return { ok: false, error: message }
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
    const sessionId = task.inputRevision.split(':')[0]
    const session = sessions.value.find((item) => item.id === sessionId)
    if (!session) return { ok: false, errors: ['任务所属 Session 不存在'] }
    const sessionMessages = messages.value.filter((message) => message.sessionId === sessionId).sort((a, b) => a.orderInSession - b.orderInSession)
    const validation = validateSegmentationResult(parsed, sessionMessages.length)
    if (!validation.data) {
      const errors = validation.issues.map((issue) => `${issue.path}: ${issue.message}`)
      markTask(taskId, 'needs_review', responseText, errors)
      return { ok: false, errors }
    }
    if (task.inputRevision !== `${session.id}:${session.revision}`) {
      const errors = ['任务输入版本已过期，请重新生成 Prompt']
      markTask(taskId, 'stale', responseText, errors)
      return { ok: false, errors }
    }
    const segmentation = validation.data
    mutate(() => {
      db.run("UPDATE llm_tasks SET status = 'stale', updated_at = ? WHERE input_revision LIKE ? AND status IN ('pending', 'running', 'needs_review')", [isoNow(), `${sessionId}:%`])
      const oldUnits = db.query<Row>('SELECT id FROM knowledge_units WHERE session_id = ?', [sessionId]).map((row) => text(row.id))
      oldUnits.forEach((unitId) => db.run('DELETE FROM knowledge_units WHERE id = ?', [unitId]))
      db.run('UPDATE messages SET unit_id = NULL WHERE session_id = ?', [sessionId])
      const root = db.query<Row>('SELECT id FROM nav_tree_nodes WHERE session_id = ? AND parent_id IS NULL LIMIT 1', [sessionId])[0]
      const rootId = root ? text(root.id) : createId('nav')
      if (!root) db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, NULL, NULL, ?, 0, ?)', [rootId, sessionId, session.title, isoNow()])
      segmentation.units.forEach((unitResult, index) => {
        const unitId = createId('unit')
        const unitMessages = unitResult.message_indices.map((messageIndex) => sessionMessages[messageIndex]).filter(Boolean)
        const now = isoNow()
        db.run('INSERT INTO knowledge_units(id, session_id, title, summary, order_in_session, status, revision, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)', [unitId, sessionId, unitResult.title_hint || null, index, unitResult.title_hint ? 'ready' : 'pending', now, now])
        unitMessages.forEach((message) => db.run('UPDATE messages SET unit_id = ? WHERE id = ?', [unitId, message.id]))
        const nodeId = createId('nav')
        db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, ?, NULL, ?, 1, ?)', [nodeId, sessionId, rootId, unitResult.title_hint || '待命名知识单元', now])
        db.run('INSERT INTO nav_tree_node_units(node_id, unit_id, order_in_node) VALUES (?, ?, 0)', [nodeId, unitId])
        const createdUnit = unitFromRow(db.query<Row>('SELECT * FROM knowledge_units WHERE id = ?', [unitId])[0])
        const titleTaskId = createTask({ type: 'title', mode: task.mode, providerId: task.providerId, model: task.model, promptVersion: PROMPT_VERSION, inputRevision: `${unitId}:1`, prompt: buildTitlePrompt(session, createdUnit, unitMessages, []), status: 'pending', scopeLabel: `${session.title} · 标题` })
        const summaryTaskId = createTask({ type: 'summary', mode: task.mode, providerId: task.providerId, model: task.model, promptVersion: PROMPT_VERSION, inputRevision: `${unitId}:1`, prompt: buildSummaryPrompt(session, createdUnit, unitMessages, []), status: 'pending', scopeLabel: `${session.title} · 摘要` })
        const conceptTaskId = createTask({ type: 'concept_extraction', mode: task.mode, providerId: task.providerId, model: task.model, promptVersion: PROMPT_VERSION, inputRevision: `${unitId}:1`, prompt: buildConceptPrompt(session, createdUnit, unitMessages, []), status: 'pending', scopeLabel: `${session.title} · Concept` })
        void titleTaskId
        void summaryTaskId
        void conceptTaskId
      })
      db.run('UPDATE sessions SET message_count = ?, unit_count = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [sessionMessages.length, segmentation.units.length, isoNow(), sessionId])
      const refreshedSession = sessionFromRow(db.query<Row>('SELECT * FROM sessions WHERE id = ?', [sessionId])[0])
      db.run("UPDATE llm_tasks SET status = 'pending', input_revision = ?, validation_errors = NULL, updated_at = ? WHERE type = 'origin_concepts' AND scope_label LIKE ? AND status = 'stale'", [`${sessionId}:${refreshedSession.revision}`, isoNow(), `${session.title} · 起源 Concept%`])
      const parsedResult = JSON.stringify(segmentation)
      db.run('UPDATE llm_tasks SET status = ?, response = ?, parsed_result = ?, validation_errors = NULL, updated_at = ? WHERE id = ?', ['success', responseText, parsedResult, isoNow(), taskId])
    })
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

  function reorderContext(ids: string[]): void {
    selectedContextIds.value = ids.filter((id) => units.value.some((unit) => unit.id === id))
  }

  function clearContext(): void {
    selectedContextIds.value = []
  }

  function setSelectedSession(sessionId: string | null): void {
    selectedSessionId.value = sessionId
  }

  function search(query: string): { concepts: Concept[]; units: KnowledgeUnit[]; messages: Message[] } {
    const normalized = normalizeText(query)
    if (!normalized) return { concepts: [], units: [], messages: [] }
    const conceptMatches = activeConcepts.value.filter((concept) => normalizeText(concept.name).includes(normalized) || aliases.value.some((alias) => alias.conceptId === concept.id && normalizeText(alias.alias).includes(normalized)))
    const unitMatches = units.value.filter((unit) => activeSessionIds.value.has(unit.sessionId) && normalizeText(`${unit.title ?? ''} ${unit.summary ?? ''}`).includes(normalized))
    const messageMatches = messages.value.filter((message) => activeSessionIds.value.has(message.sessionId) && normalizeText(message.content).includes(normalized))
    return { concepts: conceptMatches, units: unitMatches, messages: messageMatches }
  }

  function loadDemoData(): void {
    if (activeSessions.value.length > 0) return
    mutate(() => {
      const now = isoNow()
      const sessionRecords = [
        { id: 'demo_session_rdma', title: 'RDMA 论文与拥塞控制讨论', platform: 'local', model: 'demo', createdAt: '2026-08-18T10:00:00.000Z' },
        { id: 'demo_session_network', title: '数据中心网络排障', platform: 'local', model: 'demo', createdAt: '2026-08-20T14:30:00.000Z' },
        { id: 'demo_session_compare', title: 'ECN 与 PFC 对比', platform: 'local', model: 'demo', createdAt: '2026-08-22T09:15:00.000Z' },
      ]
      sessionRecords.forEach((session) => db.run('INSERT INTO sessions(id, source, platform, model, external_session_id, title, created_at, updated_at, message_count, unit_count, revision, local_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)', [session.id, 'local', session.platform, session.model, session.id, session.title, session.createdAt, now, 4, 2]))
      const conceptNames = ['RDMA', '拥塞控制', 'RDMA 的拥塞控制', 'ECN', 'PFC', 'DCQCN']
      const conceptIds = new Map<string, string>()
      conceptNames.forEach((name) => { conceptIds.set(name, createId('concept')); const id = conceptIds.get(name) as string; db.run('INSERT INTO concepts(id, name, normalized_name, notes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, name, normalizeText(name), name === 'RDMA' ? '高性能网络通信主题' : '', 'active', now, now]) })
      const createDemoUnit = (sessionId: string, unitId: string, title: string, summary: string, order: number, content: string[], names: string[]) => {
        db.run('INSERT INTO knowledge_units(id, session_id, title, summary, order_in_session, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', [unitId, sessionId, title, summary, order, 'ready', now, now])
        content.forEach((value, index) => db.run('INSERT INTO messages(id, session_id, unit_id, role, content, order_in_session, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)', [createId('message'), sessionId, unitId, index % 2 === 0 ? 'user' : 'assistant', value, order * 2 + index, now]))
        names.forEach((name) => db.run('INSERT INTO unit_concepts(unit_id, concept_id, source, created_at) VALUES (?, ?, ?, ?)', [unitId, conceptIds.get(name), 'llm', now]))
      }
      createDemoUnit('demo_session_rdma', 'demo_unit_ecn', 'ECN 标记在 RDMA 拥塞控制中的作用', '讨论交换机如何通过 ECN 标记反馈拥塞，并比较 ECN、PFC 与 DCQCN 的作用边界。', 0, ['ECN 在 RDMA 网络里具体做什么？', 'ECN 将拥塞信号反馈给发送端，DCQCN 再据此调整发送速率。'], ['RDMA 的拥塞控制', 'RDMA', '拥塞控制', 'ECN', 'DCQCN'])
      createDemoUnit('demo_session_rdma', 'demo_unit_pfc', 'PFC 的保护作用与副作用', '梳理 PFC 暂停帧的保护效果，以及队头阻塞和拥塞扩散带来的代价。', 1, ['PFC 为什么会和 ECN 一起讨论？', 'PFC 能快速保护无损链路，但也可能造成队头阻塞。'], ['RDMA 的拥塞控制', 'RDMA', '拥塞控制', 'PFC'])
      createDemoUnit('demo_session_network', 'demo_unit_dcqcn', 'DCQCN 参数调优对吞吐量的影响', '分析速率下降参数与恢复速度对不同负载下吞吐量的影响。', 0, ['DCQCN 的参数应该怎么调？', '需要在响应速度和吞吐量稳定性之间做取舍。'], ['RDMA 的拥塞控制', 'DCQCN', '拥塞控制'])
      createDemoUnit('demo_session_compare', 'demo_unit_compare', 'ECN 与 PFC 的协同边界', '比较 ECN 的端到端反馈和 PFC 的链路级暂停机制。', 0, ['ECN 和 PFC 的职责有什么区别？', '两者可以配合，但不能把 PFC 当成拥塞控制的唯一方案。'], ['ECN', 'PFC', '拥塞控制'])
      db.run('UPDATE sessions SET unit_count = 2 WHERE id = ?', ['demo_session_rdma'])
      db.run('UPDATE sessions SET unit_count = 1 WHERE id = ?', ['demo_session_network'])
      db.run('UPDATE sessions SET unit_count = 1 WHERE id = ?', ['demo_session_compare'])
      const relationsToAdd: Array<[string, string, string]> = [
        ['RDMA', 'RDMA 的拥塞控制', 'hierarchy'],
        ['拥塞控制', 'RDMA 的拥塞控制', 'hierarchy'],
        ['ECN', 'PFC', 'related'],
      ]
      relationsToAdd.forEach(([parent, child, relationType]) => db.run('INSERT INTO concept_relations(id, parent_concept_id, child_concept_id, relation_type, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [createId('relation'), conceptIds.get(parent), conceptIds.get(child), relationType, 'manual', 'confirmed', now, now]))
      sessionRecords.forEach((session) => {
        const navId = createId('nav')
        db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, NULL, NULL, ?, 0, ?)', [navId, session.id, session.title, session.createdAt])
        const sessionUnits = db.query<Row>('SELECT id, title FROM knowledge_units WHERE session_id = ? ORDER BY order_in_session', [session.id])
        sessionUnits.forEach((unit, index) => {
          const nodeId = index === 0 ? navId : createId('nav')
          if (index > 0) db.run('INSERT INTO nav_tree_nodes(id, session_id, parent_id, trigger_concept_id, label, depth, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)', [nodeId, session.id, navId, text(unit.title), 1, now])
          db.run('INSERT INTO nav_tree_node_units(node_id, unit_id, order_in_node) VALUES (?, ?, 0)', [nodeId, text(unit.id)])
        })
      })
    })
  }

  function clearAllData(): void {
    mutate(() => {
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
    })
    selectedContextIds.value = []
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
    selectedContextIds,
    selectedSessionId,
    lastImport,
    activeSessions,
    activeConcepts,
    pendingTaskCount,
    selectedUnits,
    stats,
    init,
    refreshFromDb,
    getGraph,
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
    retryTask,
    cancelTask,
    executeTask,
    applySegmentationTask,
    persistConfig,
    updateConfig,
    selectContext,
    reorderContext,
    clearContext,
    setSelectedSession,
    search,
    loadDemoData,
    clearAllData,
    addManualGraphEdge,
    removeManualGraphEdge,
    buildRepairPrompt,
  }
})
