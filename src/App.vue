<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Database,
  Download,
  FileJson,
  FolderOpen,
  GitBranch,
  History,
  Layers3,
  LayoutDashboard,
  Link2,
  ListChecks,
  LoaderCircle,
  Maximize2,
  Menu,
  MessageSquare,
  MessageSquarePlus,
  Network,
  PanelRight,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next'
import GraphCanvas from '@/components/GraphCanvas.vue'
import ConceptTree from '@/components/ConceptTree.vue'
import ConversationTree from '@/components/ConversationTree.vue'
import SearchSelect from '@/components/SearchSelect.vue'
import ReadingUnitsView from '@/components/ReadingUnitsView.vue'
import { cleanGraphText, deriveConceptRelatedPairs } from '@/services/graph'
import nexusLogo from '../src-tauri/icons/icon.svg'
import { DEFAULT_CONCEPT_LIMIT, MAX_API_CONCURRENCY, MAX_API_RETRIES, MAX_CONCEPT_LIMIT, MIN_API_CONCURRENCY, MIN_API_RETRIES, MIN_CONCEPT_LIMIT, MIN_TOKEN_BUDGET, normalizeApiConcurrency, normalizeApiRetries, normalizeConceptLimit, normalizeTokenBudget, serializeConfig } from '@/services/config'
import { saveTextFile } from '@/services/files'
import type { SaveFileRequest } from '@/services/files'
import { canCloseConversationBranch, conversationBranchState, conversationTaskForNode, suggestedExplorationQuestion, unfinishedConversationTask } from '@/services/conversation'
import { conversationCardMessages, createPendingConversationTask } from '@/components/conversation-card-messages'
import { resolveConceptEvidence } from '@/services/concept-evidence'
import { messageSessionPages, paginateMessages } from '@/services/message-pagination'
import { renderMarkdown } from '@/services/markdown'
import { copyToClipboard } from '@/services/clipboard'
import { parseMetadata } from '@/utils/metadata'
import { invokeTauri, isTauriRuntime } from '@/services/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import type { AppConfig, Concept, ConceptRelation, GraphNodeType, KnowledgeUnit, LLMTask, MaintenanceSuggestion, Message, NavTreeNode, Session, TaskType } from '@/types/domain'

type ViewName = 'overview' | 'graph' | 'sessions' | 'concepts' | 'units' | 'tasks' | 'settings'

const store = useWorkspaceStore()
const activeView = ref<ViewName>('overview')
const isSidebarCollapsed = ref(false)
const isDetailOpen = ref(true)
const searchQuery = ref('')
const showSearch = ref(false)
const showImportMenu = ref(false)
const importInput = ref<HTMLInputElement | null>(null)
const restoreInput = ref<HTMLInputElement | null>(null)
const importFeedback = ref<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null)
const pendingImportRaw = ref<string | null>(null)
const toast = ref<string | null>(null)
const selectedConceptId = ref<string | null>(null)
const selectedUnitId = ref<string | null>(null)
const selectedMessageId = ref<string | null>(null)
const selectedTaskId = ref<string | null>(null)
const promptTaskId = ref<string | null>(null)
const taskFeedback = ref<{ tone: 'error' | 'info'; text: string } | null>(null)
const graphShowUnits = ref(false)
const graphShowMessages = ref(false)
const graphShowProposed = ref(false)
const graphShowRetainedSessions = ref(false)
const graphSearch = ref('')
const graphControlsOpen = ref(false)
const conceptTreeExpandedIds = ref<string[]>([])
// Concept disclosure is kept in the view. A body activation selects the
// Concept and toggles its branch in one action; the store recursively clears
// descendants when an ancestor closes.
const expandedConceptIds = ref<string[]>([])
const unitDraftTitle = ref('')
const unitDraftSummary = ref('')
const conceptDraftName = ref('')
const conceptDraftSummary = ref('')
const conceptDraftNotes = ref('')
const conceptChildQuery = ref('')
const conceptParentQuery = ref('')
const newUnitConcept = ref('')
const newMessageConcept = ref('')
const relationParentId = ref('')
const relationChildId = ref('')
const relationType = ref<'hierarchy' | 'related'>('hierarchy')
const mergeTargetId = ref('')
const conceptUnitSort = ref<'updated' | 'created' | 'title'>('updated')
const taskDrafts = ref<Record<string, string>>({})
const expandedSessionIds = ref<string[]>([])
const contextIncludeFull = ref(false)
const composerOpen = ref(false)
const maintenancePanelOpen = ref(false)
const composerQuestion = ref('')
const composerTopicIds = ref<string[]>([])
const composerTopicId = computed<string | null>({
  get: () => composerTopicIds.value[0] ?? null,
  set: (value) => { composerTopicIds.value = value ? [value] : [] },
})
const composerPhraseId = ref('')
const composerIncludeFull = ref(false)
const composerSourceUnitIds = ref<string[]>([])
const composerSourceMessageIds = ref<string[]>([])
const composerFollowUp = ref<{ sessionId: string; nodeId: string; label: string } | null>(null)
const activeConversationSessionId = ref<string | null>(null)
// A suggested keyword opens a lightweight branch immediately. It is kept in
// the conversation UI until the answer is materialised as a real nav node.
const pendingConversationBranch = ref<(NavTreeNode & { started: boolean; taskId?: string }) | null>(null)
const customPhraseDraft = ref('')
const editingPhraseId = ref<string | null>(null)
const welcomePhrases = [
  '有什么可以帮你探索？',
  '从一个问题，开始一条新线索。',
  '把好奇心带进来，慢慢理清它。',
  '你想先追踪哪一条知识线？',
  '今天想把什么想明白？',
]
const welcomePhraseStorageKey = 'nexus:last-welcome-phrase-index'
const welcomeText = ref('')
let welcomeTimer: number | null = null
let welcomeRun = 0
let welcomePhraseQueue: number[] = []
let lastWelcomePhraseIndex = (() => {
  try {
    const value = Number(window.localStorage.getItem(welcomePhraseStorageKey))
    return Number.isInteger(value) && value >= 0 && value < welcomePhrases.length ? value : -1
  } catch {
    return -1
  }
})()
const providerDraft = ref({ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' })
const tokenBudgetDraft = ref(String(store.config.llm.tokenBudget))
const conceptLimitDraft = ref(String(store.config.llm.conceptLimit))
const concurrencyDraft = ref(String(store.config.llm.concurrency))
const retriesDraft = ref(String(store.config.llm.retries))
const graphLayoutNonce = ref(0)
const selectedNavNodeId = ref<string | null>(null)
const draggedContextId = ref<string | null>(null)
const helpOpen = ref(false)
type FullscreenTarget = { kind: 'session'; sessionId: string } | { kind: 'message'; messageId: string } | { kind: 'concept'; conceptId: string }
const fullscreenTarget = ref<FullscreenTarget | null>(null)
const fullscreenPage = ref(0)
const fullscreenPageSize = 20
const detailDrawer = ref<HTMLElement | null>(null)
const conceptPageDetail = ref<HTMLElement | null>(null)
const storageInfo = ref<{ dataDir: string; databasePath: string; configPath: string } | null>(null)
const databasePathDraft = ref('')
const visibleSessionCount = ref(40)
const visibleCompletedTaskCount = ref(30)
const taskTypeFilter = ref<TaskType | 'all'>('all')
const taskStatusFilter = ref<'all' | 'active' | 'review' | 'completed'>('all')
const taskSort = ref<'created_desc' | 'created_asc' | 'status'>('created_desc')
let viewportSaveTimer: number | null = null

const fontStacks: Record<string, string> = {
  'system-sans': 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  'chinese-sans': 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  'system-serif': 'ui-serif, Georgia, "Times New Roman", "Noto Serif SC", serif',
  'system-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
}
const fontFamilyPresets: Array<{ value: string; label: string }> = [
  { value: 'system-sans', label: '系统无衬线' },
  { value: 'chinese-sans', label: '中文优先无衬线' },
  { value: 'system-serif', label: '系统衬线' },
  { value: 'system-mono', label: '系统等宽' },
]
const desktopFontRuntime = isTauriRuntime()
const systemFontFamilies = ref<string[]>([])
const systemFontsLoading = ref(false)
const systemFontsUnavailable = ref(false)
const fontFamilyOptions = computed(() => {
  const options = fontFamilyPresets.map((preset) => ({ ...preset }))
  const seen = new Set(options.map((option) => option.value))
  for (const family of systemFontFamilies.value) {
    if (!seen.has(family)) {
      options.push({ value: family, label: family })
      seen.add(family)
    }
  }
  const configured = store.config.ui.fontFamily
  if (configured && !seen.has(configured)) options.push({ value: configured, label: `${configured}（当前配置）` })
  return options
})
const systemFontStatus = computed(() => {
  if (!desktopFontRuntime) return '浏览器模式提供稳定预设'
  if (systemFontsLoading.value) return '正在读取桌面系统字体…'
  if (systemFontsUnavailable.value) return '系统字体读取失败，当前使用稳定预设'
  return systemFontFamilies.value.length ? `已检测到 ${systemFontFamilies.value.length} 个系统字体` : '未检测到额外系统字体'
})

function fontStackForFamily(value: string): string {
  const preset = fontStacks[value]
  if (preset) return preset
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}", ${fontStacks['system-sans']}`
}

const storageSummary = computed(() => {
  if (storageInfo.value?.databasePath) return storageInfo.value.databasePath.replace(/^\/home\/[^/]+/, '~')
  return '本地数据库 · 自动保存'
})

const navItems: Array<{ id: ViewName; label: string; icon: typeof LayoutDashboard; badge?: () => number }> = [
  { id: 'overview', label: '新对话', icon: MessageSquarePlus },
  { id: 'graph', label: '知识图谱', icon: Network },
  { id: 'sessions', label: '会话', icon: History },
  { id: 'concepts', label: '知识主题', icon: Layers3 },
  { id: 'units', label: '阅读片段', icon: BookOpen },
  { id: 'tasks', label: '任务中心', icon: ListChecks, badge: () => store.pendingTaskCount },
  { id: 'settings', label: '设置', icon: Settings2 },
]

const viewTitle = computed(() => navItems.find((item) => item.id === activeView.value)?.label ?? '概览')
const currentGraph = computed(() => {
  const snapshot = store.viewGraph({
    showUnits: graphShowUnits.value,
    showMessages: graphShowMessages.value,
    showProposed: graphShowProposed.value,
    showRetainedSessions: graphShowRetainedSessions.value,
    expandedConceptIds: expandedConceptIds.value,
  })
  if (!graphSearch.value.trim()) return snapshot
  const needle = graphSearch.value.trim().toLocaleUpperCase()
  const matchingIds = new Set(snapshot.nodes.filter((node) => node.label.toLocaleUpperCase().includes(needle)).map((node) => node.id))
  const connected = new Set(matchingIds)
  snapshot.edges.forEach((edge) => {
    if (matchingIds.has(edge.source) || matchingIds.has(edge.target)) {
      connected.add(edge.source)
      connected.add(edge.target)
    }
  })
  return { ...snapshot, nodes: snapshot.nodes.filter((node) => connected.has(node.id)), edges: snapshot.edges.filter((edge) => connected.has(edge.source) && connected.has(edge.target)) }
})
const graphOverview = computed(() => store.graphStats(currentGraph.value))
const selectedConcept = computed(() => store.concepts.find((concept) => concept.id === selectedConceptId.value) ?? null)
const graphDetailInset = computed(() => activeView.value === 'graph' && isDetailOpen.value && selectedConcept.value
  ? Math.min(365, window.innerWidth * 0.92)
  : 0)
const selectedUnit = computed(() => store.units.find((unit) => unit.id === selectedUnitId.value) ?? null)
const selectedMessage = computed(() => store.messages.find((message) => message.id === selectedMessageId.value) ?? null)
const selectedTask = computed(() => store.tasks.find((task) => task.id === selectedTaskId.value) ?? null)
const promptTask = computed(() => promptTaskId.value ? store.tasks.find((task) => task.id === promptTaskId.value) ?? null : null)
const activeConversationSession = computed(() => activeConversationSessionId.value ? store.sessions.find((session) => session.id === activeConversationSessionId.value) ?? null : null)
const activeConversationMessages = computed(() => activeConversationSessionId.value
  ? store.messages.filter((message) => message.sessionId === activeConversationSessionId.value).sort((left, right) => left.orderInSession - right.orderInSession)
  : [])
const activeConversationNodes = computed(() => activeConversationSessionId.value
  ? [
      ...store.navNodes.filter((node) => node.sessionId === activeConversationSessionId.value).map((node) => ({
        ...node,
        label: node.label === '对话回答' && node.triggerConceptId
          ? (store.concepts.find((concept) => concept.id === node.triggerConceptId)?.name ?? node.label)
          : node.label,
      })),
      ...(pendingConversationBranch.value && pendingConversationBranch.value.sessionId === activeConversationSessionId.value
        ? [pendingConversationBranch.value]
        : []),
    ]
  : [])
const activeConversationRoot = computed(() => activeConversationNodes.value.find((node) => !node.parentId) ?? null)
/**
 * A Session can contain several exploration branches. The conversation
 * surface shows the selected branch path as stacked cards instead of replaying
 * every message in creation order. This keeps switching topics non-linear
 * while preserving the original rows for search and export.
 */
const activeConversationPathNodeIds = computed(() => {
  const selected = activeConversationNodes.value.find((node) => node.id === selectedNavNodeId.value)
    ?? activeConversationNodes.value.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  if (!selected) return [] as string[]
  const byId = new Map(activeConversationNodes.value.map((node) => [node.id, node]))
  const path: string[] = []
  const seen = new Set<string>()
  let current: NavTreeNode | undefined = selected
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current.id)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path
})
const activeConversationDisplayedNodeId = computed(() => activeConversationPathNodeIds.value.at(-1) ?? null)
const activeConversationSelectedNode = computed(() => {
  return activeConversationNodes.value.find((node) => node.id === selectedNavNodeId.value)
    ?? activeConversationNodes.value.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    ?? null
})
const activeConversationCurrentCard = computed(() => {
  return activeConversationBranchCards.value.at(-1) ?? null
})
const activeConversationBranchCards = computed(() => {
  const byId = new Map(activeConversationNodes.value.map((node) => [node.id, node]))
  const messages = activeConversationMessages.value
  const cards = activeConversationPathNodeIds.value
    .map((nodeId) => byId.get(nodeId))
    .filter((node): node is NavTreeNode => Boolean(node))
    .map((node) => {
      const branchMessages = conversationCardMessages(node.id, messages, pendingConversationBranch.value)
      const unitIds = store.navNodeUnits
        .filter((link) => link.nodeId === node.id)
        .sort((left, right) => left.orderInNode - right.orderInNode)
        .map((link) => link.unitId)
      const units = unitIds
        .map((unitId) => store.units.find((unit) => unit.id === unitId))
        .filter((unit): unit is KnowledgeUnit => Boolean(unit))
      // Imported sessions predate navigation metadata. Their synthetic root
      // still needs to render the complete transcript so a restored session
      // feels continuous and can be continued from that card.
      if (!branchMessages.length && !node.parentId && messages.length) return { node, messages, units }
      return { node, messages: branchMessages, units }
    })
  // A legacy answer may live on a child branch while the root card has no
  // messages after its triggering question is moved to that answer. Do not
  // leave an empty ancestor card in the visible stack; the current card stays
  // mounted so its composer remains available for a new question.
  return cards.filter((card, index) => index === cards.length - 1 || card.messages.length > 0 || card.units.length > 0)
})
const conversationNavTrail = computed(() => {
  const selected = activeConversationNodes.value.find((node) => node.id === selectedNavNodeId.value) ?? activeConversationRoot.value
  if (!selected) return [] as NavTreeNode[]
  const byId = new Map(activeConversationNodes.value.map((node) => [node.id, node]))
  const trail: NavTreeNode[] = []
  let current: NavTreeNode | undefined = selected
  while (current) {
    trail.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return trail
})
const activeConversationUnfinishedTask = computed(() => activeConversationSessionId.value
  ? unfinishedConversationTask(store.tasks, activeConversationSessionId.value)
  : null)
const pendingConversationBranchState = computed(() => conversationBranchState(
  pendingConversationBranch.value,
  store.tasks,
  activeConversationMessages.value,
))
const pendingConversationBranchCanClose = computed(() => canCloseConversationBranch(
  pendingConversationBranch.value,
  store.tasks,
  activeConversationMessages.value,
) && !pendingConversationBranch.value?.started
  && !pendingConversationBranch.value?.taskId
  && !activeConversationUnfinishedTask.value
  && !activeConversationMessages.value.some((message) => {
    const metadata = parseMetadata(message.metadata)
    return metadata.navNodeId === pendingConversationBranch.value?.id
      || metadata.taskId === pendingConversationBranch.value?.taskId
  }))
const activeConversationTask = computed(() => activeConversationSessionId.value
  ? conversationTaskForNode(store.tasks, store.messages, activeConversationSessionId.value,
      pendingConversationBranch.value?.id === selectedNavNodeId.value
        ? pendingConversationBranch.value.parentId
        : selectedNavNodeId.value)
  : null)
const activeConversationStreamingPreview = computed(() => {
  const task = activeConversationTask.value ?? activeConversationUnfinishedTask.value
  if (task?.type !== 'conversation') return ''
  const streamed = store.streamingTaskPreview(task.id)
  if (streamed || !['needs_review', 'failed'].includes(task.status) || !task.response) return streamed
  try {
    const parsed = JSON.parse(task.response) as { answer?: unknown }
    return typeof parsed.answer === 'string' ? parsed.answer.trim() : ''
  } catch {
    const match = task.response.match(/"answer"\s*:\s*"((?:\\.|[^"\\])*)/)?.[1]
    if (!match) return ''
    try {
      return JSON.parse(`"${match}"`) as string
    } catch {
      return match.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }
})
const activeConversationStatus = computed(() => {
  const task = activeConversationTask.value
  if (!task) return activeConversationUnfinishedTask.value ? '其他分支等待处理' : '本地会话'
  return ({ pending: '等待处理', running: '正在思考…', success: '回答已整理', failed: '请求失败', needs_review: '结果需要检查', stale: '结果已过期', cancelled: '任务已取消' } as Record<LLMTask['status'], string>)[task.status]
})

const fullscreenSession = computed(() => {
  const target = fullscreenTarget.value
  return target?.kind === 'session' ? store.sessions.find((session) => session.id === target.sessionId) ?? null : null
})
const fullscreenMessages = computed<Message[]>(() => {
  const target = fullscreenTarget.value
  if (!target) return []
  if (target.kind === 'message') {
    const message = store.messages.find((item) => item.id === target.messageId)
    return message ? [message] : []
  }
  if (target.kind === 'concept') {
    return conceptEvidenceFor(target.conceptId).messages
  }
  return store.messages.filter((message) => message.sessionId === target.sessionId).sort((left, right) => left.orderInSession - right.orderInSession)
})
const fullscreenMessagePages = computed(() => messageSessionPages(fullscreenMessages.value))
const fullscreenPageCount = computed(() => Math.max(1, fullscreenMessagePages.value.length))
const fullscreenPageMessages = computed(() => paginateMessages(fullscreenMessages.value, fullscreenPage.value, fullscreenPageSize))
const fullscreenPageSession = computed(() => {
  const page = fullscreenMessagePages.value[fullscreenPage.value]
  return page ? store.sessions.find((session) => session.id === page.sessionId) ?? null : null
})
const fullscreenPageSessionTitle = computed(() => cleanGraphText(fullscreenPageSession.value?.title) || '未知会话')
const fullscreenTitle = computed(() => {
  const target = fullscreenTarget.value
  if (target?.kind === 'message') return `消息 #${(fullscreenMessages.value[0]?.orderInSession ?? 0) + 1}`
  if (target?.kind === 'concept') return cleanGraphText(store.concepts.find((concept) => concept.id === target.conceptId)?.name) || '主题消息'
  return cleanGraphText(fullscreenSession.value?.title) || '会话详情'
})
const searchResults = computed(() => store.search(searchQuery.value))
const maintenanceSuggestions = computed(() => {
  if (!selectedTask.value || selectedTask.value.type !== 'maintenance' || !selectedTask.value.parsedResult) return [] as Array<MaintenanceSuggestion & { applied?: boolean }>
  try {
    const parsed = JSON.parse(selectedTask.value.parsedResult) as { suggestions?: unknown }
    return Array.isArray(parsed.suggestions) ? parsed.suggestions as Array<MaintenanceSuggestion & { applied?: boolean }> : []
  } catch {
    return [] as Array<MaintenanceSuggestion & { applied?: boolean }>
  }
})
const maintenanceOverallReason = computed(() => {
  if (!selectedTask.value || selectedTask.value.type !== 'maintenance') return ''
  // A disclosure round intentionally clears parsedResult while retaining the
  // provider's raw response for audit. Keep its overall reason visible without
  // treating the intermediate response as a completed maintenance result.
  const source = selectedTask.value.parsedResult ?? selectedTask.value.response
  if (!source) return ''
  try {
    const parsed = JSON.parse(source) as { reason?: unknown }
    return typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
  } catch {
    return ''
  }
})
// Maintenance is a graph-wide command. Keep one stable entry in the top bar
// across every module; the panel itself is closed whenever navigation changes.
// Its copy explicitly says "全图" so it cannot be mistaken for a page-scoped
// operation even when opened from a Concept or Session detail.
const maintenancePageHasContext = computed(() => true)
const conceptTreeConcepts = computed(() => {
  const concepts = store.activeConcepts
  const needle = graphSearch.value.trim().toLocaleUpperCase()
  if (!needle) return concepts
  const matched = new Set(concepts.filter((concept) => concept.name.toLocaleUpperCase().includes(needle)).map((concept) => concept.id))
  if (!matched.size) return []
  const byChild = new Map<string, string[]>()
  store.relations.forEach((relation) => {
    if (relation.relationType !== 'hierarchy' || relation.status !== 'confirmed') return
    const parents = byChild.get(relation.childConceptId) ?? []
    parents.push(relation.parentConceptId)
    byChild.set(relation.childConceptId, parents)
  })
  const keep = new Set(matched)
  const pending = [...matched]
  while (pending.length) {
    const childId = pending.pop() as string
    for (const parentId of byChild.get(childId) ?? []) {
      if (!keep.has(parentId) && concepts.some((concept) => concept.id === parentId)) {
        keep.add(parentId)
        pending.push(parentId)
      }
    }
  }
  return concepts.filter((concept) => keep.has(concept.id))
})
const conceptTreeExpandedIdsForView = computed(() => {
  const expanded = new Set(conceptTreeExpandedIds.value)
  if (!graphSearch.value.trim()) return [...expanded]
  const included = new Set(conceptTreeConcepts.value.map((concept) => concept.id))
  const parentsByChild = new Map<string, string[]>()
  store.relations.forEach((relation) => {
    if (relation.relationType !== 'hierarchy' || relation.status !== 'confirmed') return
    const parents = parentsByChild.get(relation.childConceptId) ?? []
    parents.push(relation.parentConceptId)
    parentsByChild.set(relation.childConceptId, parents)
  })
  included.forEach((id) => {
    const queue = [id]
    const visited = new Set<string>()
    while (queue.length) {
      const childId = queue.pop() as string
      if (visited.has(childId)) continue
      visited.add(childId)
      for (const parentId of parentsByChild.get(childId) ?? []) {
        if (!included.has(parentId)) continue
        expanded.add(parentId)
        queue.push(parentId)
      }
    }
  })
  return [...expanded]
})
// Legacy LLM-authored related rows are not actionable relations. Related
// signals are derived from shared evidence; only hierarchy proposals and
// explicit maintenance edits belong in the review surface.
const isReviewableConceptRelation = (relation: ConceptRelation): boolean => relation.relationType === 'hierarchy' || relation.source === 'maintenance'
const selectedConceptRelations = computed(() => selectedConcept.value
  ? store.relations.filter((relation) => (relation.parentConceptId === selectedConcept.value?.id || relation.childConceptId === selectedConcept.value?.id) && isReviewableConceptRelation(relation))
  : [])
