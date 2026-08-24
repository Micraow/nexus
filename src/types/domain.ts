export type SessionSource = 'chrome_import' | 'in_app' | 'local'
export type Platform = 'deepseek' | 'qwen' | 'glm' | 'doubao' | 'local' | string
export type MessageRole = 'user' | 'assistant' | 'system'
export type UnitStatus = 'pending' | 'ready' | 'needs_review'
export type ConceptStatus = 'active' | 'archived' | 'merged'
export type RelationType = 'hierarchy' | 'related'
export type RelationStatus = 'proposed' | 'confirmed' | 'rejected'
export type Provenance = 'llm' | 'manual' | 'maintenance' | 'merge'
export type TaskType =
  | 'segmentation'
  | 'concept_extraction'
  | 'title'
  | 'summary'
  | 'origin_concepts'
  | 'conversation'
  | 'maintenance'
export type TaskMode = 'api' | 'prompt_paste'
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'needs_review'
  | 'stale'
  | 'cancelled'

export interface Session {
  id: string
  source: SessionSource
  platform: Platform
  model?: string | null
  externalSessionId?: string | null
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  unitCount: number
  revision: number
  localOnly: boolean
  deletedAt?: string | null
}

export interface Message {
  id: string
  sessionId: string
  unitId?: string | null
  role: MessageRole
  content: string
  orderInSession: number
  timestamp?: string | null
  metadata?: Record<string, unknown> | null
}

export interface KnowledgeUnit {
  id: string
  sessionId: string
  title?: string | null
  summary?: string | null
  orderInSession: number
  status: UnitStatus
  revision: number
  createdAt: string
  updatedAt: string
}

export interface Concept {
  id: string
  name: string
  normalizedName: string
  notes: string
  status: ConceptStatus
  mergedIntoId?: string | null
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
}

export interface ConceptAlias {
  id: string
  conceptId: string
  alias: string
  normalizedAlias: string
  source: Provenance
  createdAt: string
}

export interface UnitConcept {
  unitId: string
  conceptId: string
  source: Provenance
  createdAt: string
}

export interface ConceptRelation {
  id: string
  parentConceptId: string
  childConceptId: string
  relationType: RelationType
  source: Provenance
  status: RelationStatus
  createdAt: string
  updatedAt: string
}

export interface NavTreeNode {
  id: string
  sessionId: string
  parentId?: string | null
  triggerConceptId?: string | null
  label: string
  depth: number
  createdAt: string
}

export interface NavTreeNodeUnit {
  nodeId: string
  unitId: string
  orderInNode: number
}

export interface ContextReference {
  id: string
  targetSessionId: string
  sourceSessionId: string
  sourceUnitId?: string | null
  sourceMessageId?: string | null
  orderInContext: number
  includeFullContent: boolean
}

export interface QuickPhrase {
  id: string
  template: string
  isBuiltin: boolean
  sortOrder: number
}

export interface LLMTask {
  id: string
  type: TaskType
  mode: TaskMode
  providerId?: string | null
  model?: string | null
  promptVersion: string
  inputRevision: string
  prompt: string
  response?: string | null
  parsedResult?: string | null
  validationErrors?: string | null
  status: TaskStatus
  retryCount: number
  errorMessage?: string | null
  createdAt: string
  updatedAt: string
  scopeLabel?: string
}

export interface ManualGraphEdge {
  id: string
  sourceType: GraphNodeType
  sourceRefId: string
  targetType: GraphNodeType
  targetRefId: string
  label?: string | null
  createdAt: string
}

export type GraphNodeType = 'concept' | 'unit' | 'message'
export type GraphEdgeType = 'co_occurrence' | 'association' | 'hierarchy' | 'related' | 'manual'

export interface GraphNode {
  id: string
  type: GraphNodeType
  refId: string
  label: string
  subtitle?: string
  degree: number
  unitCount: number
  x?: number
  y?: number
  fixed?: boolean
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: GraphEdgeType
  weight: number
  status?: RelationStatus
}

export interface GraphSnapshot {
  nodes: GraphNode[]
  edges: GraphEdge[]
  revision: number
}

export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKey: string
}

export interface AppConfig {
  llm: {
    mode: TaskMode | null
    defaultProvider: string | null
    concurrency: number
    tokenBudget: number
    providers: ProviderConfig[]
    taskOverrides: Record<string, string>
  }
  prompts: { overrideDir: string }
  ui: {
    theme: 'light' | 'dark' | 'system'
    reducedMotion: boolean
    graph: { showUnits: boolean; showMessages: boolean; showProposed: boolean }
  }
  storage: { databasePath: string }
}

export interface ImportConversation {
  external_session_id?: string
  session_id?: string
  title?: string
  model?: string
  created_at?: string
  messages: Array<{
    role: string
    content: string
    timestamp?: string
    metadata?: Record<string, unknown>
  }>
}

export interface ImportPayload {
  schema_version?: number
  platform: string
  exported_at?: string
  conversations: ImportConversation[]
}

export interface ImportIssue {
  sessionId?: string
  message: string
  level: 'warning' | 'error'
}

export interface ImportReport {
  importedSessionIds: string[]
  skippedSessionIds: string[]
  changedSessionIds: string[]
  issues: ImportIssue[]
  taskIds: string[]
}

export interface KnowledgeBaseExport {
  export_version: 1
  exported_at: string
  sessions: Session[]
  messages: Message[]
  units: KnowledgeUnit[]
  concepts: Concept[]
  aliases: ConceptAlias[]
  unit_concepts: UnitConcept[]
  relations: ConceptRelation[]
  nav_nodes: NavTreeNode[]
  nav_node_units: NavTreeNodeUnit[]
  context_references: ContextReference[]
  tasks: LLMTask[]
  manual_edges: ManualGraphEdge[]
}