const selectedSession = computed(() => store.sessions.find((session) => session.id === store.selectedSessionId) ?? null)
const conceptEvidenceFor = (conceptId: string) => resolveConceptEvidence({
  conceptId,
  sessions: store.sessions,
  messages: store.messages,
  units: store.units,
  sessionConcepts: store.sessionConcepts,
  messageConcepts: store.messageConcepts,
  unitConcepts: store.unitConcepts,
})
const linkedUnitCount = (conceptId: string): number => {
  const sessionIds = new Set(store.sessionConcepts.filter((link) => link.conceptId === conceptId).map((link) => link.sessionId))
  return store.units.filter((unit) => sessionIds.has(unit.sessionId) || store.unitConcepts.some((link) => link.unitId === unit.id && link.conceptId === conceptId)).length
}
const sessionIdsForConcept = (conceptId: string): Set<string> => {
  const ids = new Set(store.sessionConcepts.filter((link) => link.conceptId === conceptId).map((link) => link.sessionId))
  store.unitConcepts.filter((link) => link.conceptId === conceptId).forEach((link) => {
    const unit = store.units.find((item) => item.id === link.unitId)
    if (unit) ids.add(unit.sessionId)
  })
  store.messageConcepts.filter((link) => link.conceptId === conceptId).forEach((link) => {
    const message = store.messages.find((item) => item.id === link.messageId)
    if (message) ids.add(message.sessionId)
  })
  store.messages.forEach((message) => {
    const declared = parseMetadata(message.metadata).concept_ids
    if (Array.isArray(declared) && declared.some((id) => id === conceptId)) ids.add(message.sessionId)
  })
  return ids
}
// A direct SessionConcept covers the entire conversation. Message- and
// Unit-level memberships remain local to their own evidence below.
const conceptSessionIds = (conceptId: string): Set<string> => new Set(store.sessionConcepts.filter((link) => link.conceptId === conceptId).map((link) => link.sessionId))
const conceptMessageIds = (conceptId: string): Set<string> => {
  const ids = new Set(store.messageConcepts.filter((link) => link.conceptId === conceptId).map((link) => link.messageId))
  store.messages.forEach((message) => {
    const declared = parseMetadata(message.metadata).concept_ids
    if (Array.isArray(declared) && declared.some((id) => id === conceptId)) ids.add(message.id)
  })
  return ids
}
const conceptUnitCollator = new Intl.Collator('zh-Hans-CN')
const selectedConceptUnits = computed(() => {
  const units = selectedConcept.value ? [...conceptEvidenceFor(selectedConcept.value.id).units] : []
  return units.sort((left, right) => {
    if (conceptUnitSort.value === 'title') return conceptUnitCollator.compare(left.title ?? '', right.title ?? '')
    if (conceptUnitSort.value === 'created') return right.createdAt.localeCompare(left.createdAt)
    return right.updatedAt.localeCompare(left.updatedAt)
  })
})
const selectedConceptMessages = computed(() => {
  return selectedConcept.value ? conceptEvidenceFor(selectedConcept.value.id).messages : []
})
const selectedConceptSessions = computed(() => selectedConcept.value ? conceptEvidenceFor(selectedConcept.value.id).sessions : [])
const otherConceptOf = (relation: { parentConceptId: string; childConceptId: string }, conceptId: string): string => (relation.childConceptId === conceptId ? relation.parentConceptId : relation.childConceptId)
const selectedConceptParents = computed(() => selectedConcept.value ? store.relations.filter((relation) => relation.childConceptId === selectedConcept.value?.id && relation.relationType === 'hierarchy' && relation.status !== 'rejected').sort((left, right) => linkedUnitCount(otherConceptOf(right, selectedConcept.value!.id)) - linkedUnitCount(otherConceptOf(left, selectedConcept.value!.id))) : [])
const selectedConceptChildren = computed(() => selectedConcept.value ? store.relations.filter((relation) => relation.parentConceptId === selectedConcept.value?.id && relation.relationType === 'hierarchy' && relation.status !== 'rejected').sort((left, right) => linkedUnitCount(otherConceptOf(right, selectedConcept.value!.id)) - linkedUnitCount(otherConceptOf(left, selectedConcept.value!.id))) : [])
type RelatedConceptView = ConceptRelation & { derived?: boolean; sessionCount?: number; messageCount?: number }
const selectedConceptRelated = computed<RelatedConceptView[]>(() => {
  const selectedId = selectedConcept.value?.id
  if (!selectedId) return []
  const persisted = store.relations.filter((relation) =>
    (relation.parentConceptId === selectedId || relation.childConceptId === selectedId)
    && relation.relationType === 'related'
    && relation.status !== 'rejected'
    && relation.source !== 'llm',
  ) as RelatedConceptView[]
  const persistedPairs = new Set(persisted.map((relation) => [relation.parentConceptId, relation.childConceptId].sort().join('|')))
  const derived = deriveConceptRelatedPairs({
    concepts: store.concepts,
    units: store.units,
    messages: store.messages,
    unitConcepts: store.unitConcepts,
    sessionConcepts: store.sessionConcepts,
    messageConcepts: store.messageConcepts,
    sessions: store.activeSessions,
  }).filter((pair) => pair.leftConceptId === selectedId || pair.rightConceptId === selectedId)
    .filter((pair) => !persistedPairs.has(`${pair.leftConceptId}|${pair.rightConceptId}`))
    .map((pair) => ({
      id: `derived-related:${pair.leftConceptId}|${pair.rightConceptId}`,
      parentConceptId: pair.leftConceptId,
      childConceptId: pair.rightConceptId,
      relationType: 'related' as const,
      source: 'manual' as const,
      status: 'confirmed' as const,
      createdAt: '',
      updatedAt: '',
      derived: true,
      sessionCount: pair.sessionCount,
      messageCount: pair.messageCount,
    }))
  return [...persisted, ...derived].sort((left, right) => linkedUnitCount(otherConceptOf(right, selectedId)) - linkedUnitCount(otherConceptOf(left, selectedId)))
})
const selectedConceptHasProposedRelations = computed(() => selectedConceptRelations.value.some((relation) => relation.status === 'proposed'))
const proposedConceptRelations = computed(() => store.relations
  .filter((relation) => relation.status === 'proposed')
  .filter(isReviewableConceptRelation)
  .filter((relation) => store.activeConcepts.some((concept) => concept.id === relation.parentConceptId))
  .filter((relation) => store.activeConcepts.some((concept) => concept.id === relation.childConceptId))
  .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
const conceptSearchCandidates = (query: string, excludedIds: Set<string>): Concept[] => {
  const needle = query.trim().toLocaleUpperCase()
  if (!needle) return []
  return store.activeConcepts
    .filter((concept) => !excludedIds.has(concept.id) && concept.name.toLocaleUpperCase().includes(needle))
    .slice(0, 8)
}
const conceptSummary = (conceptId: string): string => {
  const concept = store.concepts.find((item) => item.id === conceptId)
  return concept?.summary?.trim() || concept?.notes?.trim().replace(/\s+/g, ' ').slice(0, 120) || '暂无摘要'
}
const conceptChildCandidates = computed(() => {
  const selectedId = selectedConcept.value?.id
  if (!selectedId) return []
  const excluded = new Set([selectedId, ...selectedConceptChildren.value.map((relation) => otherConceptOf(relation, selectedId))])
  return conceptSearchCandidates(conceptChildQuery.value, excluded)
})
const conceptParentCandidates = computed(() => {
  const selectedId = selectedConcept.value?.id
  if (!selectedId) return []
  const excluded = new Set([selectedId, ...selectedConceptParents.value.map((relation) => otherConceptOf(relation, selectedId))])
  return conceptSearchCandidates(conceptParentQuery.value, excluded)
})
const taskTypeOptions: Array<{ value: TaskType; label: string }> = [
  { value: 'session_triage', label: '会话分类' },
  { value: 'segmentation', label: '旧版对话分组' },
  { value: 'concept_extraction', label: '知识主题提取' },
  { value: 'unit_metadata', label: '标题与摘要生成' },
  { value: 'title', label: '标题生成（旧任务）' },
  { value: 'summary', label: '摘要生成（旧任务）' },
  { value: 'origin_concepts', label: '起始知识主题' },
  { value: 'conversation', label: '对话' },
  { value: 'maintenance', label: '维护建议' },
]
const visibleTasks = computed(() => {
  const filtered = store.tasks.filter((task) => {
    if (taskTypeFilter.value !== 'all' && task.type !== taskTypeFilter.value) return false
    if (taskStatusFilter.value === 'active' && !['pending', 'running'].includes(task.status)) return false
    if (taskStatusFilter.value === 'review' && task.status !== 'needs_review') return false
    if (taskStatusFilter.value === 'completed' && !['success', 'failed', 'stale', 'cancelled'].includes(task.status)) return false
    return true
  })
  return [...filtered].sort((left, right) => {
    if (taskSort.value === 'status') {
      const rank: Record<string, number> = { running: 0, pending: 1, needs_review: 2, failed: 3, stale: 4, cancelled: 5, success: 6 }
      return (rank[left.status] ?? 9) - (rank[right.status] ?? 9) || right.createdAt.localeCompare(left.createdAt)
    }
    const order = right.createdAt.localeCompare(left.createdAt)
    return taskSort.value === 'created_desc' ? order : -order
  })
})
const taskGroups = computed(() => ({
  active: visibleTasks.value.filter((task) => ['pending', 'running'].includes(task.status)),
  review: visibleTasks.value.filter((task) => task.status === 'needs_review'),
  completed: visibleTasks.value.filter((task) => ['success', 'failed', 'stale', 'cancelled'].includes(task.status)),
}))
const queueEstimate = computed(() => {
  const pending = store.tasks.filter((task) => task.mode === 'api' && task.status === 'pending')
  const sessionIds = new Set<string>()
  pending.forEach((task) => {
    const scope = task.inputRevision.split(':')[0]
    if (scope !== 'maintenance') sessionIds.add(scope)
  })
  return { count: pending.length, sessions: sessionIds.size }
})
const contextTokenEstimate = computed(() => {  const unitCharacters = store.selectedUnits.reduce((total, unit) => {
    const session = sessionForUnit(unit)
    const base = `${unit.title ?? ''}${unit.summary ?? ''}${store.unitConceptNames(unit.id).join('')}${session?.title ?? ''}`
    const full = contextIncludeFull.value ? store.unitMessages(unit.id).reduce((sum, message) => sum + message.content.length, 0) : 0
    return total + base.length + full
  }, 0)
  const messageCharacters = store.selectedContextMessages.reduce((total, message) => total + message.content.length, 0)
  return Math.ceil((unitCharacters + messageCharacters) / 4)
})
const composerTokenEstimate = computed(() => {
  const unitCharacters = composerSourceUnitIds.value.reduce((total, unitId) => {
    const unit = store.units.find((item) => item.id === unitId)
    if (!unit) return total
    const session = sessionForUnit(unit)
    const base = `${unit.title ?? ''}${unit.summary ?? ''}${store.unitConceptNames(unit.id).join('')}${session?.title ?? ''}`
    const full = composerIncludeFull.value ? store.unitMessages(unit.id).reduce((sum, message) => sum + message.content.length, 0) : 0
    return total + base.length + full
  }, 0)
  const messageCharacters = composerSourceMessageIds.value.reduce((total, messageId) => total + (store.messages.find((message) => message.id === messageId)?.content.length ?? 0), 0)
  return Math.ceil((unitCharacters + messageCharacters) / 4)
})

function notify(message: string): void {
  toast.value = message
  window.setTimeout(() => { if (toast.value === message) toast.value = null }, 3200)
}

function setView(view: ViewName): void {
  const viewChanged = view !== activeView.value
  if (view === 'overview' && activeView.value === 'overview') startWelcomeTypewriter()
  activeView.value = view
  if (viewChanged) {
    // Detail and maintenance panels belong to the module that opened them.
    // Clear both when navigating so a stale floating card cannot cover the
    // next module or look like an unrelated API/task state.
    isDetailOpen.value = false
    maintenancePanelOpen.value = false
  }
  // Each visit to the graph starts at its root projection. Disclosure is a
  // transient view state, so leaving the module must not make a later entry
  // look as if every descendant was initialized visible.
  if (view === 'graph' && viewChanged) expandedConceptIds.value = []
  if (view === 'graph') nextTick(() => window.dispatchEvent(new Event('resize')))
}

function saveGraphLayout(entry: { nodeType: GraphNodeType; refId: string; x: number; y: number; fixed: boolean }): void {
  store.saveGraphLayout(entry)
}

function saveGraphViewport(viewport: { x: number; y: number; scale: number }): void {
  if (viewportSaveTimer != null) window.clearTimeout(viewportSaveTimer)
  viewportSaveTimer = window.setTimeout(() => {
    store.saveGraphViewport(viewport)
    viewportSaveTimer = null
  }, 350)
}

function toggleGraphConcept(conceptId: string, expanded: boolean): void {
  // Older maintenance worktrees do not yet expose the store's recursive
  // disclosure helper. Use it when available; the local fallback keeps this
  // branch type-safe and mirrors the same collapse-descendants behavior.
  const toggle = (store as unknown as { toggleConceptExpansion?: (ids: string[], id: string, value?: boolean, showProposed?: boolean) => string[] }).toggleConceptExpansion
  if (toggle) {
    expandedConceptIds.value = toggle(expandedConceptIds.value, conceptId, expanded, graphShowProposed.value)
    return
  }
  const next = new Set(expandedConceptIds.value)
  if (expanded) next.add(conceptId)
  else {
    next.delete(conceptId)
    const queue = [conceptId]
    while (queue.length) {
      const parentId = queue.shift() as string
      store.relations
        .filter((relation) => relation.relationType === 'hierarchy'
          && relation.parentConceptId === parentId
          && (relation.status === 'confirmed' || (graphShowProposed.value && relation.status === 'proposed')))
        .forEach((relation) => { if (next.delete(relation.childConceptId)) queue.push(relation.childConceptId) })
    }
  }
  expandedConceptIds.value = [...next]
}

function toggleConceptTree(conceptId: string): void {
  if (!conceptTreeExpandedIds.value.includes(conceptId)) {
    conceptTreeExpandedIds.value = [...conceptTreeExpandedIds.value, conceptId]
    return
  }
  const descendants = new Set<string>([conceptId])
  const queue = [conceptId]
  while (queue.length) {
    const parentId = queue.shift() as string
    store.relations.forEach((relation) => {
      if (relation.relationType !== 'hierarchy' || relation.status !== 'confirmed' || relation.parentConceptId !== parentId) return
      if (descendants.has(relation.childConceptId)) return
      descendants.add(relation.childConceptId)
      queue.push(relation.childConceptId)
    })
  }
  conceptTreeExpandedIds.value = conceptTreeExpandedIds.value.filter((id) => !descendants.has(id))
}

function resetGraphLayout(): void {
  store.resetGraphLayout()
  graphLayoutNonce.value += 1
  notify('图谱布局已重置')
}

function openConcept(conceptId: string): void {
  if (activeView.value !== 'graph' && activeView.value !== 'concepts') setView('graph')
  selectedConceptId.value = conceptId
  selectedUnitId.value = null
  selectedMessageId.value = null
  const concept = store.concepts.find((item) => item.id === conceptId)
  conceptDraftName.value = concept?.name ?? ''
  conceptDraftSummary.value = concept?.summary ?? ''
  conceptDraftNotes.value = concept?.notes ?? ''
  conceptChildQuery.value = ''
  conceptParentQuery.value = ''
  mergeTargetId.value = ''
  // The topic catalog owns its detail column. Keep the global drawer for
  // graph, session and message contexts so a topic is not rendered twice.
  isDetailOpen.value = activeView.value !== 'concepts'
  void nextTick(() => {
    const detail = activeView.value === 'concepts' ? conceptPageDetail.value : detailDrawer.value
    if (!detail) return
    const behavior = store.config.ui.reducedMotion ? 'auto' : 'smooth'
    detail.scrollTo({ top: 0, behavior })
    if (activeView.value === 'concepts' && detail.scrollHeight <= detail.clientHeight) detail.scrollIntoView({ block: 'start', behavior })
  })
}

function openConceptFromRelation(relation: ConceptRelation): void {
  setView('concepts')
  openConcept(relation.childConceptId)
}

function openConceptCatalog(conceptId: string): void {
  if (!store.activeConcepts.some((concept) => concept.id === conceptId)) return
  setView('concepts')
  openConcept(conceptId)
}

function openUnit(unitId: string, additive = false): void {
  selectedConceptId.value = null
  selectedUnitId.value = unitId
  selectedMessageId.value = null
  if (!additive) store.reorderContext([unitId])
  else store.selectContext(unitId, !store.selectedContextIds.includes(unitId))
  isDetailOpen.value = activeView.value !== 'units'
  void nextTick(() => detailDrawer.value?.scrollTo({ top: 0, behavior: store.config.ui.reducedMotion ? 'auto' : 'smooth' }))
}

function openUnitPage(unitId: string): void {
  selectedConceptId.value = null
  selectedMessageId.value = null
  selectedUnitId.value = unitId
  isDetailOpen.value = false
}

function addBoxSelectedUnit(unitId: string): void {
  store.selectContext(unitId, true)
}

function openMessage(messageId: string): void {
  // 消息详情是独立入口；不要让上一次打开的主题/单元抢占抽屉内容。
  selectedConceptId.value = null
  selectedUnitId.value = null
  selectedMessageId.value = messageId
  isDetailOpen.value = true
  void nextTick(() => detailDrawer.value?.scrollTo({ top: 0, behavior: store.config.ui.reducedMotion ? 'auto' : 'smooth' }))
}

function toggleMessageContext(messageId: string): void {
  store.selectMessageContext(messageId, !store.selectedContextMessageIds.includes(messageId))
}

function openFullscreenSession(sessionId: string): void {
  fullscreenPage.value = 0
  fullscreenTarget.value = { kind: 'session', sessionId }
}

function openFullscreenMessage(messageId: string): void {
  fullscreenPage.value = 0
  fullscreenTarget.value = { kind: 'message', messageId }
}

function openFullscreenConcept(conceptId: string): void {
  fullscreenPage.value = 0
  fullscreenTarget.value = { kind: 'concept', conceptId }
}

function changeFullscreenPage(delta: number): void {
  fullscreenPage.value = Math.min(fullscreenPageCount.value - 1, Math.max(0, fullscreenPage.value + delta))
}

function closeFullscreen(): void {
  fullscreenTarget.value = null
}

function selectSession(sessionId: string): void {
  store.setSelectedSession(sessionId)
  setView('sessions')
  selectedUnitId.value = null
  selectedConceptId.value = null
  selectedMessageId.value = null
}

function editUnit(unit: KnowledgeUnit): void {
  unitDraftTitle.value = unit.title ?? ''
  unitDraftSummary.value = unit.summary ?? ''
  selectedUnitId.value = unit.id
  isDetailOpen.value = true
}

function saveUnit(): void {
  if (!selectedUnit.value) return
  try {
    store.updateUnit(selectedUnit.value.id, { title: unitDraftTitle.value, summary: unitDraftSummary.value })
    notify('阅读片段已保存')
  } catch (error) {
    notify(error instanceof Error ? error.message : '阅读片段保存失败')
  }
}

function saveConcept(): void {
  if (!selectedConcept.value) return
  try {
    store.updateConcept(selectedConcept.value.id, { name: conceptDraftName.value, summary: conceptDraftSummary.value, notes: conceptDraftNotes.value })
    notify('知识主题已保存')
  } catch (error) {
    notify(error instanceof Error ? error.message : '知识主题保存失败')
  }
}

function resetConceptDraft(): void {
  conceptDraftName.value = selectedConcept.value?.name ?? ''
  conceptDraftSummary.value = selectedConcept.value?.summary ?? ''
  conceptDraftNotes.value = selectedConcept.value?.notes ?? ''
}

function addConceptChild(childId: string): void {
  if (!selectedConcept.value) return
  try {
    store.createRelation(selectedConcept.value.id, childId, 'hierarchy')
    conceptChildQuery.value = ''
    notify('子知识主题已添加')
  } catch (error) {
    notify(error instanceof Error ? error.message : '添加子知识主题失败')
  }
}

function createAndAddConceptChild(): void {
  if (!selectedConcept.value || !conceptChildQuery.value.trim()) return
  try {
    const childId = store.createConcept(conceptChildQuery.value)
    if (childId !== selectedConcept.value.id) store.createRelation(selectedConcept.value.id, childId, 'hierarchy')
    conceptChildQuery.value = ''
    notify('子知识主题已创建并添加')
  } catch (error) {
    notify(error instanceof Error ? error.message : '创建子知识主题失败')
  }
}

function addConceptParent(parentId: string): void {
  if (!selectedConcept.value) return
  try {
    store.createRelation(parentId, selectedConcept.value.id, 'hierarchy')
    conceptParentQuery.value = ''
    notify('父知识主题已添加')
  } catch (error) {
    notify(error instanceof Error ? error.message : '添加父知识主题失败')
  }
}

function promoteSelectedChild(relationId: string): void {
  if (!selectedConcept.value) return
  if (!window.confirm('将这个子主题提升到当前主题的上一级？原关系会被替换，操作可以撤销。')) return
  try {
    store.promoteConceptChild(relationId)
    notify('子知识主题已提升')
  } catch (error) {
    notify(error instanceof Error ? error.message : '提升子知识主题失败')
  }
}

function addConceptToSelectedUnit(): void {
  if (!selectedUnit.value || !newUnitConcept.value) return
  try {
    const concept = store.activeConcepts.find((item) => item.id === newUnitConcept.value)
    if (!concept) throw new Error('请选择本地现有知识主题')
    store.setUnitConcept(selectedUnit.value.id, concept.id, true)
    newUnitConcept.value = ''
    notify('知识主题关联已添加')
  } catch (error) {
    notify(error instanceof Error ? error.message : '知识主题关联失败')
  }
}

function removeConceptFromUnit(unitId: string, conceptId: string): void {
  store.setUnitConcept(unitId, conceptId, false)
  notify('知识主题关联已移除')
}

function addConceptToSelectedMessage(): void {
  if (!selectedMessage.value || !newMessageConcept.value) return
  try {
    const concept = store.activeConcepts.find((item) => item.id === newMessageConcept.value)
    if (!concept) throw new Error('请选择本地现有知识主题')
    store.setMessageConcept(selectedMessage.value.id, concept.id, true)
    newMessageConcept.value = ''
    notify('消息归属已添加')
  } catch (error) {
    notify(error instanceof Error ? error.message : '消息归属添加失败')
  }
}

function removeConceptFromMessage(messageId: string, conceptId: string): void {
  store.setMessageConcept(messageId, conceptId, false)
  notify('消息归属已移除')
}

function createRelationFromForm(): void {
  if (!relationParentId.value || !relationChildId.value) return
  try {
    store.createRelation(relationParentId.value, relationChildId.value, relationType.value)
    relationParentId.value = ''
    relationChildId.value = ''
    notify('知识主题关系已建立')
  } catch (error) {
    notify(error instanceof Error ? error.message : '关系创建失败')
  }
}

function mergeSelectedConcept(): void {
  if (!selectedConcept.value || !mergeTargetId.value) return
  if (mergeTargetId.value === selectedConcept.value.id) return notify('请选择另一个目标知识主题')
  if (!window.confirm(`将“${selectedConcept.value.name}”合并到目标知识主题？此操作可以撤销。`)) return
  try {
    store.mergeConcept(selectedConcept.value.id, mergeTargetId.value)
    selectedConceptId.value = mergeTargetId.value
    mergeTargetId.value = ''
    notify('知识主题已合并')
  } catch (error) {
    notify(error instanceof Error ? error.message : '合并失败')
  }
}

function createMaintenanceTask(input: { conceptIds?: string[]; unitIds?: string[]; includeFullContent?: boolean }, label: string): void {
  try {
    const taskId = store.createMaintenanceTask(input)
    setView('tasks')
    selectedTaskId.value = taskId
    maintenancePanelOpen.value = true
    notify(`${label}已创建，等待生成维护建议`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '维护任务创建失败')
  }
}

function openMaintenancePanel(): void {
  maintenancePanelOpen.value = true
  isDetailOpen.value = false
}

function createGraphMaintenance(): void {
  createMaintenanceTask({}, '全图知识维护任务')
}

function createConceptMaintenance(): void {
  if (!selectedConcept.value) return
  createMaintenanceTask({ conceptIds: [selectedConcept.value.id] }, `“${selectedConcept.value.name}”维护任务`)
}

function createSessionMaintenance(): void {
  if (!selectedSession.value) return
  const unitIds = store.units.filter((unit) => unit.sessionId === selectedSession.value?.id).map((unit) => unit.id)
  createMaintenanceTask({ unitIds }, `“${selectedSession.value.title}”维护任务`)
}

function createContextMaintenance(): void {
  createMaintenanceTask({ unitIds: store.selectedContextIds, includeFullContent: contextIncludeFull.value }, '选中上下文维护任务')
}

function applyMaintenanceSuggestion(index: number): void {
  if (!selectedTask.value) return
  const result = store.applyMaintenanceSuggestion(selectedTask.value.id, index)
  if (!result.ok) return notify(result.error ?? '维护建议应用失败')
  notify('维护建议已应用；关系建议仍需确认')
}

function maintenanceSuggestionLabel(type: MaintenanceSuggestion['type']): string {
  return ({ merge: '合并知识主题', alias: '添加别名', remove_alias: '删除别名', relation: '建立关系', add_relation: '添加关系', update_relation: '修改关系', delete_relation: '删除关系', remove_relation: '删除关系', set_relation_status: '审核关系', confirm_relation: '确认关系', reject_relation: '拒绝关系', membership_relink: '调整主题归属', create_concept: '创建知识主题', update_concept: '编辑知识主题', move_concept: '移动知识主题', set_hierarchy_parents: '重设全部父主题', remove_hierarchy: '解除父子关系', archive_concept: '归档知识主题', delete_concept: '删除知识主题', restore_concept: '恢复知识主题', unit_relink: '重新关联片段', unit_create: '创建阅读片段', unit_revision: '修订片段' } as Record<string, string>)[type] ?? '维护建议'
}

function conceptName(conceptId?: string | null): string {
  if (!conceptId) return '未指定'
  const name = store.concepts.find((concept) => concept.id === conceptId)?.name
  return cleanGraphText(name) || '未知知识主题'
}

function displayText(value: unknown, fallback = ''): string {
  return cleanGraphText(value) || fallback
}

function relationStatusLabel(status: 'proposed' | 'confirmed' | 'rejected'): string {
  return status === 'confirmed' ? '已确认' : status === 'proposed' ? '待确认' : '已拒绝'
}

function relationSourceLabel(source: ConceptRelation['source']): string {
  return ({
    llm: 'AI 整理',
    maintenance: '维护任务',
    manual: '手动创建',
    merge: '主题合并',
    import: '历史导入',
  } as Record<ConceptRelation['source'], string>)[source] ?? source
}

function maintenanceSuggestionSummary(suggestion: MaintenanceSuggestion): string {
  if (suggestion.type === 'merge') return `${conceptName(suggestion.source_concept_id)} → ${conceptName(suggestion.target_concept_id)}`
  if (suggestion.type === 'alias') return `${conceptName(suggestion.concept_id)} · “${suggestion.alias ?? ''}”`
  if (suggestion.type === 'remove_alias') return `别名 ${suggestion.alias_id || '未知'} · 删除`
  if (suggestion.type === 'relation' || suggestion.type === 'add_relation') {
    const sourceId = suggestion.source_concept_id ?? suggestion.parent_concept_id
    const targetId = suggestion.target_concept_id ?? suggestion.child_concept_id
    return `${conceptName(sourceId)} ${suggestion.relation_type === 'hierarchy' ? '→' : '↔'} ${conceptName(targetId)}`
  }
  if (suggestion.type === 'update_relation') return `${suggestion.relation_id || '关系'} · ${suggestion.relation_type || '更新端点'}`
  if (suggestion.type === 'delete_relation') return `${suggestion.relation_id || '关系'} · 删除`
  if (suggestion.type === 'remove_relation') return `${suggestion.relation_id || '关系'} · 删除`
  if (suggestion.type === 'set_relation_status') return `${suggestion.relation_id || '关系'} · ${relationStatusLabel(suggestion.status ?? 'proposed')}`
  if (suggestion.type === 'confirm_relation') return `${suggestion.relation_id || '关系'} · 确认`
  if (suggestion.type === 'reject_relation') return `${suggestion.relation_id || '关系'} · 拒绝`
  if (suggestion.type === 'create_concept') return `${suggestion.name || '新知识主题'}${suggestion.parent_concept_id ? ` → ${conceptName(suggestion.parent_concept_id)}` : ' · 根主题'}`
  if (suggestion.type === 'update_concept') return `${conceptName(suggestion.concept_id)} · ${suggestion.name || suggestion.summary || '更新主题信息'}`
  if (suggestion.type === 'move_concept') return `${conceptName(suggestion.concept_id)} → ${suggestion.parent_concept_id ? conceptName(suggestion.parent_concept_id) : '根主题'}`
  if (suggestion.type === 'set_hierarchy_parents') return `${conceptName(suggestion.concept_id)} · ${suggestion.parent_concept_ids?.length ?? 0} 个父主题`
  if (suggestion.type === 'remove_hierarchy') return `${conceptName(suggestion.parent_concept_id)} → ${conceptName(suggestion.child_concept_id)}`
  if (suggestion.type === 'archive_concept' || suggestion.type === 'delete_concept' || suggestion.type === 'restore_concept') return conceptName(suggestion.concept_id)
  if (suggestion.type === 'membership_relink') return `${suggestion.target_type || '目标'} ${suggestion.target_id || '未知'} · ${suggestion.replace ? '替换' : '追加'} ${suggestion.concept_ids?.length ?? 0} 个主题`
  if (suggestion.type === 'unit_relink') return `${store.units.find((unit) => unit.id === suggestion.unit_id)?.title || '未命名阅读片段'} · ${suggestion.replace === false ? '追加' : '替换'} ${suggestion.concept_ids?.length ?? 0} 个主题`
  if (suggestion.type === 'unit_create') return `${suggestion.title || '新阅读片段'} · ${suggestion.message_ids?.length ?? 0} 条消息`
  return `${store.units.find((unit) => unit.id === suggestion.unit_id)?.title || '未命名阅读片段'} · ${suggestion.title || suggestion.summary || '修订标题或摘要'}`
}

function confirmConceptRelation(relationId: string, status: 'confirmed' | 'rejected'): void {
  try {
    store.confirmRelation(relationId, status)
    notify(status === 'confirmed' ? '关系已确认' : '关系已拒绝')
  } catch (error) {
    notify(error instanceof Error ? error.message : '关系状态更新失败')
  }
}

function confirmAllProposedRelations(): void {
  const pending = [...proposedConceptRelations.value]
  if (!pending.length) return
  try {
    pending.forEach((relation) => store.confirmRelation(relation.id, 'confirmed'))
    notify(`已确认 ${pending.length} 条关系`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '批量确认关系失败')
  }
}

function deleteConceptRelation(relationId: string): void {
  if (!window.confirm('删除这条知识主题关系？')) return
  try {
    store.deleteRelation(relationId)
    notify('关系已删除')
  } catch (error) {
    notify(error instanceof Error ? error.message : '关系删除失败')
  }
}

function undoLatestOperation(): void {
  try {
    store.undoOperation()
    notify('最近一次维护操作已撤销')
  } catch (error) {
    notify(error instanceof Error ? error.message : '没有可撤销的操作')
  }
}

function archiveSelectedConcept(): void {
  if (!selectedConcept.value) return
  if (!window.confirm(`归档“${selectedConcept.value.name}”？历史内容不会删除。`)) return
  try {
    store.deleteConcept(selectedConcept.value.id)
    selectedConceptId.value = null
    isDetailOpen.value = false
    notify('知识主题已归档，可在操作记录中撤销')
  } catch (error) {
    notify(error instanceof Error ? error.message : '知识主题归档失败')
  }
}

function openComposer(input: { topicId?: string | null; sourceUnitIds?: string[]; sourceMessageIds?: string[]; parentNodeId?: string | null; followUp?: { sessionId: string; nodeId: string; label: string } } = {}): void {
  if (!store.config.llm.mode) {
    notify('请先在设置中选择 LLM 模式')
    setView('settings')
    return
  }
  composerFollowUp.value = input.followUp ?? null
  if (input.followUp) {
    const node = store.navNodes.find((item) => item.id === input.followUp?.nodeId)
    composerTopicId.value = input.topicId ?? node?.triggerConceptId ?? null
    composerSourceUnitIds.value = [...(input.sourceUnitIds ?? [])]
    composerSourceMessageIds.value = [...(input.sourceMessageIds ?? [])]
  } else {
    composerTopicId.value = input.topicId ?? selectedConceptId.value
    composerSourceUnitIds.value = [...(input.sourceUnitIds ?? store.selectedContextIds)]
    composerSourceMessageIds.value = [...(input.sourceMessageIds ?? store.selectedContextMessageIds)]
  }
  composerIncludeFull.value = input.sourceUnitIds?.length ? composerIncludeFull.value : contextIncludeFull.value
  composerQuestion.value = ''
  composerPhraseId.value = ''
  composerOpen.value = true
}

/** Bring the current context selection to the persistent new-chat surface. */
function openContextComposer(): void {
  activeConversationSessionId.value = null
  selectedNavNodeId.value = null
  composerFollowUp.value = null
  composerTopicId.value = selectedConceptId.value
  composerSourceUnitIds.value = [...store.selectedContextIds]
  composerSourceMessageIds.value = [...store.selectedContextMessageIds]
  composerIncludeFull.value = contextIncludeFull.value
  composerQuestion.value = ''
  composerPhraseId.value = ''
  composerOpen.value = false
  setView('overview')
  void nextTick(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="新对话问题"]')?.focus()
  })
}

function applyComposerPhrase(): void {
  if (!composerPhraseId.value) return
  const rendered = store.renderedPhrase(composerPhraseId.value, composerTopicId.value ?? undefined)
  if (rendered) composerQuestion.value = rendered
}

function submitComposer(): void {
  if (!store.config.llm.mode) {
    notify('请先在设置中选择 API 或 Prompt 粘贴模式')
    setView('settings')
    return
  }
  if (!composerQuestion.value.trim()) return notify('请输入问题，或先选择一个快捷短语')
  if (composerTokenEstimate.value > store.config.llm.tokenBudget) return notify(`上下文约 ${composerTokenEstimate.value.toLocaleString()} tokens，超过当前预算，请移除阅读片段或关闭完整原文`)
  if (composerFollowUp.value) {
    try {
      const created = createPendingConversationTask(
        pendingConversationBranch.value,
        composerFollowUp.value.nodeId,
        () => store.createFollowUpTask({
          sessionId: composerFollowUp.value!.sessionId,
          parentNodeId: composerFollowUp.value!.nodeId,
          question: composerQuestion.value,
          topicId: composerTopicId.value ?? undefined,
          topicIds: composerTopicIds.value,
          sourceUnitIds: composerSourceUnitIds.value,
          sourceMessageIds: composerSourceMessageIds.value,
          includeFullContent: composerIncludeFull.value,
        }),
      )
      const taskId = created.taskId
      pendingConversationBranch.value = created.pending
      composerOpen.value = false
      composerQuestion.value = ''
      composerPhraseId.value = ''
      selectedTaskId.value = taskId
      activeConversationSessionId.value = composerFollowUp.value.sessionId
      selectedNavNodeId.value = pendingConversationBranch.value?.id ?? composerFollowUp.value.nodeId
      setView('overview')
      const task = store.tasks.find((item) => item.id === taskId)
      if (task?.mode === 'api') {
        notify('正在请求 API，回答会回到当前对话')
        void executeApiTask(task)
      } else {
        promptTaskId.value = taskId
        notify('请在右侧浮层中复制 Prompt，并粘贴返回结果')
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '追问创建失败')
    }
    return
  }
  try {
    const targetSessionId = store.createConversationTask({
      question: composerQuestion.value,
      topicId: composerTopicId.value ?? undefined,
      topicIds: composerTopicIds.value,
      sourceUnitIds: composerSourceUnitIds.value,
      sourceMessageIds: composerSourceMessageIds.value,
      includeFullContent: composerIncludeFull.value,
    })
    const task = store.tasks.find((item) => item.inputRevision.startsWith(`${targetSessionId}:`))
    store.setSelectedSession(targetSessionId)
    store.clearContext()
    composerOpen.value = false
    composerQuestion.value = ''
    composerPhraseId.value = ''
    if (task) selectedTaskId.value = task.id
    activeConversationSessionId.value = targetSessionId
    selectedNavNodeId.value = store.navNodes.find((node) => node.sessionId === targetSessionId && !node.parentId)?.id ?? null
    setView('overview')
    if (task?.mode === 'api') {
      notify('正在请求 API，回答会回到当前对话')
      void executeApiTask(task)
    } else if (task) {
      promptTaskId.value = task.id
      notify('请在右侧浮层中复制 Prompt，并粘贴返回结果')
    }
  } catch (error) {
    notify(error instanceof Error ? error.message : '新对话创建失败')
  }
}

function openConversationSession(sessionId: string): void {
  const session = store.sessions.find((item) => item.id === sessionId)
  // Imported sessions are first-class conversation history too. Their
  // generated root node lets users inspect the single-card transcript and
  // continue asking questions from the recovered context.
  if (!session) return
  activeConversationSessionId.value = sessionId
  pendingConversationBranch.value = null
  store.setSelectedSession(sessionId)
  const nodes = store.navNodes.filter((node) => node.sessionId === sessionId).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  selectedNavNodeId.value = (session.source === 'in_app' ? nodes[0] : nodes.find((node) => !node.parentId))?.id ?? nodes[0]?.id ?? null
  selectedConceptId.value = null
  selectedUnitId.value = null
  selectedMessageId.value = null
  setView('overview')
}

function leaveConversationSession(): void {
  if (activeConversationUnfinishedTask.value) {
    notify('请先完成当前回答，再离开会话')
    return
  }
  activeConversationSessionId.value = null
  selectedNavNodeId.value = null
  pendingConversationBranch.value = null
  composerQuestion.value = ''
  setView('overview')
}

function closePendingConversationBranch(): void {
  const branch = pendingConversationBranch.value
  if (!branch) return
  if (!pendingConversationBranchCanClose.value || activeConversationUnfinishedTask.value) {
    notify('这条探索已经开始，不能关闭；请等待回答完成')
    return
  }
  pendingConversationBranch.value = null
  selectedNavNodeId.value = branch.parentId ?? null
  composerFollowUp.value = null
  composerQuestion.value = ''
  composerPhraseId.value = ''
}

function startConversationFollowUp(): void {
  const session = activeConversationSession.value
  if (!session) return
  const selected = activeConversationNodes.value.find((item) => item.id === selectedNavNodeId.value)
  const node = (pendingConversationBranch.value?.id === selected?.id
    ? activeConversationNodes.value.find((item) => item.id === selected?.parentId)
    : selected)
    ?? activeConversationNodes.value.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  if (!node) return notify('当前会话还没有可继续的探索节点')
  composerFollowUp.value = { sessionId: session.id, nodeId: node.id, label: node.label }
  composerTopicId.value = node.triggerConceptId ?? null
  composerSourceUnitIds.value = [...store.selectedContextIds]
  composerSourceMessageIds.value = [...store.selectedContextMessageIds]
  composerIncludeFull.value = contextIncludeFull.value
  submitComposer()
}

function goConversationBack(): void {
  const current = activeConversationNodes.value.find((node) => node.id === selectedNavNodeId.value)
  if (current?.parentId) {
    selectedNavNodeId.value = current.parentId
    return
  }
  leaveConversationSession()
}

function openPromptTask(task: LLMTask): void {
  promptTaskId.value = task.id
  const targetSessionId = task.inputRevision.split(':')[0]
  if (task.type === 'conversation' && store.sessions.some((session) => session.id === targetSessionId)) {
    activeConversationSessionId.value = targetSessionId
    store.setSelectedSession(targetSessionId)
    const taskMessage = store.messages.find((message) => parseMetadata(message.metadata).taskId === task.id)
    const metadata = parseMetadata(taskMessage?.metadata)
    selectedNavNodeId.value = typeof metadata.parentNodeId === 'string'
      ? metadata.parentNodeId
      : store.navNodes.find((node) => node.sessionId === targetSessionId && !node.parentId)?.id ?? null
  }
}

function closePromptTask(): void {
  promptTaskId.value = null
}

function applyPromptTask(): void {
  const task = promptTask.value
  if (!task) return
  const beforeStatus = task.status
  applyTask(task)
  const updated = store.tasks.find((item) => item.id === task.id)
  if (updated?.status === 'success' && beforeStatus !== 'success') {
    promptTaskId.value = null
    if (task.type === 'conversation') {
      activeConversationSessionId.value = task.inputRevision.split(':')[0]
      store.setSelectedSession(activeConversationSessionId.value)
    }
  }
}

function openTaskConversation(task: LLMTask): void {
  if (task.type !== 'conversation') return
  const sessionId = task.inputRevision.split(':')[0]
  openConversationSession(sessionId)
}

function selectConversationNode(node: NavTreeNode): void {
  const pending = pendingConversationBranch.value
  // A running/needs-review answer belongs to the temporary branch that was
  // created for its recommendation. Switching the navigator during that
  // window would render the same task's stream on a different card (usually
  // the root). Keep the branch selected until its result is applied.
  if (pending && pending.id !== node.id && pendingConversationBranchState.value !== 'draft') {
    selectedNavNodeId.value = pending.id
    notify('请先完成当前分支回答，再切换探索节点')
    return
  }
  if (selectedNavNodeId.value !== node.id) {
    composerQuestion.value = ''
    composerPhraseId.value = ''
    composerFollowUp.value = null
  }
  selectedNavNodeId.value = node.id
  const nodeUnitIds = new Set(store.navNodeUnits.filter((link) => link.nodeId === node.id).map((link) => link.unitId))
  const targetMessage = activeConversationMessages.value.find((message) => {
    const metadata = parseMetadata(message.metadata)
    return metadata.navNodeId === node.id || (message.unitId != null && nodeUnitIds.has(message.unitId))
  })
  if (!targetMessage) return
  void nextTick(() => {
    document.querySelector<HTMLElement>(`[data-conversation-message="${targetMessage.id}"]`)?.scrollIntoView({ behavior: store.config.ui.reducedMotion ? 'auto' : 'smooth', block: 'start' })
  })
}

function startContextDrag(unitId: string): void {
  draggedContextId.value = unitId
}

function dropContext(unitId: string): void {
  const sourceId = draggedContextId.value
  draggedContextId.value = null
  if (!sourceId || sourceId === unitId) return
  const ids = [...store.selectedContextIds]
  const from = ids.indexOf(sourceId)
  const to = ids.indexOf(unitId)
  if (from < 0 || to < 0) return
  ids.splice(from, 1)
  ids.splice(to, 0, sourceId)
  store.reorderContext(ids)
}

function addCustomPhrase(): void {
  if (!customPhraseDraft.value.trim()) return notify('请输入快捷短语内容')
  try {
    store.addQuickPhrase(customPhraseDraft.value)
    customPhraseDraft.value = ''
    notify('快捷短语已添加')
  } catch (error) {
    notify(error instanceof Error ? error.message : '快捷短语添加失败')
  }
}

function beginEditPhrase(id: string, template: string): void {
  editingPhraseId.value = id
  customPhraseDraft.value = template
}

function savePhraseEdit(): void {
  if (!editingPhraseId.value) return
  try {
    store.updateQuickPhrase(editingPhraseId.value, customPhraseDraft.value)
    editingPhraseId.value = null
    customPhraseDraft.value = ''
    notify('快捷短语已更新')
  } catch (error) {
    notify(error instanceof Error ? error.message : '快捷短语更新失败')
  }
}

function removePhrase(id: string): void {
  if (!window.confirm('删除这个自定义快捷短语？')) return
  store.removeQuickPhrase(id)
  notify('快捷短语已删除')
}

async function copyText(value: string, message = '已复制到剪贴板'): Promise<void> {
  const copied = await copyToClipboard(value)
  notify(copied ? message : '复制失败，请手动选择文本')
}

function markdownConceptsForTask(taskId?: string): Array<{ id: string; name: string; aliases: string[]; kind?: 'existing' | 'suggested' }> {
  const task = taskId ? store.tasks.find((item) => item.id === taskId) : null
  const createdNames = new Set<string>()
  if (task?.parsedResult) {
    try {
      const parsed = JSON.parse(task.parsedResult) as { concepts?: unknown; units?: unknown }
      const collect = (value: unknown): void => {
        if (!Array.isArray(value)) return
        value.forEach((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return
          const name = (item as Record<string, unknown>).name
          if (typeof name === 'string' && name.trim()) createdNames.add(name.trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleUpperCase())
        })
      }
      collect(parsed.concepts)
      if (Array.isArray(parsed.units)) parsed.units.forEach((unit) => {
        if (unit && typeof unit === 'object' && !Array.isArray(unit)) collect((unit as Record<string, unknown>).concepts)
      })
    } catch {
      // Invalid/in-flight task responses do not contribute response-local names.
    }
  }
  return store.activeConcepts.map((concept) => ({
    id: concept.id,
    name: concept.name,
    aliases: store.aliases.filter((alias) => alias.conceptId === concept.id).map((alias) => alias.alias),
    kind: createdNames.has(concept.name.trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleUpperCase()) ? 'suggested' : 'existing',
  }))
}

/**
 * Restrict explicit/implicit answer markers to concepts that are actually
 * evidenced by this message.  Matching every active topic in the database
 * made ordinary words in a conversation look like blue links to unrelated
 * topics.  Concepts introduced by the current task remain available as
 * yellow exploration markers even before their durable membership is written.
 */
function markdownConceptsForMessage(message: Message, taskId?: string): Array<{ id: string; name: string; aliases: string[]; kind?: 'existing' | 'suggested' }> {
  const concepts = markdownConceptsForTask(taskId)
  const allowed = new Set<string>()
  store.messageConcepts
    .filter((link) => link.messageId === message.id)
    .forEach((link) => allowed.add(link.conceptId))
  store.sessionConcepts
    .filter((link) => link.sessionId === message.sessionId)
    .forEach((link) => allowed.add(link.conceptId))
  if (message.unitId) {
    store.unitConcepts
      .filter((link) => link.unitId === message.unitId)
      .forEach((link) => allowed.add(link.conceptId))
  }
  return concepts.filter((concept) => allowed.has(concept.id) || concept.kind === 'suggested')
}

function markdownConceptsForStreamingTask(task?: LLMTask | null): Array<{ id: string; name: string; aliases: string[]; kind?: 'existing' | 'suggested' }> {
  if (!task) return []
  const source = task.response ?? store.streamingTaskPreview(task.id)
  if (!source) return markdownConceptsForTask(task.id).filter((concept) => concept.kind === 'suggested')
  const normalized = source.normalize('NFKC').toLocaleUpperCase()
  return markdownConceptsForTask(task.id).filter((concept) => {
    if (concept.kind === 'suggested') return true
    return [concept.name, ...concept.aliases].some((label) => normalized.includes(label.normalize('NFKC').toLocaleUpperCase()))
  })
}

function renderedMessageContent(content: string, message?: Message, autoLinkConcepts = true): string {
  const inConversation = Boolean(activeConversationSession.value && message?.sessionId === activeConversationSession.value.id)
  const metadata = parseMetadata(message?.metadata)
  const taskId = typeof metadata.taskId === 'string' ? metadata.taskId : undefined
  let concepts = message
    ? markdownConceptsForMessage(message, taskId)
    : markdownConceptsForTask(taskId)
  if (!message && !inConversation) concepts = []
  return renderMarkdown(content, { concepts, autoLinkConcepts: inConversation ? 'suggested' : autoLinkConcepts })
}

function handleRenderedClick(event: Event, message?: Message, taskId?: string): void {
  const target = (event.target as HTMLElement).closest('[data-concept-id]')
  const conceptId = target?.getAttribute('data-concept-id')
  if (conceptId) {
    // Conversation markers are topic citations, so open the canonical topic
    // catalog entry rather than dropping the user into an unrelated graph
    // module with only a floating drawer.
    setView('concepts')
    openConcept(conceptId)
    return
  }
  const suggestedTarget = (event.target as HTMLElement).closest('[data-suggested-concept]')
  const suggestedConcept = suggestedTarget?.getAttribute('data-suggested-concept')?.trim()
  if (!suggestedConcept) return
  const session = activeConversationSession.value
  if (!session || (message && message.sessionId !== session.id)) {
    notify('请先打开这条消息所属的软件内会话，再继续探索建议主题')
    return
  }
  if (activeConversationUnfinishedTask.value) {
    notify('请先完成当前待处理的回答')
    return
  }
  const metadata = parseMetadata(message?.metadata)
  const taskMessage = taskId
    ? activeConversationMessages.value.find((candidate) => parseMetadata(candidate.metadata).taskId === taskId && candidate.role === 'user')
    : undefined
  const taskMetadata = parseMetadata(taskMessage?.metadata)
  const parentNodeId = typeof metadata.navNodeId === 'string'
    ? metadata.navNodeId
    : typeof taskMetadata.parentNodeId === 'string'
      ? taskMetadata.parentNodeId
      : selectedNavNodeId.value
  const parentNode = activeConversationNodes.value.find((node) => node.id === parentNodeId)
  if (!parentNode) {
    notify('找不到这条回答对应的探索节点')
    return
  }
  selectedNavNodeId.value = parentNode.id
  const branchId = `pending-nav-${session.id}-${Date.now().toString(36)}`
  pendingConversationBranch.value = {
    id: branchId,
    sessionId: session.id,
    parentId: parentNode.id,
    triggerConceptId: null,
    label: suggestedConcept,
    depth: parentNode.depth + 1,
    createdAt: new Date().toISOString(),
    started: false,
  }
  selectedNavNodeId.value = branchId
  composerFollowUp.value = { sessionId: session.id, nodeId: parentNode.id, label: suggestedConcept }
  composerTopicId.value = parentNode.triggerConceptId ?? null
  composerSourceUnitIds.value = []
  composerSourceMessageIds.value = []
  composerQuestion.value = suggestedExplorationQuestion(suggestedConcept)
  void nextTick(() => {
    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="继续当前对话"]')
    input?.focus()
    input?.scrollIntoView({ behavior: store.config.ui.reducedMotion ? 'auto' : 'smooth', block: 'center' })
  })
}

function buildContextPrompt(): string {
  const unitBlocks = store.selectedUnits.map((unit, index) => {
    const session = store.sessions.find((item) => item.id === unit.sessionId)
    const messages = contextIncludeFull.value ? store.unitMessages(unit.id).map((message) => `${message.role}: ${message.content}`).join('\n') : ''
    return `## ${index + 1}. ${unit.title || '未命名阅读片段'}\n来源：${session?.title ?? '未知会话'}\n知识主题：${store.unitConceptNames(unit.id).join('、') || '暂无'}\n摘要：${unit.summary || '暂无摘要'}${messages ? `\n原文：\n${messages}` : ''}`
  })
  const messageBlocks = store.selectedContextMessages.map((message, index) => `## 消息 ${index + 1}\n角色：${message.role}\n来源会话：${store.sessions.find((session) => session.id === message.sessionId)?.title ?? '未知会话'}\n原文：\n${message.content}`)
  return `以下是我选择的知识上下文，请基于这些内容继续回答：\n\n${[...unitBlocks, ...messageBlocks].join('\n\n')}`
}

function createContextPrompt(): void {
  if (!store.selectedUnits.length && !store.selectedContextMessages.length) return notify('请先选择阅读片段或消息')
  const prompt = buildContextPrompt()
  copyText(prompt, '上下文 Prompt 已复制')
}

function triggerImport(): void {
  importInput.value?.click()
  showImportMenu.value = false
}

async function handleImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const raw = await file.text()
    const report = store.importJsonText(raw)
    if (report.changedSessionIds.length) pendingImportRaw.value = raw
    importFeedback.value = { tone: 'success', text: `已导入 ${report.importedSessionIds.length} 个会话，生成 ${report.taskIds.length} 个待处理任务。` }
    setView('tasks')
  } catch (error) {
    importFeedback.value = { tone: 'error', text: error instanceof Error ? error.message : '导入失败' }
  }
}

function resolveChangedImport(mode: 'replace' | 'new' | 'skip'): void {
  if (!pendingImportRaw.value) return
  try {
    const report = mode === 'skip' ? { changedSessionIds: [], importedSessionIds: [], taskIds: [] } : store.importJsonTextWithMode(pendingImportRaw.value, mode)
    pendingImportRaw.value = null
    importFeedback.value = { tone: 'success', text: mode === 'skip' ? '已保留变化会话，未覆盖本地内容。' : `已处理 ${report.importedSessionIds.length} 个会话，并创建待处理任务。` }
    setView('tasks')
  } catch (error) {
    importFeedback.value = { tone: 'error', text: error instanceof Error ? error.message : '重复导入处理失败' }
  }
}

function handleDrop(event: DragEvent): void {
  event.preventDefault()
  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  void file.text().then((raw) => {
    try {
      const report = store.importJsonText(raw)
      importFeedback.value = { tone: 'success', text: `已导入 ${report.importedSessionIds.length} 个会话，并创建待处理任务。` }
      setView('tasks')
    } catch (error) {
      importFeedback.value = { tone: 'error', text: error instanceof Error ? error.message : '导入失败' }
    }
  })
}

function taskGroupSlice(group: LLMTask[]): LLMTask[] {
  if (group !== taskGroups.value.completed) return group
  return group.slice(0, visibleCompletedTaskCount.value)
}

function taskStatusLabel(status: LLMTask['status'], phase?: LLMTask['phase']): string {
  if (phase === 'awaiting_disclosure') return '等待继续披露'
  if (phase === 'awaiting_review') return '需要检查'
  return ({ pending: '待处理', running: '处理中', success: '已完成', failed: '失败', needs_review: '需要检查', stale: '已过期', cancelled: '已取消' } as Record<string, string>)[status]
}

function taskTone(status: LLMTask['status'], phase?: LLMTask['phase']): string {
  if (phase === 'awaiting_disclosure' || phase === 'awaiting_review') return 'warning'
  if (status === 'success') return 'success'
  if (status === 'failed' || status === 'stale') return 'danger'
  if (status === 'needs_review') return 'warning'
  if (status === 'running') return 'active'
  return 'neutral'
}

function taskTypeLabel(type: LLMTask['type']): string {
  return ({ session_triage: '会话分类', segmentation: '旧版对话分组', concept_extraction: '知识主题提取', unit_metadata: '标题与摘要生成', title: '标题生成（旧任务）', summary: '摘要生成（旧任务）', origin_concepts: '起始知识主题', conversation: '对话', maintenance: '维护建议' } as Record<string, string>)[type]
}

function taskValidationErrors(task: LLMTask): string[] {
  if (!task.validationErrors) return task.errorMessage ? [task.errorMessage] : []
  try {
    const value: unknown = JSON.parse(task.validationErrors)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [task.validationErrors]
  } catch {
    return [task.validationErrors]
  }
}

function isAwaitingMaintenanceDisclosure(task: LLMTask): boolean {
  if (task.type !== 'maintenance' || task.status !== 'pending' || task.parsedResult != null || !task.response) return false
  try {
    const value: unknown = JSON.parse(task.response)
    return Boolean(task.phase === 'awaiting_disclosure' || (value && typeof value === 'object' && !Array.isArray(value)
      && Array.isArray((value as { disclosure_requests?: unknown }).disclosure_requests)
      && ((value as { disclosure_requests: unknown[] }).disclosure_requests.length > 0)))
  } catch {
    return false
  }
}

function taskResponse(task: LLMTask): string {
  const draft = taskDrafts.value[task.id]
  if (draft !== undefined) return draft
  // A disclosure continuation keeps the previous raw response for audit, but
  // clears parsedResult and re-queues the task. That response is no longer a
  // valid submission for the new prompt and must not be projected as a draft.
  if (isAwaitingMaintenanceDisclosure(task)) return ''
  return task.response ?? ''
}

function setTaskDraft(taskId: string, value: string): void {
  taskDrafts.value[taskId] = value
}

function selectTaskAnswerNode(taskId: string): void {
  const answer = store.messages.find((message) => message.role === 'assistant' && parseMetadata(message.metadata).taskId === taskId)
  const navNodeId = parseMetadata(answer?.metadata).navNodeId
  if (typeof navNodeId !== 'string') return
  const node = store.navNodes.find((item) => item.id === navNodeId)
  if (!node) return
  if (pendingConversationBranch.value) pendingConversationBranch.value = null
  activeConversationSessionId.value = node.sessionId
  store.setSelectedSession(node.sessionId)
  selectConversationNode(node)
}

function applyTask(task: LLMTask): void {
  const response = taskResponse(task)
  if (!response.trim()) {
    taskFeedback.value = { tone: 'error', text: '没有检测到回复，请粘贴网页端返回的完整 JSON 后重试。' }
    return
  }
  const result = store.applyTaskResult(task.id, response)
  if (result.continued) {
    // The previous JSON belongs to the completed disclosure round. Never
    // leave it in the editor where a second click could submit it again.
    delete taskDrafts.value[task.id]
    if (task.mode === 'api') {
      taskFeedback.value = { tone: 'info', text: result.errors.join('；') + '，正在自动请求下一轮披露。' }
      const refreshed = store.tasks.find((item) => item.id === task.id)
      if (refreshed) void executeApiTask(refreshed)
    } else {
      taskFeedback.value = { tone: 'info', text: result.errors.join('；') + '。请复制更新后的 Prompt，完成下一轮回复后再粘贴。' }
    }
  } else if (result.ok) {
    taskFeedback.value = null
    notify(task.type === 'segmentation' ? '旧版对话分组结果已校验并写入知识库' : task.type === 'maintenance' ? '维护建议已校验，请逐条确认应用' : '结构化结果已校验并写入知识库')
    if (task.type === 'conversation') selectTaskAnswerNode(task.id)
    if (task.type !== 'maintenance') selectedTaskId.value = null
  } else taskFeedback.value = { tone: 'error', text: result.errors.join('；') || '校验失败，请按提示修正后重试。' }
}

async function executeApiTask(task: LLMTask): Promise<void> {
  taskFeedback.value = null
  const result = await store.executeTask(task.id)
  if (result.ok) {
    store.refreshFromDb()
    if (task.type === 'conversation') selectTaskAnswerNode(task.id)
    notify('API 任务已完成')
  }
  else taskFeedback.value = { tone: 'error', text: result.error ?? 'API 任务失败，请检查连接配置后重试。' }
}

function startTaskQueue(): void {
  store.startQueue()
  notify('API 任务队列已开始')
}

function pauseTaskQueue(): void {
  store.pauseQueue()
  notify('任务队列将在当前请求完成后暂停')
}

function resumeTaskQueue(): void {
  store.resumeQueue()
  notify('API 任务队列已继续')
}

function retryTask(task: LLMTask): void {
  store.retryTask(task.id)
  taskFeedback.value = null
  notify('任务已重新排队')
}

function cancelTask(task: LLMTask): void {
  store.cancelTask(task.id)
  notify('任务已取消，原始 Prompt 保留')
}

function copyTaskPrompt(task: LLMTask): void {
  copyText(task.prompt, '任务 Prompt 已复制')
  selectedTaskId.value = task.id
}

async function saveExport(filename: string, content: string, kind: SaveFileRequest['kind'], message: string): Promise<void> {
  try {
    if (await saveTextFile({ filename, content, kind })) notify(message)
  } catch (error) {
    notify(error instanceof Error ? error.message : '导出失败')
  }
}

function exportConfig(): void {
  void saveExport('nexus-config.yaml', serializeConfig(store.config), 'yaml', '配置 YAML 已导出')
}

function exportSnapshot(): void {
  const payload = { export_version: 1, exported_at: new Date().toISOString(), graph: currentGraph.value, concepts: store.concepts, units: store.units }
  void saveExport('nexus-graph-snapshot.json', JSON.stringify(payload, null, 2), 'json', '图谱快照已导出')
}

function exportKnowledgeBase(): void {
  void saveExport('nexus-knowledge-base.json', store.exportKnowledgeBase(), 'json', '完整知识库 JSON 已导出')
}

function triggerRestore(): void {
  restoreInput.value?.click()
}

async function handleRestore(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!window.confirm('恢复备份会替换当前本地知识库，确定继续吗？')) return
  try {
    store.importKnowledgeBase(await file.text())
    notify('知识库已从备份恢复')
    activeView.value = 'overview'
  } catch (error) {
    notify(error instanceof Error ? error.message : '恢复失败，当前数据未改变')
  }
}

function exportConceptMarkdown(concept: Concept): void {
  const conceptUnits = store.units.filter((unit) => store.unitConcepts.some((link) => link.unitId === unit.id && link.conceptId === concept.id))
  const conceptAliases = store.aliases.filter((alias) => alias.conceptId === concept.id)
  const relations = store.relations.filter((relation) => relation.parentConceptId === concept.id || relation.childConceptId === concept.id)
  const lines = [`# ${concept.name}`, '', `摘要：${concept.summary || '暂无摘要'}`, `状态：${concept.status}`, '', '## 别名', ...(conceptAliases.length ? conceptAliases.map((alias) => `- ${alias.alias}`) : ['- 暂无']), '', '## 笔记', concept.notes || '暂无', '', '## 关联阅读片段', ...(conceptUnits.length ? conceptUnits.map((unit) => `- ${unit.title || '未命名阅读片段'}：${unit.summary || '暂无摘要'}`) : ['- 暂无']), '', '## 关系', ...(relations.length ? relations.map((relation) => `- ${relation.relationType}：${store.concepts.find((item) => item.id === (relation.parentConceptId === concept.id ? relation.childConceptId : relation.parentConceptId))?.name ?? '未知'}`) : ['- 暂无'])]
  void saveExport(`${concept.name.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}.md`, lines.join('\n'), 'markdown', '知识主题 Markdown 已导出')
}

function exportSession(session: Session): void {
  const payload = { export_version: 1, exported_at: new Date().toISOString(), session, messages: store.messages.filter((message) => message.sessionId === session.id), units: store.units.filter((unit) => unit.sessionId === session.id), nav: store.navNodes.filter((node) => node.sessionId === session.id) }
  void saveExport(`${session.title || 'session'}.json`, JSON.stringify(payload, null, 2), 'json', '会话 JSON 已导出')
}

function saveProvider(): void {
  const name = providerDraft.value.name.trim() || '未命名连接'
  let id = providerDraft.value.id
  if (!id || store.config.llm.providers.some((provider) => provider.id === id && provider.name !== name)) {
    const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    const base = slug || 'provider'
    id = base
    let suffix = 2
    while (store.config.llm.providers.some((provider) => provider.id === id)) {
      id = `${base}-${suffix}`
      suffix += 1
    }
  }
  const providers = store.config.llm.providers.filter((provider) => provider.id !== id)
  store.updateConfig({ llm: { ...store.config.llm, providers: [...providers, { ...providerDraft.value, id, name }], defaultProvider: id } })
  providerDraft.value = { ...providerDraft.value, id }
  notify('连接配置已保存')
}

function setDefaultProvider(providerId: string): void {
  store.updateConfig({ llm: { ...store.config.llm, defaultProvider: providerId } })
}

function removeProvider(providerId: string): void {
  if (!window.confirm('删除这个模型连接配置？')) return
  const providers = store.config.llm.providers.filter((provider) => provider.id !== providerId)
  const defaultProvider = store.config.llm.defaultProvider === providerId ? providers[0]?.id ?? null : store.config.llm.defaultProvider
  store.updateConfig({ llm: { ...store.config.llm, providers, defaultProvider } })
  notify('连接配置已删除')
}

async function createDatabaseBackup(): Promise<void> {
  try {
    const reference = await store.createDatabaseBackup()
    notify(reference ? `数据库备份已创建：${reference}` : '当前没有可备份的数据库')
  } catch (error) {
    notify(error instanceof Error ? error.message : '数据库备份失败')
  }
}

async function fetchStorageInfo(): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    const info = await invokeTauri<{ data_dir: string; database_path: string; config_path: string }>('storage_info', { customPath: store.config.storage.databasePath || '' })
    storageInfo.value = { dataDir: info.data_dir, databasePath: info.database_path, configPath: info.config_path }
  } catch {
    // 路径信息仅用于展示，读取失败时保留默认描述。
  }
}

async function fetchSystemFonts(): Promise<void> {
  if (!desktopFontRuntime) return
  systemFontsLoading.value = true
  systemFontsUnavailable.value = false
  try {
    const families = await invokeTauri<unknown>('list_system_fonts')
    if (!Array.isArray(families)) throw new Error('字体列表格式无效')
    systemFontFamilies.value = [...new Set(families
      .filter((family): family is string => typeof family === 'string' && family.trim().length > 0)
      .map((family) => family.trim()))]
      .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
  } catch {
    systemFontsUnavailable.value = true
  } finally {
    systemFontsLoading.value = false
  }
}

function applyDatabasePath(): void {
  const next = databasePathDraft.value.trim()
  if (next === (store.config.storage.databasePath ?? '')) return
  if (!window.confirm('切换数据库位置前会自动备份当前数据库；如果新位置是空文件，界面将显示空知识库。确定继续吗？')) return
  store.changeDatabasePath(next)
    .then((backup) => {
      notify(backup ? `数据库位置已切换，原库备份：${backup}` : '数据库位置已更新')
      return fetchStorageInfo()
    })
    .catch((error) => notify(error instanceof Error ? error.message : '切换数据库位置失败'))
}

function updateMode(mode: 'api' | 'prompt_paste' | null): void {
  store.updateConfig({ llm: { ...store.config.llm, mode } })
  notify(mode ? `已切换到 ${mode === 'api' ? 'API 模式' : 'Prompt 粘贴模式'}` : '请选择 LLM 模式')
}

function setConcurrency(value: number): void {
  const concurrency = normalizeApiConcurrency(value, store.config.llm.concurrency)
  concurrencyDraft.value = String(concurrency)
  store.updateConfig({ llm: { ...store.config.llm, concurrency } })
  notify(`API 并发数已设为 ${concurrency}`)
}
function setRetries(value: number): void {
  const retries = normalizeApiRetries(value, store.config.llm.retries)
  retriesDraft.value = String(retries)
  store.updateConfig({ llm: { ...store.config.llm, retries } })
  notify(`API 重试次数已设为 ${retries}`)
}

function setConceptLimit(): void {
  const conceptLimit = normalizeConceptLimit(conceptLimitDraft.value, store.config.llm.conceptLimit || DEFAULT_CONCEPT_LIMIT)
  conceptLimitDraft.value = String(conceptLimit)
  store.updateConfig({ llm: { ...store.config.llm, conceptLimit } })
  notify(`每次 Concept 上限已设为 ${conceptLimit}`)
}

function setTokenBudget(): void {
  const tokenBudget = normalizeTokenBudget(tokenBudgetDraft.value, store.config.llm.tokenBudget)
  tokenBudgetDraft.value = String(tokenBudget)
  store.updateConfig({ llm: { ...store.config.llm, tokenBudget } })
  notify(`Token 预算已设为 ${tokenBudget.toLocaleString()}`)
}

function setFontFamily(value: string): void {
  const family = value.trim()
  if (!family || family.length > 160) return
  store.updateConfig({ ui: { ...store.config.ui, fontFamily: family } })
}

function setFontSize(value: number): void {
  const fontSize = Math.min(20, Math.max(13, Number(value) || 15))
  store.updateConfig({ ui: { ...store.config.ui, fontSize } })
}

function nextWelcomePhrase(): string {
  if (!welcomePhrases.length) return ''
  if (!welcomePhraseQueue.length) {
    welcomePhraseQueue = welcomePhrases.map((_, index) => index)
    for (let index = welcomePhraseQueue.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1))
      ;[welcomePhraseQueue[index], welcomePhraseQueue[swapIndex]] = [welcomePhraseQueue[swapIndex], welcomePhraseQueue[index]]
    }
    if (welcomePhraseQueue.length > 1 && welcomePhraseQueue[0] === lastWelcomePhraseIndex) {
      const swapIndex = 1 + Math.floor(Math.random() * (welcomePhraseQueue.length - 1))
      ;[welcomePhraseQueue[0], welcomePhraseQueue[swapIndex]] = [welcomePhraseQueue[swapIndex], welcomePhraseQueue[0]]
    }
  }
  const phraseIndex = welcomePhraseQueue.shift() ?? 0
  lastWelcomePhraseIndex = phraseIndex
  try {
    window.localStorage.setItem(welcomePhraseStorageKey, String(phraseIndex))
  } catch {
    // 某些隐私模式会禁用本地存储，内存轮换仍然可用。
  }
  return welcomePhrases[phraseIndex]
}

function startWelcomeTypewriter(): void {
  if (welcomeTimer != null) window.clearTimeout(welcomeTimer)
  welcomeTimer = null
  const run = ++welcomeRun
  const phrase = nextWelcomePhrase()
  const reduced = store.config.ui.reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced) {
    welcomeText.value = phrase
    return
  }
  let cursor = 0
  welcomeText.value = ''
  const typeNext = (): void => {
    if (run !== welcomeRun) return
    cursor += 1
    welcomeText.value = phrase.slice(0, cursor)
    if (cursor < phrase.length) welcomeTimer = window.setTimeout(typeNext, 52)
    else welcomeTimer = null
  }
  welcomeTimer = window.setTimeout(typeNext, 180)
}

function toggleSession(sessionId: string): void {
  expandedSessionIds.value = expandedSessionIds.value.includes(sessionId) ? expandedSessionIds.value.filter((id) => id !== sessionId) : [...expandedSessionIds.value, sessionId]
}

function sessionForUnit(unit: KnowledgeUnit): Session | undefined {
  return store.sessions.find((session) => session.id === unit.sessionId)
}

watch(selectedUnitId, (unitId) => {
  newUnitConcept.value = ''
  const unit = unitId ? store.units.find((item) => item.id === unitId) : null
  if (unit) {
    unitDraftTitle.value = unit.title ?? ''
    unitDraftSummary.value = unit.summary ?? ''
  }
})

watch(selectedMessageId, () => {
  newMessageConcept.value = ''
})

watch(() => selectedConcept.value?.id, (conceptId) => {
  const concept = conceptId ? store.concepts.find((item) => item.id === conceptId) : null
  conceptDraftName.value = concept?.name ?? ''
  conceptDraftSummary.value = concept?.summary ?? ''
  conceptDraftNotes.value = concept?.notes ?? ''
  if (!concept) {
    conceptChildQuery.value = ''
    conceptParentQuery.value = ''
  }
}, { immediate: true })

watch(selectedTaskId, (taskId) => {
  const task = taskId ? store.tasks.find((item) => item.id === taskId) : null
  if (task?.type === 'maintenance') maintenancePanelOpen.value = true
})

watch(() => store.config.ui.theme, (theme) => {
  document.documentElement.dataset.theme = theme
}, { immediate: true })

watch(() => store.config.ui.fontFamily, (fontFamily) => {
  document.documentElement.style.setProperty('--app-font-family', fontStackForFamily(fontFamily))
  document.documentElement.style.setProperty('--app-mono-font-family', fontFamily === 'system-mono' ? fontStacks['system-mono'] : 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace')
}, { immediate: true })

watch(() => store.config.llm.tokenBudget, (tokenBudget) => {
  tokenBudgetDraft.value = String(tokenBudget)
}, { immediate: true })

watch(() => store.config.llm.conceptLimit, (conceptLimit) => {
  conceptLimitDraft.value = String(conceptLimit)
}, { immediate: true })

watch(() => store.config.llm.retries, (retries) => {
  retriesDraft.value = String(normalizeApiRetries(retries))
}, { immediate: true })

watch(() => store.config.llm.concurrency, (concurrency) => {
  concurrencyDraft.value = String(concurrency)
}, { immediate: true })

watch(() => store.config.ui.fontSize, (fontSize) => {
  const normalized = Math.min(20, Math.max(13, Number(fontSize) || 15))
  document.documentElement.style.setProperty('--app-font-size', `${normalized}px`)
  document.documentElement.style.setProperty('--app-font-scale', String(normalized / 15))
}, { immediate: true })

watch(() => store.config.ui.reducedMotion, () => {
  if (activeView.value === 'overview') startWelcomeTypewriter()
})

watch(activeView, (view, previousView) => {
  if (view === 'overview' && previousView !== undefined) startWelcomeTypewriter()
})

watch(fullscreenTarget, (target) => {
  document.body.classList.toggle('fullscreen-active', Boolean(target))
  fullscreenPage.value = 0
})

watch(fullscreenPageCount, (count) => {
  fullscreenPage.value = Math.min(fullscreenPage.value, Math.max(0, count - 1))
})

onMounted(async () => {
  startWelcomeTypewriter()
  await store.init()
  if (!store.selectedSessionId && store.activeSessions[0]) store.setSelectedSession(store.activeSessions[0].id)
  const provider = store.config.llm.providers[0]
  if (provider) providerDraft.value = { ...provider }
  databasePathDraft.value = store.config.storage.databasePath ?? ''
  void fetchStorageInfo()
  void fetchSystemFonts()
})

onBeforeUnmount(() => {
  welcomeRun += 1
  if (welcomeTimer != null) window.clearTimeout(welcomeTimer)
})
</script>

<template>
  <div class="app-shell" @dragover.prevent @drop="handleDrop">
    <aside class="sidebar" :class="{ collapsed: isSidebarCollapsed }">
      <div class="brand-lockup">
        <div class="brand-mark"><img :src="nexusLogo" alt="Nexus" /></div>
        <div class="brand-copy"><strong>Nexus</strong><span>织知工作台</span></div>
      </div>
      <button class="collapse-button icon-button" :aria-label="isSidebarCollapsed ? '展开导航' : '收起导航'" :title="isSidebarCollapsed ? '展开导航' : '收起导航'" @click="isSidebarCollapsed = !isSidebarCollapsed">
        <Menu :size="18" />
      </button>
      <nav class="primary-nav" aria-label="主导航">
        <button v-for="item in navItems" :key="item.id" class="nav-item" :class="{ active: activeView === item.id }" :title="item.label" @click="setView(item.id)">
          <component :is="item.icon" :size="18" />
          <span class="nav-label">{{ item.label }}</span>
          <b v-if="item.badge?.()" class="nav-badge">{{ item.badge?.() }}</b>
        </button>
      </nav>
      <div class="sidebar-footer">
        <div class="local-status"><span class="status-dot" />仅本机保存</div>
        <div class="sidebar-meta" :title="storageSummary">自动保存 · 本机</div>
      </div>
    </aside>

    <main class="main-shell">
      <header class="topbar">
        <div class="topbar-title"><span class="eyebrow">NEXUS / {{ activeView === 'graph' ? 'KNOWLEDGE MAP' : 'WORKSPACE' }}</span><h1>{{ viewTitle }}</h1></div>
        <div class="topbar-actions">
          <div class="global-search" :class="{ expanded: showSearch }">
            <Search :size="17" />
            <input v-model="searchQuery" aria-label="搜索知识主题、阅读片段或消息" placeholder="搜索知识主题、阅读片段或消息" @focus="showSearch = true" />
            <button v-if="searchQuery" class="clear-search icon-button" aria-label="清空搜索" @click="searchQuery = ''"><X :size="14" /></button>
            <div v-if="showSearch && searchQuery" class="search-popover">
              <div v-if="searchResults.concepts.length" class="search-group"><span class="search-group-title">知识主题</span><button v-for="concept in searchResults.concepts.slice(0, 5)" :key="concept.id" @click="openConcept(concept.id); showSearch = false"><Layers3 :size="14" />{{ displayText(concept.name, '未命名知识主题') }}</button></div>
              <div v-if="searchResults.units.length" class="search-group"><span class="search-group-title">阅读片段</span><button v-for="unit in searchResults.units.slice(0, 4)" :key="unit.id" @click="openUnit(unit.id); showSearch = false"><BookOpen :size="14" />{{ displayText(unit.title, '未命名阅读片段') }}</button></div>
              <div v-if="searchResults.messages.length" class="search-group"><span class="search-group-title">消息</span><button v-for="message in searchResults.messages.slice(0, 4)" :key="message.id" @click="openMessage(message.id); showSearch = false"><History :size="14" />{{ message.content.slice(0, 42) }}</button></div>
              <div v-if="!Object.values(searchResults).some((items) => items.length)" class="empty-search">没有匹配结果</div>
            </div>
          </div>
          <button class="button secondary-button" @click="triggerImport"><Upload :size="16" />导入 JSON</button>
          <button v-if="maintenancePageHasContext" class="button secondary-button maintenance-entry-button" :aria-expanded="maintenancePanelOpen" @click="openMaintenancePanel"><Sparkles :size="16" />全图维护</button>
          <input ref="importInput" type="file" accept="application/json,.json" hidden @change="handleImport" />
          <button class="icon-button" title="导出完整知识库" aria-label="导出完整知识库" @click="exportKnowledgeBase"><Database :size="17" /></button>
          <button class="icon-button" title="恢复知识库备份" aria-label="恢复知识库备份" @click="triggerRestore"><FolderOpen :size="17" /></button>
          <input ref="restoreInput" type="file" accept="application/json,.json" hidden @change="handleRestore" />
          <button class="icon-button" title="使用指南" aria-label="使用指南" @click="helpOpen = true"><CircleHelp :size="18" /></button>
        </div>
      </header>

      <section class="content-shell">
        <div v-if="activeView === 'tasks'" class="queue-toolbar">
          <span class="queue-status">{{ store.queueRunning ? (store.queuePaused ? '队列已暂停' : `正在处理 ${store.queueActiveCount} 个任务`) : '队列空闲' }}</span>
          <span v-if="store.config.llm.mode === 'api' && !store.queueRunning && queueEstimate.count" class="queue-estimate">待处理 {{ queueEstimate.count }} 个任务 · 覆盖 {{ queueEstimate.sessions }} 个会话 · 预计调用约 {{ queueEstimate.count }} 次</span>
          <button v-if="store.config.llm.mode === 'api' && !store.queueRunning" class="button primary-button" @click="startTaskQueue"><Send :size="14" />开始 API 队列</button>
          <button v-if="store.queueRunning && !store.queuePaused" class="button secondary-button" @click="pauseTaskQueue"><Pause :size="14" />暂停</button>
          <button v-if="store.queueRunning && store.queuePaused" class="button secondary-button" @click="resumeTaskQueue"><Play :size="14" />继续</button>
        </div>
        <div v-if="activeView === 'tasks'" class="task-filter-toolbar" aria-label="任务筛选与排序">
          <label><span>类型</span><select v-model="taskTypeFilter" aria-label="按任务类型筛选"><option value="all">全部类型</option><option v-for="option in taskTypeOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label><span>状态</span><select v-model="taskStatusFilter" aria-label="按任务状态筛选"><option value="all">全部状态</option><option value="active">待处理与运行中</option><option value="review">需要检查</option><option value="completed">已完成与失败</option></select></label>
          <label><span>排序</span><select v-model="taskSort" aria-label="任务排序方式"><option value="created_desc">最新创建</option><option value="created_asc">最早创建</option><option value="status">按处理状态</option></select></label>
          <span class="task-filter-count">显示 {{ visibleTasks.length }} / {{ store.tasks.length }}</span>
        </div>
        <div v-if="activeView === 'tasks' && selectedTask" class="task-command-bar">
          <span>{{ selectedTask.scopeLabel || taskTypeLabel(selectedTask.type) }}</span>
          <button v-if="selectedTask.mode === 'api' && ['pending', 'failed', 'needs_review'].includes(selectedTask.status)" class="button primary-button" @click="selectedTask.status === 'pending' || selectedTask.status === 'needs_review' ? executeApiTask(selectedTask) : retryTask(selectedTask)"><Send :size="14" />{{ selectedTask.status === 'needs_review' ? '自动修复并重试' : selectedTask.status === 'pending' ? '执行任务' : '重试任务' }}</button>
          <button v-if="selectedTask.type !== 'segmentation' && ['failed', 'needs_review', 'stale', 'cancelled'].includes(selectedTask.status)" class="button secondary-button" @click="retryTask(selectedTask)"><RefreshCw :size="14" />重新排队</button>
          <button v-if="['pending', 'running'].includes(selectedTask.status)" class="button secondary-button" @click="cancelTask(selectedTask)"><X :size="14" />取消</button>
          <button v-if="selectedTask.mode === 'prompt_paste' && ['pending', 'needs_review'].includes(selectedTask.status)" class="button secondary-button" @click="openPromptTask(selectedTask)"><Clipboard :size="14" />右侧 Prompt 浮层</button>
          <button v-if="selectedTask.type === 'conversation'" class="button secondary-button" @click="openTaskConversation(selectedTask)"><MessageSquare :size="14" />回到对话</button>
        </div>
        <div v-if="store.configWarning" class="feedback-banner feedback-warning"><CircleHelp :size="16" /><span>{{ store.configWarning }}</span><button class="icon-button" aria-label="关闭配置提示" @click="store.configWarning = null"><X :size="15" /></button></div>
        <div v-if="taskFeedback" class="feedback-banner feedback-error" role="alert"><CircleHelp :size="16" /><span>{{ taskFeedback.text }}</span><button class="icon-button" aria-label="关闭任务错误提示" @click="taskFeedback = null"><X :size="15" /></button></div>
        <div v-if="importFeedback" class="feedback-banner" :class="`feedback-${importFeedback.tone}`"><Check v-if="importFeedback.tone === 'success'" :size="16" /><CircleHelp v-else :size="16" /><span>{{ importFeedback.text }}</span><div v-if="pendingImportRaw" class="feedback-actions"><button class="text-button" @click="resolveChangedImport('replace')">更新变化会话</button><button class="text-button" @click="resolveChangedImport('new')">作为新会话</button><button class="text-button" @click="resolveChangedImport('skip')">跳过</button></div><button class="icon-button" aria-label="关闭提示" @click="importFeedback = null; pendingImportRaw = null"><X :size="15" /></button></div>
        <div v-if="activeView === 'tasks' && store.tasks.length && !visibleTasks.length" class="feedback-banner feedback-info"><CircleHelp :size="16" /><span>当前筛选没有匹配任务。</span><button class="text-button" @click="taskTypeFilter = 'all'; taskStatusFilter = 'all'">清除筛选</button></div>

        <section v-if="activeView === 'overview'" class="view-panel overview-view">
          <section class="new-chat-panel surface-section" :class="{ 'conversation-mode': activeConversationSession }">
            <div v-if="activeConversationSession" class="chat-conversation-workspace">
              <header class="conversation-workspace-header">
                <div class="conversation-heading"><button class="icon-button" aria-label="返回上一级探索" title="返回上一级探索" @click="goConversationBack"><ArrowLeft :size="17" /></button><div><span class="eyebrow">ACTIVE CONVERSATION</span><h2>{{ displayText(activeConversationSession.title, '未命名会话') }}</h2><span>{{ activeConversationMessages.length }} 条消息 · {{ activeConversationStatus }}</span></div></div>
                <div class="conversation-header-actions"><button class="button secondary-button" @click="openFullscreenSession(activeConversationSession.id)"><Maximize2 :size="15" />全屏</button><button class="icon-button" aria-label="结束当前对话" title="回到新对话首页" @click="leaveConversationSession"><MessageSquarePlus :size="17" /></button></div>
              </header>
              <nav v-if="conversationNavTrail.length" class="conversation-breadcrumbs" aria-label="探索路径"><button v-for="node in conversationNavTrail" :key="node.id" class="breadcrumb-node" :class="{ current: node.id === selectedNavNodeId }" @click="selectConversationNode(node)">{{ displayText(node.label, '未命名探索节点') }}</button></nav>
              <div class="conversation-layout">
                <aside class="conversation-minimap" aria-label="探索树小地图"><div class="minimap-heading"><GitBranch :size="14" /><span>探索树</span></div><ConversationTree :nodes="activeConversationNodes" :selected-node-id="activeConversationDisplayedNodeId" @select-node="selectConversationNode" /></aside>
                <div class="conversation-scroll" role="log" aria-live="polite">
                  <div v-if="activeConversationCurrentCard" class="conversation-card-stage" :style="{ '--stack-count': activeConversationBranchCards.length }">
                    <TransitionGroup name="branch-card" tag="div" class="conversation-card-stack">
                      <section v-for="(card, cardIndex) in activeConversationBranchCards" :key="card.node.id" class="conversation-branch-card" :class="{ current: cardIndex === activeConversationBranchCards.length - 1, ancestor: cardIndex < activeConversationBranchCards.length - 1 }" :aria-hidden="cardIndex < activeConversationBranchCards.length - 1 ? 'true' : undefined" :aria-label="`${cardIndex === activeConversationBranchCards.length - 1 ? '当前' : '祖先'}探索分支：${card.node.label}`" :style="{ '--stack-depth': activeConversationBranchCards.length - cardIndex - 1 }">
                        <div v-if="cardIndex === activeConversationBranchCards.length - 1" class="conversation-branch-card-title current-title"><button class="branch-card-title-main" type="button" @click="selectConversationNode(card.node)"><span class="branch-card-dot" aria-hidden="true" /><strong>{{ displayText(card.node.label, '未命名探索节点') }}</strong><span class="branch-card-depth">第 {{ card.node.depth + 1 }} 层</span></button><button v-if="pendingConversationBranch?.id === card.node.id && pendingConversationBranchCanClose" class="icon-button branch-card-close" type="button" aria-label="关闭这条未开始的探索分支" title="关闭分支" @click="closePendingConversationBranch"><X :size="15" /></button></div>
                        <div v-else class="conversation-branch-card-title" aria-hidden="true"><span class="branch-card-dot" aria-hidden="true" /><strong>{{ displayText(card.node.label, '未命名探索节点') }}</strong><span class="branch-card-depth">第 {{ card.node.depth + 1 }} 层</span></div>
                        <div v-if="card.units.length" class="conversation-card-units" aria-label="当前阅读片段"><BookOpen :size="13" /><span>阅读片段：</span><button v-for="unit in card.units" :key="unit.id" type="button" class="conversation-unit-link" @click="openUnit(unit.id)">{{ displayText(unit.title, '未命名阅读片段') }}</button></div>
                        <article v-for="message in card.messages" :key="message.id" :data-conversation-message="message.id" class="conversation-message" :class="message.role"><div class="conversation-message-meta"><strong>{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI' : '系统' }}</strong><span>消息 #{{ message.orderInSession + 1 }}</span></div><div class="md-body" v-html="renderedMessageContent(message.content, message)" @click="handleRenderedClick($event, message)" @keydown.enter.prevent="handleRenderedClick($event, message)" /></article>
                        <article v-if="cardIndex === activeConversationBranchCards.length - 1 && activeConversationStreamingPreview" class="conversation-message assistant streaming-message" :class="{ 'needs-review-answer': activeConversationTask?.status === 'needs_review' || activeConversationTask?.status === 'failed' }" aria-live="polite"><div class="conversation-message-meta"><strong>AI</strong><span>{{ activeConversationTask?.status === 'needs_review' ? '待检查回答' : activeConversationTask?.status === 'failed' ? '任务错误 · 已保留回答' : '实时输出' }}</span></div><div class="md-body" v-html="renderMarkdown(activeConversationStreamingPreview, { concepts: markdownConceptsForStreamingTask(activeConversationTask), autoLinkConcepts: 'suggested' })" @click="handleRenderedClick($event, undefined, activeConversationTask?.id)" @keydown.enter.prevent="handleRenderedClick($event, undefined, activeConversationTask?.id)" /></article>
                      </section>
                    </TransitionGroup>
                  </div>
                  <div v-if="activeConversationTask?.status === 'running'" class="conversation-thinking"><LoaderCircle class="spin" :size="16" />AI 正在处理这次提问…</div>
                  <div v-if="!activeConversationCurrentCard?.messages.length" class="empty-state compact"><MessageSquare :size="26" /><strong>{{ activeConversationCurrentCard ? '这一分支还没有回答' : '等待第一条回答' }}</strong><span>{{ activeConversationCurrentCard ? '提交问题后，回答会留在当前分支。' : '回答完成后会显示在这里。' }}</span></div>
                  <div class="conversation-composer"><textarea v-model="composerQuestion" rows="3" aria-label="继续当前对话" placeholder="继续追问…" :disabled="Boolean(activeConversationTask && ['pending', 'running', 'needs_review'].includes(activeConversationTask.status))" @keydown.ctrl.enter.prevent="startConversationFollowUp" @keydown.meta.enter.prevent="startConversationFollowUp" /><div class="conversation-composer-footer"><span>{{ activeConversationTask && ['pending', 'running', 'needs_review'].includes(activeConversationTask.status) ? '请先完成当前分支回答' : store.config.llm.mode === 'api' ? 'API 会直接执行' : 'Prompt 会在右侧浮层中处理' }}</span><button class="send-button" aria-label="发送追问" :disabled="!composerQuestion.trim() || Boolean(activeConversationTask && ['pending', 'running', 'needs_review'].includes(activeConversationTask.status))" @click="startConversationFollowUp"><Send :size="17" /></button></div></div>
                </div>
              </div>
            </div>
            <div v-else class="chat-home">
              <div class="chat-welcome"><div class="chat-welcome-mark"><img :src="nexusLogo" alt="" /></div><h2 aria-live="polite">{{ welcomeText }}<span class="chat-welcome-caret" aria-hidden="true" /></h2><p>从一个问题开始，或把已有知识带进新的对话。</p></div>
              <div class="chat-composer" :class="{ focused: composerQuestion.length }">
                <textarea v-model="composerQuestion" rows="4" placeholder="输入消息…" aria-label="新对话问题" @keydown.ctrl.enter.prevent="submitComposer" @keydown.meta.enter.prevent="submitComposer"></textarea>
                <div class="chat-composer-topbar">
                  <div class="chat-select topic-select"><span>主题</span><SearchSelect v-model="composerTopicIds" multiple :options="[{ value: null, label: '不指定' }, ...store.activeConcepts.map((concept) => ({ value: concept.id, label: concept.name, hint: concept.summary }))]" aria-label="选择知识主题" /></div>
                  <div class="chat-select phrase-select"><span>快捷短语</span><select v-model="composerPhraseId" aria-label="选择快捷短语" @change="applyComposerPhrase"><option value="">无</option><option v-for="phrase in store.quickPhrases" :key="phrase.id" :value="phrase.id">{{ phrase.template }}</option></select><ChevronDown :size="13" /></div>
                </div>
                <div class="chat-composer-footer">
                  <div class="chat-tools"><button class="chat-tool" type="button" @click="setView('graph')"><Plus :size="17" /><span>{{ composerSourceUnitIds.length || composerSourceMessageIds.length ? `已选 ${composerSourceUnitIds.length} 个阅读片段 · ${composerSourceMessageIds.length} 条消息` : '添加知识上下文' }}</span></button><label class="chat-toggle"><input v-model="composerIncludeFull" type="checkbox" /><span>包含原文</span></label></div>
                  <button class="send-button" type="button" aria-label="发送新对话" title="发送（Ctrl/⌘ + Enter）" :disabled="!composerQuestion.trim()" @click="submitComposer"><Send :size="17" /></button>
                </div>
              </div>
              <div class="chat-status-line"><span>{{ store.config.llm.mode === 'api' ? 'API 模式' : store.config.llm.mode === 'prompt_paste' ? 'Prompt 粘贴模式' : '选择模式后即可发送' }}</span><button v-if="!store.config.llm.mode" class="text-button" @click="setView('settings')">去设置</button><span class="chat-local-note">内容默认只保存在本机</span></div>
            </div>
          </section>
          <div v-if="!activeConversationSession" class="overview-support-grid">
            <section class="surface-section support-card"><div class="section-heading"><div><span class="eyebrow">RECENT SESSIONS</span><h3>最近会话</h3></div><button class="text-button" @click="setView('sessions')">查看全部 <ArrowRight :size="14" /></button></div><div class="recent-list"><button v-for="session in store.activeSessions.slice(0, 4)" :key="session.id" class="recent-row" @click="openConversationSession(session.id)"><div class="session-avatar"><History :size="15" /></div><div class="row-main"><strong>{{ displayText(session.title, '未命名会话') }}</strong><span>{{ session.platform }} · {{ session.messageCount }} 条消息 · {{ session.unitCount }} 个阅读片段</span></div><ChevronRight :size="16" /></button><div v-if="!store.activeSessions.length" class="empty-inline">还没有会话，先提出你的第一个问题。</div></div></section>
            <section class="surface-section support-card"><div class="section-heading"><div><span class="eyebrow">YOUR LIBRARY</span><h3>知识库状态</h3></div><BookOpen :size="19" /></div><div class="mini-metrics"><div><strong>{{ store.stats.sessions }}</strong><span>会话</span></div><div><strong>{{ store.stats.units }}</strong><span>阅读片段</span></div><div><strong>{{ store.stats.concepts }}</strong><span>知识主题</span></div></div><div class="support-actions"><button class="button secondary-button" @click="triggerImport"><Upload :size="15" />导入历史对话</button><button class="button ghost-button" @click="setView('graph')"><Network :size="15" />查看知识图谱</button></div></section>
          </div>
        </section>

        <section v-else-if="activeView === 'graph'" class="view-panel graph-view">
          <div class="graph-layout">
          <div class="graph-stage-toolbar"><div class="graph-stage-heading"><span class="eyebrow">GLOBAL GRAPH</span><h2>知识主题关系网络</h2></div><div class="toolbar-actions"><div class="compact-search"><Search :size="15" /><input v-model="graphSearch" placeholder="过滤节点" aria-label="过滤图谱节点" /></div><button class="button secondary-button" @click="openMaintenancePanel"><Sparkles :size="15" />全图维护</button><button class="button secondary-button" @click="exportSnapshot"><Download :size="15" />导出快照</button><button class="icon-button" title="重置布局" aria-label="重置布局" @click="resetGraphLayout"><RotateCcw :size="17" /></button></div></div>
          <div class="graph-main"><GraphCanvas :key="graphLayoutNonce" :snapshot="currentGraph" :viewport="store.graphViewport" :selected-unit-ids="store.selectedContextIds" :expanded-concept-ids="expandedConceptIds" :hierarchy-relations="store.relations" :active-concept-ids="store.activeConcepts.map((concept) => concept.id)" :show-proposed="graphShowProposed" :reduced-motion="store.config.ui.reducedMotion" :viewport-right-inset="graphDetailInset" @select-concept="openConcept" @toggle-concept="toggleGraphConcept" @select-unit="openUnit" @select-message="openFullscreenMessage" @box-select-unit="addBoxSelectedUnit" @layout-change="saveGraphLayout" @viewport-change="saveGraphViewport" /></div>
            <aside v-if="graphControlsOpen" class="graph-controls surface-section"><div class="panel-heading"><div><span class="eyebrow">VIEW</span><h3>显示选项</h3></div><button class="icon-button" title="收起显示选项" aria-label="收起显示选项" @click="graphControlsOpen = false"><X :size="16" /></button></div><label class="toggle-row"><span><strong>阅读片段</strong><small>统一显示全部阅读片段，点击主题不会改变节点集合</small></span><input v-model="graphShowUnits" type="checkbox" /></label><label class="toggle-row"><span><strong>消息与会话链</strong><small>显示同一会话中的原始消息及顺序连接</small></span><input v-model="graphShowMessages" type="checkbox" /></label><label class="toggle-row"><span><strong>未归档会话</strong><small>显示尚未分类或分类后保留的探讨、流程会话</small></span><input v-model="graphShowRetainedSessions" type="checkbox" /></label><label class="toggle-row"><span><strong>待确认关系</strong><small>以虚线呈现建议关系</small></span><input v-model="graphShowProposed" type="checkbox" /></label><div class="graph-mini-stats"><div><strong>{{ graphOverview.concepts }}</strong><span>知识主题</span></div><div><strong>{{ graphOverview.units }}</strong><span>阅读片段</span></div><div><strong>{{ graphOverview.edges }}</strong><span>关系</span></div></div><div class="graph-control-note"><GitBranch :size="15" /><span>主题共现按会话去重累计；阅读片段只提供可选证据。点击主题可查看详情并逐层展开，拖拽只改变位置。</span></div></aside>
            <button v-else class="icon-button graph-controls-launcher" title="打开显示选项" aria-label="打开显示选项" @click="graphControlsOpen = true"><SlidersHorizontal :size="17" /></button>
          </div>
        </section>

        <section v-else-if="activeView === 'sessions'" class="view-panel sessions-view"><div class="page-toolbar"><div><span class="eyebrow">SESSION ARCHIVE</span><h2>会话与探索树</h2></div><div class="toolbar-actions"><button class="button secondary-button" @click="triggerImport"><Upload :size="15" />导入更多</button></div></div><div class="session-list surface-section"><div v-for="session in store.activeSessions.slice(0, visibleSessionCount)" :key="session.id" class="session-block"><div class="session-row-wrap"><button class="session-row" :aria-label="`进入会话：${displayText(session.title, '未命名会话')}`" @click="openConversationSession(session.id)"><div class="session-avatar"><History :size="16" /></div><div class="row-main"><strong>{{ displayText(session.title, '未命名会话') }}</strong><span>{{ session.platform }} · {{ session.messageCount }} 条消息 · {{ session.unitCount }} 个阅读片段</span></div><ArrowRight :size="17" /></button><button class="icon-button session-fullscreen-button" :aria-label="expandedSessionIds.includes(session.id) ? '收起会话摘要' : '展开会话摘要'" :title="expandedSessionIds.includes(session.id) ? '收起摘要' : '展开摘要'" @click.stop="toggleSession(session.id); selectSession(session.id)"><ChevronDown v-if="expandedSessionIds.includes(session.id)" :size="16" /><ChevronRight v-else :size="16" /></button><button class="icon-button session-fullscreen-button" aria-label="全屏查看会话" title="全屏查看会话" @click.stop="openFullscreenSession(session.id)"><Maximize2 :size="16" /></button></div><div v-if="expandedSessionIds.includes(session.id)" class="session-expanded"><div class="session-meta-line"><span>创建于 {{ new Date(session.createdAt).toLocaleDateString('zh-CN') }}</span><button class="text-button" @click.stop="exportSession(session)"><Download :size="14" />导出会话</button></div><div class="unit-timeline"><button v-for="unit in store.units.filter((item) => item.sessionId === session.id)" :key="unit.id" class="timeline-unit" :class="{ selected: selectedUnitId === unit.id }" @click="openUnit(unit.id)"><span class="timeline-dot" /><div><strong>{{ displayText(unit.title, '未命名阅读片段') }}</strong><span>{{ displayText(unit.summary, '暂无摘要') }}</span><small>{{ store.unitConceptNames(unit.id).map((name) => displayText(name)).join(' · ') || '未关联知识主题' }}</small></div></button><div v-if="!store.units.some((unit) => unit.sessionId === session.id)" class="empty-inline">这个会话没有整理阅读片段；原始消息、主题归属和探索树仍可直接使用。</div></div></div></div><div v-if="!store.activeSessions.length" class="empty-state session-empty-state"><History :size="30" /><strong>还没有会话</strong><span>导入 JSON 后，所有会话和探索树会显示在这里。</span><button class="button secondary-button" @click="triggerImport"><Upload :size="15" />导入历史对话</button></div></div><button v-if="store.activeSessions.length > visibleSessionCount" class="text-button load-more-button" @click="visibleSessionCount += 40">加载更多会话（还有 {{ store.activeSessions.length - visibleSessionCount }} 个）</button></section>

        <ReadingUnitsView v-else-if="activeView === 'units'" :units="store.units.filter((unit) => store.activeSessions.some((session) => session.id === unit.sessionId))" :sessions="store.activeSessions" :messages="store.messages" :concepts="store.activeConcepts" :selected-unit-id="selectedUnitId" @select="openUnitPage" @select-concept="openConceptCatalog" @close="selectedUnitId = null" />

        <section v-else-if="activeView === 'concepts'" class="view-panel concepts-view">
          <div class="page-toolbar">
            <div><span class="eyebrow">KNOWLEDGE TOPICS</span><h2>知识主题目录</h2></div>
            <div class="toolbar-actions"><button class="button secondary-button" @click="setView('graph')"><Network :size="15" />在图谱中查看</button></div>
          </div>
          <div class="concepts-layout">
            <div class="concept-list surface-section">
              <div class="list-toolbar">
                <span>{{ store.activeConcepts.length }} 个知识主题</span>
                <div class="compact-search"><Search :size="14" /><input v-model="graphSearch" placeholder="过滤知识主题" aria-label="过滤知识主题" /></div>
              </div>
              <ConceptTree :concepts="conceptTreeConcepts" :relations="store.relations" :selected-id="selectedConceptId" :expanded-ids="conceptTreeExpandedIdsForView" @select="openConcept" @toggle="toggleConceptTree" />
            </div>
            <div ref="conceptPageDetail" class="concept-detail surface-section" tabindex="-1">
              <template v-if="selectedConcept">
                <div class="detail-header">
                  <div><span class="eyebrow">KNOWLEDGE TOPIC</span><h3>{{ displayText(selectedConcept.name, '未命名知识主题') }}</h3></div>
                  <div class="drawer-header-actions">
                    <button class="button primary-button" @click="openComposer({ topicId: selectedConcept.id, sourceUnitIds: selectedConceptUnits.map((unit) => unit.id) })"><MessageSquare :size="14" />开始新对话</button>
                    <button class="icon-button" title="归档知识主题" aria-label="归档知识主题" @click="archiveSelectedConcept"><Archive :size="16" /></button>
                  </div>
                </div>
                <div class="alias-row">
                  <span>别名</span>
                  <span v-for="alias in store.aliases.filter((item) => item.conceptId === selectedConcept?.id)" :key="alias.id" class="soft-tag">{{ alias.alias }}</span>
                  <span v-if="!store.aliases.some((item) => item.conceptId === selectedConcept?.id)" class="muted">暂无别名</span>
                </div>
                <p v-if="selectedConceptHasProposedRelations" class="concept-proposed-note" role="note">
                  “待确认”只表示关系尚未人工确认，不代表任务中心里一定有正在运行的 API 请求。它可能来自历史导入、整理结果或维护建议；打开主题只读取本地数据，不会创建任务或调用 API。
                </p>
                <div class="relation-summary concept-page-stats">
                  <div><span>父主题</span><strong>{{ selectedConceptParents.length }}</strong></div>
                  <div><span>子主题</span><strong>{{ selectedConceptChildren.length }}</strong></div>
                  <div><span>相关主题</span><strong>{{ selectedConceptRelated.length }}</strong></div>
                  <div><span>关联会话</span><strong>{{ selectedConceptSessions.length }}</strong></div>
                  <div><span>包含消息</span><strong>{{ selectedConceptMessages.length }}</strong></div>
                </div>

                <section class="concept-page-editor" aria-labelledby="concept-page-editor-title">
                  <div class="subsection-title"><strong id="concept-page-editor-title">主题信息</strong><span>本地可编辑</span></div>
                  <label class="field-label" for="concept-page-name">名称 <small>唯一标识</small></label>
                  <input id="concept-page-name" v-model="conceptDraftName" class="drawer-input" maxlength="120" autocomplete="off" />
                  <label class="field-label" for="concept-page-summary">摘要 <small>≤120 字</small></label>
                  <textarea id="concept-page-summary" v-model="conceptDraftSummary" class="drawer-textarea" maxlength="120" placeholder="用一句话概括这个主题的范围和核心结论"></textarea>
                  <label class="field-label" for="concept-page-notes">主题说明 / 笔记 <small>Concept.notes</small></label>
                  <textarea id="concept-page-notes" v-model="conceptDraftNotes" class="drawer-textarea concept-notes" placeholder="记录这个主题的长期理解、边界和待核实问题"></textarea>
                  <p class="field-hint">摘要用于目录和上下文导航；说明 / 笔记用于记录长期理解。</p>
                  <div class="concept-editor-actions"><button class="button primary-button" @click="saveConcept"><Check :size="14" />保存主题</button><button class="button ghost-button" @click="resetConceptDraft">撤销修改</button></div>
                </section>

                <div class="concept-page-relation-grid">
                  <section class="detail-subsection">
                    <div class="subsection-title"><strong>父主题</strong><span>{{ selectedConceptParents.length }} 个，可多选</span></div>
                    <div class="concept-relation-list">
                      <div v-for="relation in selectedConceptParents" :key="relation.id" class="concept-relation-row">
                        <div class="relation-copy">
                          <button class="relation-link" @click="openConcept(otherConceptOf(relation, selectedConcept!.id))">{{ conceptName(otherConceptOf(relation, selectedConcept!.id)) }}</button>
                          <small class="relation-summary-text">{{ relationSourceLabel(relation.source) }} · {{ conceptSummary(otherConceptOf(relation, selectedConcept!.id)) }}</small>
                        </div>
                        <span class="status-label" :class="relation.status === 'confirmed' ? 'label-success' : 'label-warning'">{{ relationStatusLabel(relation.status) }}</span>
                        <button v-if="relation.status === 'proposed'" class="icon-button relation-confirm" title="确认父主题关系" aria-label="确认父主题关系" @click="confirmConceptRelation(relation.id, 'confirmed')"><Check :size="13" /></button>
                        <button v-if="relation.status === 'proposed'" class="icon-button relation-reject" title="拒绝父主题关系" aria-label="拒绝父主题关系" @click="confirmConceptRelation(relation.id, 'rejected')"><X :size="13" /></button>
                        <button class="icon-button relation-remove" title="移除父主题关系" aria-label="移除父主题关系" @click="deleteConceptRelation(relation.id)"><Trash2 :size="13" /></button>
                      </div>
                      <div v-if="!selectedConceptParents.length" class="empty-inline">暂无已确认或待确认的父主题；当前主题位于目录根层。</div>
                    </div>
                    <label class="field-label relation-search-label" for="concept-page-parent-search">添加父主题</label>
                    <div class="relation-search"><Search :size="14" /><input id="concept-page-parent-search" v-model="conceptParentQuery" placeholder="输入名称实时查找" autocomplete="off" /></div>
                    <div v-if="conceptParentQuery.trim() && conceptParentCandidates.length" class="relation-candidates" role="listbox" aria-label="父主题候选">
                      <button v-for="candidate in conceptParentCandidates" :key="candidate.id" class="relation-candidate" @click="addConceptParent(candidate.id)"><Plus :size="13" /><span>{{ displayText(candidate.name, '未命名知识主题') }}</span><small>{{ linkedUnitCount(candidate.id) }} 个阅读片段</small></button>
                    </div>
                    <div v-else-if="conceptParentQuery.trim()" class="relation-candidate-empty">没有匹配的现有主题。</div>
                  </section>

                  <section class="detail-subsection">
                    <div class="subsection-title"><strong>子主题</strong><span>{{ selectedConceptChildren.length }} 个，可多选</span></div>
                    <div class="concept-relation-list">
                      <div v-for="relation in selectedConceptChildren" :key="relation.id" class="concept-relation-row">
                        <div class="relation-copy">
                          <button class="relation-link" @click="openConcept(otherConceptOf(relation, selectedConcept!.id))">{{ conceptName(otherConceptOf(relation, selectedConcept!.id)) }}</button>
                          <small class="relation-summary-text">{{ relationSourceLabel(relation.source) }} · {{ conceptSummary(otherConceptOf(relation, selectedConcept!.id)) }}</small>
                        </div>
                        <span class="status-label" :class="relation.status === 'confirmed' ? 'label-success' : 'label-warning'">{{ relationStatusLabel(relation.status) }}</span>
                        <button v-if="relation.status === 'proposed'" class="icon-button relation-confirm" title="确认子主题关系" aria-label="确认子主题关系" @click="confirmConceptRelation(relation.id, 'confirmed')"><Check :size="13" /></button>
                        <button v-if="relation.status === 'proposed'" class="icon-button relation-reject" title="拒绝子主题关系" aria-label="拒绝子主题关系" @click="confirmConceptRelation(relation.id, 'rejected')"><X :size="13" /></button>
                        <button class="icon-button relation-promote" title="解除当前父子引用并提升一级" aria-label="提升子主题一级" @click="promoteSelectedChild(relation.id)"><ArrowUp :size="14" /></button>
                      </div>
                      <div v-if="!selectedConceptChildren.length" class="empty-inline">暂无子主题。</div>
                    </div>
                    <label class="field-label relation-search-label" for="concept-page-child-search">添加子主题</label>
                    <div class="relation-search"><Search :size="14" /><input id="concept-page-child-search" v-model="conceptChildQuery" placeholder="输入名称实时查找" autocomplete="off" @keyup.enter="createAndAddConceptChild" /></div>
                    <div v-if="conceptChildQuery.trim() && conceptChildCandidates.length" class="relation-candidates" role="listbox" aria-label="子主题候选">
                      <button v-for="candidate in conceptChildCandidates" :key="candidate.id" class="relation-candidate" @click="addConceptChild(candidate.id)"><Plus :size="13" /><span>{{ displayText(candidate.name, '未命名知识主题') }}</span><small>{{ linkedUnitCount(candidate.id) }} 个阅读片段</small></button>
                    </div>
                    <div v-else-if="conceptChildQuery.trim()" class="relation-candidate-empty"><span>没有匹配的现有主题。</span><button class="text-button" @click="createAndAddConceptChild"><Plus :size="13" />创建并添加“{{ conceptChildQuery.trim() }}”</button></div>
                  </section>
                </div>

                <section class="detail-subsection">
                  <div class="subsection-title"><strong>相关主题</strong><span>{{ selectedConceptRelated.length }} 个，不参与目录层级</span></div>
                  <div class="concept-relation-list">
                    <div v-for="relation in selectedConceptRelated" :key="relation.id" class="concept-relation-row">
                      <div class="relation-copy">
                        <button class="relation-link" @click="openConcept(otherConceptOf(relation, selectedConcept!.id))"><Link2 :size="13" />{{ conceptName(otherConceptOf(relation, selectedConcept!.id)) }}</button>
                        <small class="relation-summary-text">{{ relationSourceLabel(relation.source) }} · {{ conceptSummary(otherConceptOf(relation, selectedConcept!.id)) }}</small>
                      </div>
                      <span class="status-label" :class="relation.derived ? 'label-neutral' : relation.status === 'confirmed' ? 'label-success' : 'label-warning'">{{ relation.derived ? `共同出现 · ${relation.sessionCount ?? 0} 个 Session` : relationStatusLabel(relation.status) }}</span>
                      <small v-if="relation.derived" class="relation-summary-text">{{ relation.messageCount ?? 0 }} 条消息</small>
                      <button v-if="!relation.derived && relation.status === 'proposed'" class="icon-button relation-confirm" title="确认相关主题关系" aria-label="确认相关主题关系" @click="confirmConceptRelation(relation.id, 'confirmed')"><Check :size="13" /></button>
                      <button v-if="!relation.derived && relation.status === 'proposed'" class="icon-button relation-reject" title="拒绝相关主题关系" aria-label="拒绝相关主题关系" @click="confirmConceptRelation(relation.id, 'rejected')"><X :size="13" /></button>
                      <button v-if="!relation.derived" class="icon-button relation-remove" title="移除维护相关关系" aria-label="移除维护相关关系" @click="deleteConceptRelation(relation.id)"><Trash2 :size="13" /></button>
                    </div>
                    <div v-if="!selectedConceptRelated.length" class="empty-inline">暂无共同出现或维护确认的相关主题。</div>
                  </div>
                </section>

                <section class="detail-subsection">
                  <div class="subsection-title"><strong>关联会话</strong><span>{{ selectedConceptSessions.length }} 个</span></div>
                  <button v-for="session in selectedConceptSessions" :key="session.id" class="mini-unit-row" @click="openFullscreenSession(session.id)"><History :size="14" /><span>{{ displayText(session.title, '未命名会话') }}</span><small>{{ session.messageCount }} 条消息</small><Maximize2 :size="14" /></button>
                  <div v-if="!selectedConceptSessions.length" class="empty-inline">暂无关联会话。会话、消息或阅读片段建立主题归属后会显示在这里。</div>
                </section>

                <section class="detail-subsection">
                  <div class="subsection-title"><strong>关联阅读片段</strong><span class="sort-inline"><select v-model="conceptUnitSort" aria-label="阅读片段排序方式"><option value="updated">最近更新</option><option value="created">创建时间</option><option value="title">名称</option></select><span>{{ selectedConceptUnits.length }}</span></span></div>
                  <button v-for="unit in selectedConceptUnits" :key="unit.id" class="mini-unit-row" @click="openUnit(unit.id)"><BookOpen :size="14" /><span>{{ displayText(unit.title, '未命名阅读片段') }}</span><small>{{ displayText(sessionForUnit(unit)?.title, '未命名会话') }}</small><ChevronRight :size="14" /></button>
                  <div v-if="!selectedConceptUnits.length" class="empty-inline">没有单独整理的阅读片段；会话和消息归属仍然有效。</div>
                </section>

                <section class="detail-subsection">
                  <div class="subsection-title"><strong>包含消息</strong><span>{{ selectedConceptMessages.length }} 条，来自 {{ selectedConceptSessions.length }} 个会话</span></div>
                  <button v-if="selectedConceptMessages.length" class="button secondary-button" @click="openFullscreenConcept(selectedConcept.id)"><Maximize2 :size="14" />全屏查看全部对话</button>
                  <div class="concept-message-preview">
                    <div v-for="message in selectedConceptMessages.slice(0, 12)" :key="message.id" class="mini-unit-row">
                      <MessageSquare :size="14" />
                      <span>{{ message.content.slice(0, 72) || '空消息' }}</span>
                      <small>{{ displayText(store.sessions.find((session) => session.id === message.sessionId)?.title, '未知会话') }}</small>
                    </div>
                  </div>
                  <div v-if="selectedConceptMessages.length > 12" class="empty-inline">其余 {{ selectedConceptMessages.length - 12 }} 条消息可在上方全屏视图中按会话分页查看。</div>
                  <div v-if="!selectedConceptMessages.length" class="empty-inline">暂无直接或证据包归属的消息。</div>
                </section>

                <section class="detail-subsection concept-page-maintenance">
                  <div class="subsection-title"><strong>建立关系</strong><span>手动写入，不调用 API</span></div>
                  <div class="relation-form">
                    <SearchSelect v-model="relationParentId" :options="[{ value: '', label: relationType === 'hierarchy' ? '选择父知识主题' : '选择相关关系一端' }, ...store.activeConcepts.map((concept) => ({ value: concept.id, label: concept.name, hint: concept.summary }))]" :aria-label="relationType === 'hierarchy' ? '父知识主题' : '相关关系一端'" />
                    <SearchSelect v-model="relationChildId" :options="[{ value: '', label: relationType === 'hierarchy' ? '选择子知识主题' : '选择相关关系另一端' }, ...store.activeConcepts.map((concept) => ({ value: concept.id, label: concept.name, hint: concept.summary }))]" :aria-label="relationType === 'hierarchy' ? '子知识主题' : '相关关系另一端'" />
                    <select v-model="relationType" aria-label="关系类型"><option value="hierarchy">父子</option><option value="related">相关</option></select>
                    <button class="button secondary-button" @click="createRelationFromForm"><Link2 :size="14" />建立</button>
                  </div>
                </section>

                <section class="detail-subsection">
                  <div class="subsection-title"><strong>合并到</strong><span>可撤销事务</span></div>
<div class="merge-form"><SearchSelect v-model="mergeTargetId" :options="[{ value: '', label: '选择目标知识主题' }, ...store.activeConcepts.filter((item) => item.id !== selectedConcept?.id).map((concept) => ({ value: concept.id, label: concept.name, hint: concept.summary }))]" aria-label="合并目标" /><button class="button danger-button" :disabled="!mergeTargetId" @click="mergeSelectedConcept"><GitBranch :size="14" />合并</button></div>
                </section>
              </template>
              <div v-else class="empty-detail"><Layers3 :size="30" /><strong>选择一个知识主题</strong><span>查看它的父子层级、相关主题、来源会话和消息证据。</span></div>
            </div>
          </div>
        </section>

        <section v-else-if="activeView === 'tasks'" class="view-panel tasks-view"><div class="page-toolbar"><div><span class="eyebrow">LLM TASK QUEUE</span><h2>任务中心</h2></div><div class="task-toolbar-meta"><span class="soft-tag" :class="store.config.llm.mode ? 'tag-active' : 'tag-warning'">{{ store.config.llm.mode ? (store.config.llm.mode === 'api' ? 'API 模式' : 'Prompt 粘贴') : '未选择模式' }}</span><span>{{ store.tasks.length }} 个任务</span></div></div><div v-if="!store.config.llm.mode" class="mode-callout"><Sparkles :size="19" /><div><strong>先选择 LLM 模式</strong><span>原始数据可以继续浏览；选择 API 或 Prompt 粘贴后才能启动整理任务。</span></div><button class="button primary-button" @click="setView('settings')"><Settings2 :size="15" />去设置</button></div><section v-if="proposedConceptRelations.length" class="pending-relation-inbox surface-section" aria-labelledby="pending-relation-title"><div class="section-heading"><div><span class="eyebrow">RELATION REVIEW</span><h3 id="pending-relation-title">待确认关系</h3><p>这些关系已写入本地图谱，确认或拒绝不会发起新的 API 请求。</p></div><div class="pending-relation-heading-actions"><span class="status-label label-warning">{{ proposedConceptRelations.length }} 条</span><button class="button secondary-button confirm-all-relations" type="button" @click="confirmAllProposedRelations"><Check :size="14" />确认全部 {{ proposedConceptRelations.length }} 条关系</button></div></div><div class="pending-relation-list"><article v-for="relation in proposedConceptRelations.slice(0, 24)" :key="relation.id" class="pending-relation-row"><button class="pending-relation-link" type="button" @click="openConceptFromRelation(relation)"><strong>{{ conceptName(relation.parentConceptId) }} {{ relation.relationType === 'hierarchy' ? '→' : '↔' }} {{ conceptName(relation.childConceptId) }}</strong><small>{{ relationSourceLabel(relation.source) }} · {{ new Date(relation.updatedAt).toLocaleString('zh-CN') }}</small></button><div class="maintenance-relation-actions"><button class="text-button" type="button" @click="confirmConceptRelation(relation.id, 'confirmed')"><Check :size="13" />确认</button><button class="text-button" type="button" @click="confirmConceptRelation(relation.id, 'rejected')"><X :size="13" />拒绝</button></div></article></div><p v-if="proposedConceptRelations.length > 24" class="pending-relation-more">还有 {{ proposedConceptRelations.length - 24 }} 条，请从知识主题详情继续审核。</p></section><div class="task-layout"><div class="task-list surface-section"><div class="task-list-heading"><div><strong>任务队列</strong><span>正常结果自动落图，异常结果需要检查</span></div><button class="icon-button" title="刷新任务" aria-label="刷新任务" @click="store.refreshFromDb"><RefreshCw :size="16" /></button></div><div v-for="(group, groupIndex) in [taskGroups.active, taskGroups.review, taskGroups.completed]" :key="`task-group-${groupIndex}`" class="task-group"><button v-for="task in taskGroupSlice(group)" :key="task.id" class="task-row" :class="{ selected: selectedTaskId === task.id }" @click="selectedTaskId = task.id"><div class="task-state" :class="`state-${taskTone(task.status, task.phase)}`"><LoaderCircle v-if="task.status === 'running'" class="spin" :size="15" /><Check v-else-if="task.status === 'success'" :size="15" /><CircleHelp v-else :size="15" /></div><div class="row-main"><strong>{{ taskTypeLabel(task.type) }}</strong><span>{{ task.scopeLabel || new Date(task.createdAt).toLocaleString('zh-CN') }} · {{ new Date(task.createdAt).toLocaleString('zh-CN') }}</span></div><span class="status-label" :class="`label-${taskTone(task.status, task.phase)}`">{{ taskStatusLabel(task.status, task.phase) }}</span><ChevronRight :size="15" /></button></div><div v-if="!store.tasks.length" class="empty-state compact"><ListChecks :size="28" /><strong>还没有任务</strong><span>导入 JSON 后，整理任务会出现在这里。</span></div><button v-if="taskGroups.completed.length > visibleCompletedTaskCount" class="text-button load-more-button" @click="visibleCompletedTaskCount += 30">加载更多历史任务（还有 {{ taskGroups.completed.length - visibleCompletedTaskCount }} 个）</button></div><div class="task-detail surface-section"><template v-if="selectedTask"><div class="detail-header"><div><span class="eyebrow">TASK DETAIL</span><h3>{{ taskTypeLabel(selectedTask.type) }}</h3><span class="detail-subtitle">{{ selectedTask.scopeLabel }}</span></div><span class="status-label" :class="`label-${taskTone(selectedTask.status, selectedTask.phase)}`">{{ taskStatusLabel(selectedTask.status, selectedTask.phase) }}</span></div><div class="task-meta-grid"><div><span>模式</span><strong>{{ selectedTask.mode === 'api' ? 'API' : 'Prompt 粘贴' }}</strong></div><div><span>Prompt 版本</span><strong>{{ selectedTask.promptVersion }}</strong></div><div><span>重试次数</span><strong>{{ selectedTask.retryCount }}</strong></div></div><div class="prompt-box"><div class="subsection-title"><strong>Prompt</strong><button class="text-button" @click="copyTaskPrompt(selectedTask)"><Clipboard :size="14" />复制</button></div><pre>{{ selectedTask.prompt }}</pre></div><div class="response-box"><label for="task-response">粘贴 LLM 返回结果</label><textarea id="task-response" :value="taskResponse(selectedTask)" placeholder="在网页端执行 Prompt 后，将完整响应粘贴到这里" @input="setTaskDraft(selectedTask!.id, ($event.target as HTMLTextAreaElement).value)" /><div class="response-actions"><button v-if="(selectedTask.mode === 'prompt_paste' && ['pending', 'needs_review'].includes(selectedTask.status)) || (selectedTask.mode === 'api' && (selectedTask.status === 'needs_review' || selectedTask.phase === 'awaiting_disclosure'))" class="button primary-button" @click="applyTask(selectedTask)"><Check :size="15" />校验并应用</button><button v-if="selectedTask.status === 'needs_review'" class="button secondary-button" @click="selectedTaskId = selectedTask.id"><RefreshCw :size="15" />生成修复 Prompt</button></div><div v-if="selectedTask.validationErrors" class="validation-errors"><strong>校验问题</strong><span v-for="(error, index) in JSON.parse(selectedTask.validationErrors)" :key="index">{{ error }}</span></div></div></template><div v-else class="empty-detail"><ListChecks :size="30" /><strong>选择一个任务</strong><span>查看 Prompt、原始响应和本地校验结果。</span></div></div></div></section>

        <section v-else-if="activeView === 'settings'" class="view-panel settings-view"><div class="page-toolbar"><div><span class="eyebrow">LOCAL CONFIGURATION</span><h2>设置</h2></div><button class="button secondary-button" @click="exportConfig"><Download :size="15" />导出配置文件</button></div><div class="settings-grid"><section class="surface-section settings-section"><div class="section-heading"><div><span class="eyebrow">LLM MODE</span><h3>选择任务模式</h3></div><Sparkles :size="18" /></div><p class="section-description">选择任务模式后才会启动 LLM 整理；原始数据始终先保存到本地。</p><div class="mode-cards"><button class="mode-card" :class="{ selected: store.config.llm.mode === 'api' }" @click="updateMode('api')"><div class="mode-icon blue"><Send :size="18" /></div><div><strong>API 模式</strong><span>通过 OpenAI 兼容端点直接执行任务</span></div><Check v-if="store.config.llm.mode === 'api'" :size="17" /></button><button class="mode-card" :class="{ selected: store.config.llm.mode === 'prompt_paste' }" @click="updateMode('prompt_paste')"><div class="mode-icon amber"><Clipboard :size="18" /></div><div><strong>Prompt 粘贴模式</strong><span>复制 Prompt 到网页端，再粘贴回复</span></div><Check v-if="store.config.llm.mode === 'prompt_paste'" :size="17" /></button></div><div class="mode-concurrency"><label for="api-concurrency">API 并发数<small>同时执行的 API 任务数量，{{ MIN_API_CONCURRENCY }}～{{ MAX_API_CONCURRENCY }}</small></label><input id="api-concurrency" v-model="concurrencyDraft" type="number" :min="MIN_API_CONCURRENCY" :max="MAX_API_CONCURRENCY" step="1" inputmode="numeric" @change="setConcurrency(Number(concurrencyDraft))" @keydown.enter.prevent="setConcurrency(Number(concurrencyDraft))" /></div></section><section class="surface-section settings-section"><div class="section-heading"><div><span class="eyebrow">PROVIDER</span><h3>模型连接</h3></div><Database :size="18" /></div><p class="section-description">配置 OpenAI 兼容端点。API Key 会按你的选择明文写入本机配置文件，能读取该文件的系统用户同样能看到；它只在明确启动 API 任务时发送。</p><div class="provider-list"><div v-for="provider in store.config.llm.providers" :key="provider.id" class="provider-row" :class="{ active: provider.id === store.config.llm.defaultProvider }"><label class="inline-toggle"><input type="radio" name="default-provider" :checked="provider.id === store.config.llm.defaultProvider" @change="setDefaultProvider(provider.id)" />默认</label><div class="row-main"><strong>{{ provider.name }}</strong><span>{{ provider.model || '未填写模型' }} · {{ provider.baseUrl || '未填写地址' }}</span></div><button class="icon-button" title="删除连接" :aria-label="`删除连接 ${provider.name}`" @click="removeProvider(provider.id)"><Trash2 :size="14" /></button></div><p v-if="!store.config.llm.providers.length" class="empty-inline">还没有保存的连接，在下方填写并保存。</p></div><div class="form-grid"><label>名称<input v-model="providerDraft.name" placeholder="例如 DeepSeek" /></label><label class="span-two">Base URL<input v-model="providerDraft.baseUrl" placeholder="https://api.deepseek.com/v1" /></label><label>模型<input v-model="providerDraft.model" placeholder="deepseek-chat" /></label><label>API Key<input v-model="providerDraft.apiKey" type="text" placeholder="sk-…" /></label></div><div class="settings-actions"><button class="button primary-button" @click="saveProvider"><Check :size="15" />保存连接</button><span class="form-hint">同一会话的整理任务始终按顺序执行。</span></div></section><section class="surface-section settings-section"><div class="section-heading"><div><span class="eyebrow">STORAGE</span><h3>本地数据</h3></div><Database :size="18" /></div><p class="section-description">业务数据与配置分开保存；备份和导出永远不包含 API Key。</p><div class="storage-grid"><div><span>业务数据库</span><strong class="storage-path">{{ storageInfo?.databasePath ?? 'nexus.db · 应用数据目录' }}</strong></div><div><span>配置文件</span><strong class="storage-path">{{ storageInfo?.configPath ?? 'config.yaml · 应用数据目录' }}</strong></div></div><div class="settings-actions"><button class="button secondary-button" @click="createDatabaseBackup"><Database :size="15" />创建数据库备份</button><button class="button secondary-button" @click="store.clearAllData(); notify('知识库已清空')"><Trash2 :size="15" />清空知识库</button></div><div class="path-editor"><label>自定义数据库位置<small>留空使用应用数据目录；切换前会自动备份当前数据库。</small><input v-model="databasePathDraft" placeholder="/home/you/nexus/nexus.db" /></label><button class="button secondary-button" @click="applyDatabasePath"><Check :size="15" />应用路径</button></div></section><section class="surface-section settings-section"><div class="section-heading"><div><span class="eyebrow">MOTION & ACCESSIBILITY</span><h3>界面偏好</h3></div><PanelRight :size="18" /></div><label class="toggle-row"><span><strong>减少动态效果</strong><small>遵循 prefers-reduced-motion，缩短图谱和面板动画</small></span><input :checked="store.config.ui.reducedMotion" type="checkbox" @change="store.updateConfig({ ui: { ...store.config.ui, reducedMotion: ($event.target as HTMLInputElement).checked } })" /></label><div class="font-settings"><label><span>界面字体</span><select :value="store.config.ui.fontFamily" @change="setFontFamily(($event.target as HTMLSelectElement).value)"><option v-for="option in fontFamilyOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select><small class="font-settings-status" aria-live="polite">{{ systemFontStatus }}</small></label><label><span>字号 <output>{{ store.config.ui.fontSize }}px</output></span><input :value="store.config.ui.fontSize" type="range" min="13" max="20" step="1" @input="setFontSize(Number(($event.target as HTMLInputElement).value))" /></label></div></section></div></section>
        <section v-if="activeView === 'tasks' && selectedTask?.type === 'maintenance'" class="surface-section maintenance-task-results" aria-labelledby="maintenance-task-reason-title"><div class="section-heading"><div><span class="eyebrow">MAINTENANCE RESULT</span><h3 id="maintenance-task-reason-title">全图知识维护</h3></div><div class="maintenance-task-heading-actions"><span v-if="selectedTask.status === 'success' && maintenanceOverallReason && !maintenanceSuggestions.length" class="status-label label-success">无建议变更</span><span v-else-if="maintenanceSuggestions.length" class="status-label label-warning">{{ maintenanceSuggestions.length }} 条建议</span><span v-else-if="selectedTask.phase === 'awaiting_disclosure'" class="status-label label-warning">等待继续披露</span><button class="button secondary-button maintenance-entry-button" :aria-expanded="maintenancePanelOpen" @click="openMaintenancePanel"><Sparkles :size="15" />打开维护面板</button></div></div><p v-if="maintenanceOverallReason" class="maintenance-overall-reason">{{ maintenanceOverallReason }}</p><p v-else class="maintenance-overall-reason">维护任务会从全部根主题开始扫描；打开面板可查看优先关注范围与建议。</p></section>
        <section v-if="activeView === 'settings'" class="surface-section token-budget-section"><div class="section-heading"><div><span class="eyebrow">CONTEXT WINDOW</span><h3>Token 预算</h3></div><SlidersHorizontal :size="18" /></div><p class="section-description">手动设置长会话分窗和新对话上下文校验使用的估算上限。修改后立即写回配置，新导入和新对话会使用新值。</p><div class="token-budget-control"><label for="token-budget">每个任务的 Token 预算<small>最小 {{ MIN_TOKEN_BUDGET.toLocaleString() }}；默认值仅用于首次启动或无效配置。</small></label><div class="token-budget-input"><input id="token-budget" v-model="tokenBudgetDraft" type="number" :min="MIN_TOKEN_BUDGET" step="1000" inputmode="numeric" @change="setTokenBudget" @keydown.enter.prevent="setTokenBudget" /><span>tokens</span></div></div><div class="token-budget-control"><label for="concept-limit">每次 Concept 上限<small>每个整理任务最多提取 {{ MIN_CONCEPT_LIMIT }}～{{ MAX_CONCEPT_LIMIT }} 个 Concept。</small></label><div class="token-budget-input"><input id="concept-limit" v-model="conceptLimitDraft" type="number" :min="MIN_CONCEPT_LIMIT" :max="MAX_CONCEPT_LIMIT" step="1" inputmode="numeric" @change="setConceptLimit" @keydown.enter.prevent="setConceptLimit" /><span>Concept</span></div></div></section>
        <section v-if="activeView === 'settings'" class="surface-section phrase-section"><div class="section-heading"><div><span class="eyebrow">QUICK PHRASES</span><h3>快捷短语</h3></div><MessageSquare :size="18" /></div><p class="section-description">使用 <code>$(topic)</code> 和 <code>$(context)</code> 插入当前主题与上下文。</p><div class="phrase-list"><div v-for="phrase in store.quickPhrases" :key="phrase.id" class="phrase-row"><span>{{ phrase.template }}</span><div v-if="!phrase.isBuiltin" class="phrase-actions"><button class="icon-button" title="编辑快捷短语" :aria-label="`编辑 ${phrase.template}`" @click="beginEditPhrase(phrase.id, phrase.template)"><Settings2 :size="14" /></button><button class="icon-button" title="删除快捷短语" :aria-label="`删除 ${phrase.template}`" @click="removePhrase(phrase.id)"><Trash2 :size="14" /></button></div><span v-else class="soft-tag">内置</span></div></div><div class="phrase-editor"><input v-model="customPhraseDraft" placeholder="例如：请比较 $(topic) 与 $(context)" @keyup.enter="editingPhraseId ? savePhraseEdit() : addCustomPhrase()" /><button class="button secondary-button" @click="editingPhraseId ? savePhraseEdit() : addCustomPhrase()"><Check :size="14" />{{ editingPhraseId ? '保存' : '添加' }}</button><button v-if="editingPhraseId" class="text-button" @click="editingPhraseId = null; customPhraseDraft = ''">取消</button></div></section>
      </section>
      <section v-if="activeView === 'settings'" class="surface-section stream-settings-section"><div class="section-heading"><div><span class="eyebrow">CONVERSATION OUTPUT</span><h3>对话输出</h3></div><Send :size="18" /></div><label class="toggle-row"><span><strong>流式传输对话</strong><small>API 模式下逐步显示回答；关闭时等待完整响应</small></span><input :checked="Boolean(store.config.llm.stream)" type="checkbox" @change="store.updateConfig({ llm: { ...store.config.llm, stream: ($event.target as HTMLInputElement).checked } })" /></label><div class="mode-concurrency"><label for="api-retries">失败重试次数<small>自动重试次数，{{ MIN_API_RETRIES }}～{{ MAX_API_RETRIES }}</small></label><input id="api-retries" v-model="retriesDraft" type="number" :min="MIN_API_RETRIES" :max="MAX_API_RETRIES" step="1" @change="setRetries(Number(retriesDraft))" @keydown.enter.prevent="setRetries(Number(retriesDraft))" /></div></section>
    </main>

    <section v-if="maintenancePanelOpen && maintenancePageHasContext" class="maintenance-panel surface-section" aria-label="全图知识维护">
      <div class="maintenance-panel-header">
        <div><span class="eyebrow">KNOWLEDGE MAINTENANCE</span><h3>全图知识维护</h3><span class="maintenance-scope-note">每次任务都会检查整个知识图谱；当前页面对象仅作为优先关注。</span></div>
        <div class="maintenance-panel-actions"><Sparkles :size="18" /><button class="icon-button" aria-label="关闭知识维护" title="关闭知识维护" @click="maintenancePanelOpen = false"><X :size="15" /></button></div>
      </div>
      <div class="maintenance-scope maintenance-global-scope">
        <div class="maintenance-scope-copy"><strong>扫描整个知识图谱</strong><span>从所有根主题开始，检查层级、关系、归属和阅读片段</span></div>
        <button class="button primary-button" @click="createGraphMaintenance"><Sparkles :size="14" />开始全图维护</button>
      </div>
      <div v-if="(activeView === 'concepts' || activeView === 'graph') && selectedConcept" class="maintenance-scope">
        <div class="maintenance-scope-copy"><strong>优先关注：{{ displayText(selectedConcept.name, '未命名知识主题') }}</strong><span>先检查这个主题及其证据，随后仍继续扫描全图</span></div>
        <button class="button primary-button" @click="createConceptMaintenance"><Sparkles :size="14" />生成维护建议</button>
      </div>
      <div v-if="activeView === 'sessions' && selectedSession" class="maintenance-scope">
        <div class="maintenance-scope-copy"><strong>优先关注：{{ displayText(selectedSession.title, '未命名会话') }}</strong><span>先检查当前会话证据，随后仍继续扫描全图</span></div>
        <button class="button primary-button" @click="createSessionMaintenance"><Sparkles :size="14" />生成维护建议</button>
      </div>
      <div v-if="activeView === 'graph' && store.selectedUnits.length" class="maintenance-scope">
        <div class="maintenance-scope-copy"><strong>优先关注：{{ store.selectedUnits.length }} 个已选阅读片段</strong><span>按当前上下文顺序先检查关联和标题摘要</span></div>
        <button class="button secondary-button" @click="createContextMaintenance"><Sparkles :size="14" />检查选中内容</button>
      </div>
      <div v-if="maintenanceSuggestions.length" class="maintenance-results">
        <div class="subsection-title"><strong>建议差异</strong><span>{{ maintenanceSuggestions.filter((item) => !item.applied).length }} 条待处理</span></div>
        <article v-for="(suggestion, index) in maintenanceSuggestions" :key="`${index}-${suggestion.type}`" class="maintenance-suggestion" :class="{ applied: suggestion.applied }">
          <div class="maintenance-suggestion-main"><div class="maintenance-suggestion-title"><span class="soft-tag">{{ maintenanceSuggestionLabel(suggestion.type) }}</span><strong>{{ maintenanceSuggestionSummary(suggestion) }}</strong></div><p>{{ suggestion.reason || '未提供理由' }}</p></div>
          <button v-if="!suggestion.applied" class="button secondary-button" @click="applyMaintenanceSuggestion(index)"><Check :size="14" />应用</button>
          <span v-else class="status-label label-success">已应用</span>
        </article>
      </div>
      <div v-if="selectedTask?.type === 'maintenance' && maintenanceOverallReason" class="maintenance-results">
        <div class="subsection-title"><strong>模型判断</strong></div>
        <p class="maintenance-overall-reason">{{ maintenanceOverallReason }}</p>
      </div>
      <div v-if="(activeView === 'concepts' || activeView === 'graph') && selectedConcept && selectedConceptRelations.length" class="maintenance-results">
        <div class="subsection-title"><strong>关系审核</strong><span>{{ selectedConceptRelations.filter((relation) => relation.status === 'proposed').length }} 条待确认</span></div>
        <article v-for="relation in selectedConceptRelations" :key="relation.id" class="maintenance-relation-row">
          <div><strong>{{ conceptName(relation.parentConceptId) }} {{ relation.relationType === 'hierarchy' ? '→' : '↔' }} {{ conceptName(relation.childConceptId) }}</strong><span>{{ relation.status === 'proposed' ? '待确认' : relation.status === 'confirmed' ? '已确认' : '已拒绝' }} · {{ relation.source === 'maintenance' ? '维护建议' : relation.source === 'manual' ? '手动建立' : '自动提取' }}</span></div>
          <div class="maintenance-relation-actions"><button v-if="relation.status === 'proposed'" class="text-button" @click="confirmConceptRelation(relation.id, 'confirmed')"><Check :size="13" />确认</button><button v-if="relation.status === 'proposed'" class="text-button" @click="confirmConceptRelation(relation.id, 'rejected')"><X :size="13" />拒绝</button><button class="icon-button" title="删除关系" aria-label="删除关系" @click="deleteConceptRelation(relation.id)"><Trash2 :size="14" /></button></div>
        </article>
      </div>
      <div v-if="activeView === 'settings' && store.operationLogs.length" class="maintenance-results">
        <div class="subsection-title"><strong>操作记录</strong><button class="text-button" :disabled="!store.operationLogs.some((item) => !item.undoneAt)" @click="undoLatestOperation"><RotateCcw :size="13" />撤销最近一次</button></div>
        <div class="operation-log-list"><div v-for="operation in store.operationLogs.slice(0, 8)" :key="operation.id" class="operation-log-row"><span>{{ operation.action }}</span><small>{{ new Date(operation.createdAt).toLocaleString('zh-CN') }}{{ operation.undoneAt ? ' · 已撤销' : '' }}</small></div></div>
      </div>
    </section>

    <aside v-if="isDetailOpen && (selectedConcept || selectedUnit || selectedMessage)" ref="detailDrawer" class="detail-drawer" :class="{ open: isDetailOpen }">
      <div class="drawer-header"><div><span class="eyebrow">DETAIL</span><h3>{{ displayText(selectedConcept?.name || selectedUnit?.title, '消息详情') }}</h3></div><div class="drawer-header-actions"><button v-if="selectedMessage" class="icon-button" aria-label="全屏查看消息" title="全屏查看消息" @click="openFullscreenMessage(selectedMessage.id)"><Maximize2 :size="17" /></button><button v-else-if="selectedUnit" class="icon-button" aria-label="全屏查看所属会话" title="全屏查看所属会话" @click="openFullscreenSession(selectedUnit.sessionId)"><Maximize2 :size="17" /></button><button class="icon-button" aria-label="关闭详情" title="关闭详情" @click="isDetailOpen = false"><X :size="17" /></button></div></div>
      <div v-if="selectedUnit" class="drawer-content"><div class="drawer-tags"><span class="soft-tag">阅读片段</span><span class="soft-tag">{{ displayText(sessionForUnit(selectedUnit)?.title, '未知会话') }}</span></div><label class="field-label" for="unit-title">标题 <small>≤30 字</small></label><input id="unit-title" v-model="unitDraftTitle" class="drawer-input" maxlength="30" /><label class="field-label" for="unit-summary">摘要 <small>≤120 字</small></label><textarea id="unit-summary" v-model="unitDraftSummary" class="drawer-textarea" maxlength="120" /><button class="button primary-button full-button" @click="saveUnit"><Check :size="15" />保存片段</button><div class="drawer-section"><div class="subsection-title"><strong>关联知识主题</strong><span>{{ store.unitConceptNames(selectedUnit.id).length }}</span></div><div class="chip-list"><button v-for="conceptId in store.unitConcepts.filter((link) => link.unitId === selectedUnit?.id).map((link) => link.conceptId)" :key="conceptId" class="concept-chip" @click="openConcept(conceptId)">{{ displayText(store.concepts.find((concept) => concept.id === conceptId)?.name, '未知知识主题') }}<X :size="12" @click.stop="removeConceptFromUnit(selectedUnit!.id, conceptId)" /></button><span v-if="!store.unitConceptNames(selectedUnit.id).length" class="muted">暂无关联</span></div><div class="add-inline"><SearchSelect v-model="newUnitConcept" :options="store.activeConcepts.filter((concept) => !store.unitConcepts.some((link) => link.unitId === selectedUnit?.id && link.conceptId === concept.id)).map((concept) => ({ value: concept.id, label: concept.name, hint: concept.summary }))" placeholder="搜索现有知识主题" aria-label="选择要关联的知识主题" /><button class="icon-button" :disabled="!newUnitConcept" aria-label="添加知识主题" title="添加知识主题" @click="addConceptToSelectedUnit"><Plus :size="15" /></button></div></div><div class="drawer-section"><div class="subsection-title"><strong>包含消息</strong><span>{{ store.unitMessages(selectedUnit.id).length }}</span></div><div class="message-stack"><article v-for="message in store.unitMessages(selectedUnit.id)" :key="message.id" class="message-card" :class="message.role"><span>{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI' : '系统' }}</span><div class="md-body" v-html="renderedMessageContent(message.content, message)" @click="handleRenderedClick" @keydown.enter.prevent="handleRenderedClick" /></article></div></div><button class="text-button" @click="selectedUnitId = null; setView('sessions')"><ArrowRight :size="14" />打开所属会话</button></div>
      <div v-else-if="selectedConcept" class="drawer-content concept-drawer-content">
        <div class="drawer-tags"><span class="soft-tag">知识主题</span><span class="soft-tag">{{ selectedConceptUnits.length }} 个阅读片段</span><span class="soft-tag">{{ selectedConceptMessages.length }} 条消息</span></div>
        <p v-if="selectedConceptHasProposedRelations" class="concept-proposed-note" role="status">
          这个主题有 {{ selectedConceptRelations.filter((relation) => relation.status === 'proposed').length }} 条待确认关系。它们可能来自历史导入、自动整理或维护建议，不代表当前有 API 请求；可在下方关系行用确认或拒绝按钮处理。
        </p>
        <section class="concept-editor" aria-labelledby="concept-editor-title">
          <div class="subsection-title"><strong id="concept-editor-title">主题信息</strong><span>本地可编辑</span></div>
          <label class="field-label" for="concept-name">名称 <small>唯一标识</small></label>
          <input id="concept-name" v-model="conceptDraftName" class="drawer-input" maxlength="120" autocomplete="off" />
          <label class="field-label" for="concept-summary">摘要 <small>≤120 字</small></label>
          <textarea id="concept-summary" v-model="conceptDraftSummary" class="drawer-textarea concept-summary" maxlength="120" placeholder="用一句话概括这个主题的范围和核心结论" />
          <label class="field-label" for="concept-notes">主题说明 / 笔记 <small>Concept.notes</small></label>
          <textarea id="concept-notes" v-model="conceptDraftNotes" class="drawer-textarea concept-notes" placeholder="记录这个主题的长期理解、边界和待核实问题" />
          <p class="field-hint">摘要用于目录和上下文导航；说明 / 笔记用于记录长期理解。</p>
          <div class="concept-editor-actions"><button class="button primary-button" @click="saveConcept"><Check :size="14" />保存主题</button><button class="button ghost-button" @click="resetConceptDraft">撤销修改</button></div>
        </section>
<div class="drawer-actions concept-drawer-actions"><button class="button danger-button" @click="archiveSelectedConcept"><Archive :size="14" />归档主题</button><SearchSelect v-model="mergeTargetId" :options="[{ value: '', label: '选择合并目标' }, ...store.activeConcepts.filter((item) => item.id !== selectedConcept?.id).map((concept) => ({ value: concept.id, label: concept.name, hint: concept.summary }))]" aria-label="合并到另一个知识主题" /><button class="button secondary-button" :disabled="!mergeTargetId" @click="mergeSelectedConcept"><GitBranch :size="14" />合并</button></div>
        <section class="drawer-section concept-relations-section">
          <div class="subsection-title"><strong>父主题</strong><span>{{ selectedConceptParents.length }} 个，可多选</span></div>
          <div class="concept-relation-list">
<div v-for="relation in selectedConceptParents" :key="relation.id" class="concept-relation-row"><div class="relation-copy"><button class="relation-link" @click="openConcept(otherConceptOf(relation, selectedConcept!.id))">{{ conceptName(otherConceptOf(relation, selectedConcept!.id)) }}</button><small class="relation-summary-text">{{ conceptSummary(otherConceptOf(relation, selectedConcept!.id)) }}</small></div><span class="status-label" :class="relation.status === 'confirmed' ? 'label-success' : relation.status === 'proposed' ? 'label-warning' : 'label-neutral'">{{ relationStatusLabel(relation.status) }}</span><button v-if="relation.status === 'proposed'" class="icon-button relation-confirm" title="确认父主题关系" aria-label="确认父主题关系" @click="confirmConceptRelation(relation.id, 'confirmed')"><Check :size="13" /></button><button v-if="relation.status === 'proposed'" class="icon-button relation-reject" title="拒绝父主题关系" aria-label="拒绝父主题关系" @click="confirmConceptRelation(relation.id, 'rejected')"><X :size="13" /></button><button class="icon-button relation-remove" title="移除父主题关系" aria-label="移除父主题关系" @click="deleteConceptRelation(relation.id)"><Trash2 :size="13" /></button></div>
            <div v-if="!selectedConceptParents.length" class="empty-inline">暂无父主题；当前主题是层级根节点。</div>
          </div>
          <label class="field-label relation-search-label" for="concept-parent-search">添加父主题</label><div class="relation-search"><Search :size="14" /><input id="concept-parent-search" v-model="conceptParentQuery" placeholder="输入名称实时查找" autocomplete="off" /></div>
          <div v-if="conceptParentQuery.trim() && conceptParentCandidates.length" class="relation-candidates" role="listbox" aria-label="父主题候选"><button v-for="candidate in conceptParentCandidates" :key="candidate.id" class="relation-candidate" @click="addConceptParent(candidate.id)"><Plus :size="13" /><span>{{ displayText(candidate.name, '未命名知识主题') }}</span><small>{{ linkedUnitCount(candidate.id) }} 个阅读片段</small></button></div><div v-else-if="conceptParentQuery.trim()" class="relation-candidate-empty">没有匹配的现有主题。</div>
        </section>
        <section class="drawer-section concept-relations-section">
          <div class="subsection-title"><strong>子主题</strong><span>{{ selectedConceptChildren.length }} 个，可多选</span></div>
          <div class="concept-relation-list">
<div v-for="relation in selectedConceptChildren" :key="relation.id" class="concept-relation-row"><div class="relation-copy"><button class="relation-link" @click="openConcept(otherConceptOf(relation, selectedConcept!.id))">{{ conceptName(otherConceptOf(relation, selectedConcept!.id)) }}</button><small class="relation-summary-text">{{ conceptSummary(otherConceptOf(relation, selectedConcept!.id)) }}</small></div><span class="status-label" :class="relation.status === 'confirmed' ? 'label-success' : relation.status === 'proposed' ? 'label-warning' : 'label-neutral'">{{ relationStatusLabel(relation.status) }}</span><button v-if="relation.status === 'proposed'" class="icon-button relation-confirm" title="确认子主题关系" aria-label="确认子主题关系" @click="confirmConceptRelation(relation.id, 'confirmed')"><Check :size="13" /></button><button v-if="relation.status === 'proposed'" class="icon-button relation-reject" title="拒绝子主题关系" aria-label="拒绝子主题关系" @click="confirmConceptRelation(relation.id, 'rejected')"><X :size="13" /></button><button class="icon-button relation-promote" title="解除当前父子引用并提升一级" aria-label="提升子主题一级" @click="promoteSelectedChild(relation.id)"><ArrowUp :size="14" /></button></div>
            <div v-if="!selectedConceptChildren.length" class="empty-inline">暂无子主题。</div>
          </div>
          <label class="field-label relation-search-label" for="concept-child-search">添加子主题</label><div class="relation-search"><Search :size="14" /><input id="concept-child-search" v-model="conceptChildQuery" placeholder="输入名称实时查找" autocomplete="off" @keyup.enter="createAndAddConceptChild" /></div>
          <div v-if="conceptChildQuery.trim() && conceptChildCandidates.length" class="relation-candidates" role="listbox" aria-label="子主题候选"><button v-for="candidate in conceptChildCandidates" :key="candidate.id" class="relation-candidate" @click="addConceptChild(candidate.id)"><Plus :size="13" /><span>{{ displayText(candidate.name, '未命名知识主题') }}</span><small>{{ linkedUnitCount(candidate.id) }} 个阅读片段</small></button></div><div v-else-if="conceptChildQuery.trim()" class="relation-candidate-empty"><span>没有匹配的现有主题。</span><button class="text-button" @click="createAndAddConceptChild"><Plus :size="13" />创建并添加“{{ displayText(conceptChildQuery.trim()) }}”</button></div>
        </section>
<section class="drawer-section"><div class="subsection-title"><strong>相关主题</strong><span>{{ selectedConceptRelated.length }} 个</span></div><div class="concept-relation-list"><div v-for="relation in selectedConceptRelated" :key="relation.id" class="concept-relation-row"><button class="relation-link" @click="openConcept(otherConceptOf(relation, selectedConcept!.id))"><Link2 :size="13" />{{ conceptName(otherConceptOf(relation, selectedConcept!.id)) }}</button><span class="status-label" :class="relation.derived ? 'label-neutral' : relation.status === 'confirmed' ? 'label-success' : relation.status === 'proposed' ? 'label-warning' : 'label-neutral'">{{ relation.derived ? `共同出现 · ${relation.sessionCount ?? 0} 个 Session` : relationStatusLabel(relation.status) }}</span><small v-if="relation.derived" class="relation-summary-text">{{ relation.messageCount ?? 0 }} 条消息</small><button v-if="!relation.derived && relation.status === 'proposed'" class="icon-button relation-confirm" title="确认相关主题关系" aria-label="确认相关主题关系" @click="confirmConceptRelation(relation.id, 'confirmed')"><Check :size="13" /></button><button v-if="!relation.derived && relation.status === 'proposed'" class="icon-button relation-reject" title="拒绝相关主题关系" aria-label="拒绝相关主题关系" @click="confirmConceptRelation(relation.id, 'rejected')"><X :size="13" /></button><button v-if="!relation.derived" class="icon-button relation-remove" title="删除维护相关关系" aria-label="删除维护相关关系" @click="deleteConceptRelation(relation.id)"><Trash2 :size="13" /></button></div><div v-if="!selectedConceptRelated.length" class="empty-inline">暂无共同出现或维护确认的相关主题。</div></div></section>
        <section class="drawer-section"><div class="subsection-title"><strong>关联会话</strong><span>{{ selectedConceptSessions.length }} 个</span></div><button v-for="session in selectedConceptSessions.slice(0, 8)" :key="session.id" class="mini-unit-row" @click="openFullscreenSession(session.id)"><History :size="14" /><span>{{ displayText(session.title, '未命名会话') }}</span><Maximize2 :size="14" /></button><div v-if="selectedConceptSessions.length > 8" class="empty-inline">还有 {{ selectedConceptSessions.length - 8 }} 个会话，使用列表继续查看。</div><div v-if="!selectedConceptSessions.length" class="empty-inline">暂无关联会话。</div></section>
        <section class="drawer-section"><div class="subsection-title"><strong>关联阅读片段</strong><span>{{ selectedConceptUnits.length }} 个</span></div><button v-for="unit in selectedConceptUnits.slice(0, 12)" :key="unit.id" class="mini-unit-row" @click="openUnit(unit.id)"><BookOpen :size="14" /><span>{{ displayText(unit.title, '未命名阅读片段') }}</span><ChevronRight :size="14" /></button><div v-if="selectedConceptUnits.length > 12" class="empty-inline">还有 {{ selectedConceptUnits.length - 12 }} 个阅读片段，可在主题目录中继续查看。</div><div v-if="!selectedConceptUnits.length" class="empty-inline">没有单独整理的阅读片段。</div></section>
        <section class="drawer-section"><div class="subsection-title"><strong>包含消息</strong><span>{{ selectedConceptMessages.length }} 条</span></div><button v-if="selectedConceptMessages.length" class="button secondary-button full-button" @click="openFullscreenConcept(selectedConcept!.id)"><Maximize2 :size="14" />全屏查看全部对话</button><div v-for="message in selectedConceptMessages.slice(0, 12)" :key="message.id" class="mini-unit-row"><MessageSquare :size="14" /><span>{{ displayText(message.content, '空消息').slice(0, 54) }}</span><span class="muted">{{ displayText(store.sessions.find((session) => session.id === message.sessionId)?.title, '未知会话') }}</span></div><div v-if="selectedConceptMessages.length > 12" class="empty-inline">还有 {{ selectedConceptMessages.length - 12 }} 条消息，使用上方入口查看全部。</div><div v-if="!selectedConceptMessages.length" class="empty-inline">暂无已归属消息。</div></section>
        <button class="button primary-button full-button" @click="openComposer({ topicId: selectedConcept?.id ?? null, sourceUnitIds: selectedConceptUnits.map((unit) => unit.id) })"><MessageSquare :size="15" />从此知识主题开始新对话</button>
      </div>
      <div v-else-if="selectedMessage" class="drawer-content"><div class="drawer-tags"><span class="soft-tag">{{ selectedMessage.role }}</span><span class="soft-tag">消息 #{{ selectedMessage.orderInSession + 1 }}</span></div><div class="message-context-actions"><button class="button secondary-button" @click="toggleMessageContext(selectedMessage.id)"><Check v-if="store.selectedContextMessageIds.includes(selectedMessage.id)" :size="14" /><Plus v-else :size="14" />{{ store.selectedContextMessageIds.includes(selectedMessage.id) ? '已加入上下文' : '加入上下文' }}</button><button class="button secondary-button" @click="openFullscreenMessage(selectedMessage.id)"><Maximize2 :size="14" />全屏查看</button></div><div class="drawer-section message-membership-editor"><div class="subsection-title"><strong>消息归属</strong><span>可多选</span></div><div class="chip-list"><button v-for="link in store.messageConcepts.filter((item) => item.messageId === selectedMessage?.id)" :key="link.conceptId" class="concept-chip" @click="openConcept(link.conceptId)">{{ displayText(store.concepts.find((concept) => concept.id === link.conceptId)?.name, '未知知识主题') }}<X :size="12" @click.stop="removeConceptFromMessage(selectedMessage!.id, link.conceptId)" /></button><span v-if="!store.messageConcepts.some((item) => item.messageId === selectedMessage?.id)" class="muted">暂无直接主题归属</span></div><div class="add-inline"><SearchSelect v-model="newMessageConcept" :options="store.activeConcepts.filter((concept) => !store.messageConcepts.some((link) => link.messageId === selectedMessage?.id && link.conceptId === concept.id)).map((concept) => ({ value: concept.id, label: concept.name, hint: concept.summary }))" placeholder="搜索现有知识主题" aria-label="选择消息归属主题" /><button class="icon-button" :disabled="!newMessageConcept" aria-label="添加消息知识主题" title="添加消息知识主题" @click="addConceptToSelectedMessage"><Plus :size="15" /></button></div></div><div class="md-body message-detail-content" v-html="renderedMessageContent(selectedMessage.content, selectedMessage)" @click="handleRenderedClick" @keydown.enter.prevent="handleRenderedClick" /><button v-if="selectedMessage.unitId" class="text-button" @click="openUnit(selectedMessage.unitId)"><BookOpen :size="14" />打开所属阅读片段</button></div>
    </aside>

    <aside v-if="store.selectedUnits.length || store.selectedContextMessages.length" class="context-drawer" :class="{ 'with-detail-drawer': isDetailOpen && (selectedConcept || selectedUnit || selectedMessage) }"><div class="context-header"><div><span class="eyebrow">CONTEXT BUILDER</span><h3>已选上下文</h3></div><button class="icon-button" aria-label="清空上下文" title="清空上下文" @click="store.clearContext"><X :size="16" /></button></div><div class="context-count"><strong>{{ store.selectedUnits.length + store.selectedContextMessages.length }}</strong><span>个来源 · {{ store.selectedUnits.length }} 个阅读片段，{{ store.selectedContextMessages.length }} 条消息</span></div><div class="context-list"><div v-for="(unit, index) in store.selectedUnits" :key="unit.id" class="context-item" draggable="true" @dragstart="startContextDrag(unit.id)" @dragover.prevent @drop="dropContext(unit.id)"><span class="context-index">{{ index + 1 }}</span><div><strong>{{ displayText(unit.title, '未命名阅读片段') }}</strong><span>{{ displayText(sessionForUnit(unit)?.title, '未命名会话') }}</span></div><button class="icon-button" aria-label="移除上下文" title="移除上下文" @click="store.selectContext(unit.id, false)"><X :size="13" /></button></div><div v-for="(message, index) in store.selectedContextMessages" :key="message.id" class="context-item message-context-item"><span class="context-index">{{ store.selectedUnits.length + index + 1 }}</span><div><strong>{{ message.role === 'user' ? '你' : 'AI' }} · {{ message.content.slice(0, 48) || '空消息' }}</strong><span>消息 #{{ message.orderInSession + 1 }}</span></div><button class="icon-button" aria-label="移除消息上下文" title="移除消息上下文" @click="toggleMessageContext(message.id)"><X :size="13" /></button></div></div><label class="toggle-row context-toggle"><span><strong>附带完整原文</strong><small>默认只注入标题、摘要和知识主题；单独选择的消息始终附带</small></span><input v-model="contextIncludeFull" type="checkbox" /></label><div class="context-budget" :class="{ over: contextTokenEstimate > store.config.llm.tokenBudget }"><span>预计输入</span><strong>{{ contextTokenEstimate.toLocaleString() }} tokens</strong><small>预算 {{ store.config.llm.tokenBudget.toLocaleString() }} tokens{{ contextTokenEstimate > store.config.llm.tokenBudget ? ' · 已超出' : '' }}</small></div><button class="button primary-button full-button" @click="openContextComposer"><MessageSquare :size="15" />带入新对话页</button><button class="text-button full-button" @click="createContextPrompt"><Clipboard :size="14" />复制上下文文本</button><span class="context-hint">{{ contextIncludeFull ? '完整原文会增加输入长度，请确认模型预算。' : '摘要模式适合跨会话整理。' }}</span></aside>

    <div v-if="fullscreenTarget" class="fullscreen-backdrop" role="presentation" tabindex="-1" @click.self="closeFullscreen" @keydown.esc="closeFullscreen">
      <section class="fullscreen-viewer" role="dialog" aria-modal="true" aria-labelledby="fullscreen-title">
        <header class="fullscreen-viewer-header"><div><span class="eyebrow">{{ fullscreenTarget.kind === 'message' ? 'MESSAGE VIEWER' : fullscreenTarget.kind === 'concept' ? 'TOPIC CONVERSATIONS' : 'SESSION VIEWER' }}</span><h2 id="fullscreen-title">{{ fullscreenTitle }}</h2><span class="detail-subtitle">{{ fullscreenMessages.length }} 条消息 · 当前会话：{{ fullscreenPageSessionTitle }} · 第 {{ fullscreenPage + 1 }} / {{ fullscreenPageCount }} 页 · 本地内容</span></div><div class="fullscreen-viewer-actions"><button class="icon-button" aria-label="上一页" title="上一页" :disabled="fullscreenPage === 0" @click="changeFullscreenPage(-1)"><ArrowLeft :size="17" /></button><button class="icon-button" aria-label="下一页" title="下一页" :disabled="fullscreenPage >= fullscreenPageCount - 1" @click="changeFullscreenPage(1)"><ArrowRight :size="17" /></button><button class="icon-button" aria-label="关闭全屏查看" title="关闭" @click="closeFullscreen"><X :size="18" /></button></div></header>
        <div class="fullscreen-conversation">
          <article v-for="message in fullscreenPageMessages" :key="message.id" class="fullscreen-message" :class="message.role">
            <div class="fullscreen-message-header"><strong>{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI' : '系统' }}</strong><span>消息 #{{ message.orderInSession + 1 }}</span><span v-if="fullscreenTarget.kind === 'concept'" class="fullscreen-message-session" :title="displayText(store.sessions.find((session) => session.id === message.sessionId)?.title, '未知会话')">{{ displayText(store.sessions.find((session) => session.id === message.sessionId)?.title, '未知会话') }}</span><time v-if="message.timestamp">{{ new Date(message.timestamp).toLocaleString('zh-CN') }}</time><button class="button secondary-button message-context-button" @click="toggleMessageContext(message.id)"><Check v-if="store.selectedContextMessageIds.includes(message.id)" :size="13" /><Plus v-else :size="13" />{{ store.selectedContextMessageIds.includes(message.id) ? '已加入上下文' : '加入上下文' }}</button></div>
            <div class="md-body" v-html="renderedMessageContent(message.content, message)" @click="handleRenderedClick" @keydown.enter.prevent="handleRenderedClick" />
          </article>
          <div v-if="!fullscreenMessages.length" class="empty-state"><MessageSquare :size="30" /><strong>没有可显示的消息</strong><span>这条内容可能已被删除或尚未加载。</span></div>
        </div>
      </section>
    </div>

    <div v-if="composerOpen" class="modal-backdrop" role="presentation" @click.self="composerOpen = false">
      <section class="composer-modal" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <div class="modal-header"><div><span class="eyebrow">{{ composerFollowUp ? 'FOLLOW-UP' : 'NEW CONVERSATION' }}</span><h2 id="composer-title">{{ composerFollowUp ? `继续追问：${composerFollowUp.label}` : '发起新对话' }}</h2></div><button class="icon-button" aria-label="关闭新对话" title="关闭" @click="composerOpen = false"><X :size="17" /></button></div>
        <div class="composer-fields">
          <div class="composer-field topic-select-field"><span>围绕知识主题</span><SearchSelect v-model="composerTopicIds" multiple :options="[{ value: null, label: '不指定主题' }, ...store.activeConcepts.map((concept) => ({ value: concept.id, label: concept.name, hint: concept.summary }))]" aria-label="围绕知识主题" /></div>
          <label>快捷短语<select v-model="composerPhraseId" @change="applyComposerPhrase"><option value="">选择一个快捷短语</option><option v-for="phrase in store.quickPhrases" :key="phrase.id" :value="phrase.id">{{ phrase.template }}</option></select></label>
          <label class="composer-question">问题<textarea v-model="composerQuestion" rows="5" placeholder="输入你想继续探索的问题"></textarea></label>
          <label class="toggle-row"><span><strong>附带完整原文</strong><small>关闭时只发送标题、摘要和知识主题</small></span><input v-model="composerIncludeFull" type="checkbox" /></label>
        </div>
        <div class="composer-context"><div class="subsection-title"><strong>上下文来源</strong><span>{{ composerSourceUnitIds.length }} 个阅读片段 · {{ composerSourceMessageIds.length }} 条消息</span></div><div v-if="composerSourceUnitIds.length || composerSourceMessageIds.length" class="composer-context-list"><span v-for="unitId in composerSourceUnitIds" :key="unitId" class="soft-tag">{{ displayText(store.units.find((unit) => unit.id === unitId)?.title, '未命名阅读片段') }}</span><span v-for="messageId in composerSourceMessageIds" :key="messageId" class="soft-tag">消息 #{{ (store.messages.find((message) => message.id === messageId)?.orderInSession ?? 0) + 1 }}</span></div><p v-else class="muted">未选择上下文，将只使用问题和知识主题。</p><div class="context-budget" :class="{ over: composerTokenEstimate > store.config.llm.tokenBudget }"><span>预计输入</span><strong>{{ composerTokenEstimate.toLocaleString() }} tokens</strong><small>预算 {{ store.config.llm.tokenBudget.toLocaleString() }} tokens{{ composerTokenEstimate > store.config.llm.tokenBudget ? ' · 请减少上下文' : '' }}</small></div></div>
        <div class="modal-actions"><button class="button secondary-button" @click="composerOpen = false">取消</button><button class="button primary-button" @click="submitComposer"><MessageSquare :size="15" />{{ composerFollowUp ? '创建追问' : '创建并进入任务中心' }}</button></div>
      </section>
    </div>

    <div v-if="promptTask" class="prompt-workflow-backdrop" role="presentation" @click.self="closePromptTask" @keydown.esc="closePromptTask">
      <section class="prompt-workflow-panel" role="dialog" aria-modal="true" aria-labelledby="prompt-workflow-title">
        <header class="prompt-workflow-header"><div><span class="eyebrow">PROMPT HANDOFF</span><h2 id="prompt-workflow-title">把这次提问交给网页端</h2><span>{{ promptTask.scopeLabel || 'Prompt 粘贴任务' }}</span></div><button class="icon-button" aria-label="关闭 Prompt 浮层" title="关闭" @click="closePromptTask"><X :size="18" /></button></header>
        <div class="prompt-workflow-body"><p class="prompt-workflow-help">复制下面的 Prompt 到已登录的 AI 网页端，完成后把完整回复粘贴回来。关闭窗口不会丢失任务。</p><div class="prompt-workflow-block"><div class="subsection-title"><strong>Prompt</strong><button class="text-button" @click="copyTaskPrompt(promptTask)"><Clipboard :size="14" />复制</button></div><pre>{{ promptTask.prompt }}</pre></div><label class="prompt-workflow-response">网页端返回结果<textarea :value="taskResponse(promptTask)" rows="10" placeholder="粘贴完整 JSON 回复；如果网页端报错，也可以把错误文本粘贴进来" @input="setTaskDraft(promptTask!.id, ($event.target as HTMLTextAreaElement).value)" /></label><div v-if="taskFeedback" class="prompt-workflow-error" role="alert"><CircleHelp :size="15" /><span>{{ taskFeedback.text }}</span></div></div>
        <footer class="prompt-workflow-footer"><button class="button secondary-button" @click="closePromptTask">稍后处理</button><button class="button primary-button" @click="applyPromptTask"><Check :size="15" />校验并继续对话</button></footer>
      </section>
    </div>

    <div v-if="helpOpen" class="modal-backdrop" role="presentation" @click.self="helpOpen = false">
      <section class="composer-modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <div class="modal-header"><div><span class="eyebrow">GUIDE</span><h2 id="help-title">使用指南</h2></div><button class="icon-button" aria-label="关闭使用指南" title="关闭" @click="helpOpen = false"><X :size="17" /></button></div>
        <ol class="help-steps">
          <li><strong>导入对话</strong><span>把浏览器扩展导出的 JSON 拖入窗口，或点击“导入 JSON”。原始消息会先完整保存在本机。</span></li>
          <li><strong>自动整理</strong><span>在任务中心选择 API 或 Prompt 粘贴模式后启动整理；会话分类、知识主题和关系会逐步生成，异常结果可以人工修正后应用。</span></li>
          <li><strong>探索知识</strong><span>在知识图谱中点击知识主题展开子主题，也可以用顶部搜索直达主题、阅读片段或具体消息。</span></li>
          <li><strong>继续追问</strong><span>多选阅读片段组成上下文，或从知识主题、导航树发起新对话；回答会更新会话摘要和主题归属，并挂到当前探索分支。</span></li>
        </ol>
        <p class="help-note">所有业务数据默认只保存在本机数据库；应用不发送遥测，也不会在你确认之前发起网络请求。Prompt 粘贴模式完全离线工作。</p>
      </section>
    </div>

    <div v-if="toast" class="toast" role="status"><Check :size="15" />{{ toast }}</div>
  </div>
</template>
