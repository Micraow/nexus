<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { dump } from 'js-yaml'
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
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
  Menu,
  Network,
  PanelRight,
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
import { useWorkspaceStore } from '@/stores/workspace'
import type { Concept, GraphNodeType, KnowledgeUnit, LLMTask, Session } from '@/types/domain'

type ViewName = 'overview' | 'graph' | 'sessions' | 'concepts' | 'tasks' | 'settings'

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
const graphShowUnits = ref(false)
const graphShowMessages = ref(false)
const graphShowProposed = ref(false)
const graphSearch = ref('')
const unitDraftTitle = ref('')
const unitDraftSummary = ref('')
const newUnitConcept = ref('')
const relationParentId = ref('')
const relationChildId = ref('')
const relationType = ref<'hierarchy' | 'related'>('hierarchy')
const mergeTargetId = ref('')
const taskDrafts = ref<Record<string, string>>({})
const expandedSessionIds = ref<string[]>([])
const contextIncludeFull = ref(false)
const providerDraft = ref({ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' })
const graphLayoutNonce = ref(0)

const navItems: Array<{ id: ViewName; label: string; icon: typeof LayoutDashboard; badge?: () => number }> = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'graph', label: '知识图谱', icon: Network },
  { id: 'sessions', label: '会话', icon: History },
  { id: 'concepts', label: 'Concept', icon: Layers3 },
  { id: 'tasks', label: '任务中心', icon: ListChecks, badge: () => store.pendingTaskCount },
  { id: 'settings', label: '设置', icon: Settings2 },
]

const viewTitle = computed(() => navItems.find((item) => item.id === activeView.value)?.label ?? '概览')
const currentGraph = computed(() => {
  const snapshot = store.getGraph({ showUnits: graphShowUnits.value, showMessages: graphShowMessages.value, showProposed: graphShowProposed.value, expandedConceptIds: selectedConceptId.value ? [selectedConceptId.value] : [] })
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
const selectedUnit = computed(() => store.units.find((unit) => unit.id === selectedUnitId.value) ?? null)
const selectedMessage = computed(() => store.messages.find((message) => message.id === selectedMessageId.value) ?? null)
const selectedTask = computed(() => store.tasks.find((task) => task.id === selectedTaskId.value) ?? null)
const selectedSession = computed(() => store.sessions.find((session) => session.id === store.selectedSessionId) ?? null)
const selectedConceptUnits = computed(() => selectedConcept.value ? store.units.filter((unit) => store.unitConcepts.some((link) => link.unitId === unit.id && link.conceptId === selectedConcept.value?.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [])
const selectedConceptParents = computed(() => selectedConcept.value ? store.relations.filter((relation) => relation.childConceptId === selectedConcept.value?.id && relation.relationType === 'hierarchy') : [])
const selectedConceptChildren = computed(() => selectedConcept.value ? store.relations.filter((relation) => relation.parentConceptId === selectedConcept.value?.id && relation.relationType === 'hierarchy') : [])
const selectedConceptRelated = computed(() => selectedConcept.value ? store.relations.filter((relation) => (relation.parentConceptId === selectedConcept.value?.id || relation.childConceptId === selectedConcept.value?.id) && relation.relationType === 'related') : [])
const sessionUnits = computed(() => selectedSession.value ? store.units.filter((unit) => unit.sessionId === selectedSession.value?.id).sort((a, b) => a.orderInSession - b.orderInSession) : [])
const sessionMessages = computed(() => selectedSession.value ? store.messages.filter((message) => message.sessionId === selectedSession.value?.id).sort((a, b) => a.orderInSession - b.orderInSession) : [])
const taskGroups = computed(() => ({
  active: store.tasks.filter((task) => ['pending', 'running'].includes(task.status)),
  review: store.tasks.filter((task) => task.status === 'needs_review'),
  completed: store.tasks.filter((task) => ['success', 'failed', 'stale', 'cancelled'].includes(task.status)),
}))

function notify(message: string): void {
  toast.value = message
  window.setTimeout(() => { if (toast.value === message) toast.value = null }, 3200)
}

function setView(view: ViewName): void {
  activeView.value = view
  if (view === 'graph') nextTick(() => window.dispatchEvent(new Event('resize')))
}

function openConcept(conceptId: string): void {
  selectedConceptId.value = conceptId
  selectedUnitId.value = null
  selectedMessageId.value = null
  isDetailOpen.value = true
  if (activeView.value !== 'graph' && activeView.value !== 'concepts') setView('graph')
}

function openUnit(unitId: string, additive = false): void {
  selectedUnitId.value = unitId
  selectedMessageId.value = null
  if (!additive) store.selectContext(unitId, true)
  else store.selectContext(unitId, !store.selectedContextIds.includes(unitId))
  isDetailOpen.value = true
}

function openMessage(messageId: string): void {
  selectedMessageId.value = messageId
  selectedUnitId.value = store.messages.find((message) => message.id === messageId)?.unitId ?? null
  isDetailOpen.value = true
}

function selectSession(sessionId: string): void {
  store.setSelectedSession(sessionId)
  activeView.value = 'sessions'
  selectedUnitId.value = null
  selectedConceptId.value = null
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
    notify('KnowledgeUnit 已保存')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'KnowledgeUnit 保存失败')
  }
}

function addConceptToSelectedUnit(): void {
  if (!selectedUnit.value || !newUnitConcept.value.trim()) return
  try {
    store.addConceptToUnit(selectedUnit.value.id, newUnitConcept.value)
    newUnitConcept.value = ''
    notify('Concept 关联已添加')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Concept 关联失败')
  }
}

function removeConceptFromUnit(unitId: string, conceptId: string): void {
  store.setUnitConcept(unitId, conceptId, false)
  notify('Concept 关联已移除')
}

function createRelationFromForm(): void {
  if (!relationParentId.value || !relationChildId.value) return
  try {
    store.createRelation(relationParentId.value, relationChildId.value, relationType.value)
    relationParentId.value = ''
    relationChildId.value = ''
    notify('Concept 关系已建立')
  } catch (error) {
    notify(error instanceof Error ? error.message : '关系创建失败')
  }
}

function mergeSelectedConcept(): void {
  if (!selectedConcept.value || !mergeTargetId.value) return
  if (mergeTargetId.value === selectedConcept.value.id) return notify('请选择另一个目标 Concept')
  if (!window.confirm(`将“${selectedConcept.value.name}”合并到目标 Concept？此操作可以撤销。`)) return
  try {
    store.mergeConcept(selectedConcept.value.id, mergeTargetId.value)
    selectedConceptId.value = mergeTargetId.value
    mergeTargetId.value = ''
    notify('Concept 已合并')
  } catch (error) {
    notify(error instanceof Error ? error.message : '合并失败')
  }
}

function archiveSelectedConcept(): void {
  if (!selectedConcept.value) return
  if (!window.confirm(`归档“${selectedConcept.value.name}”？历史内容不会删除。`)) return
  store.deleteConcept(selectedConcept.value.id)
  selectedConceptId.value = null
  notify('Concept 已归档')
}

function copyText(value: string, message = '已复制到剪贴板'): void {
  navigator.clipboard?.writeText(value).then(() => notify(message)).catch(() => notify('复制失败，请手动选择文本'))
}

function buildContextPrompt(): string {
  const blocks = store.selectedUnits.map((unit, index) => {
    const session = store.sessions.find((item) => item.id === unit.sessionId)
    const messages = contextIncludeFull.value ? store.unitMessages(unit.id).map((message) => `${message.role}: ${message.content}`).join('\n') : ''
    return `## ${index + 1}. ${unit.title || '未命名知识单元'}\n来源：${session?.title ?? '未知 Session'}\nConcept：${store.unitConceptNames(unit.id).join('、') || '暂无'}\n摘要：${unit.summary || '暂无摘要'}${messages ? `\n原文：\n${messages}` : ''}`
  })
  return `以下是我选择的知识上下文，请基于这些内容继续回答：\n\n${blocks.join('\n\n')}`
}

function createContextPrompt(): void {
  if (!store.selectedUnits.length) return notify('请先选择至少一个 KnowledgeUnit')
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
    importFeedback.value = { tone: 'success', text: `已导入 ${report.importedSessionIds.length} 个 Session，生成 ${report.taskIds.length} 个待处理任务。` }
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
    importFeedback.value = { tone: 'success', text: mode === 'skip' ? '已保留变化会话，未覆盖本地内容。' : `已处理 ${report.importedSessionIds.length} 个会话，任务已进入队列。` }
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
      importFeedback.value = { tone: 'success', text: `已导入 ${report.importedSessionIds.length} 个 Session，任务已进入队列。` }
      setView('tasks')
    } catch (error) {
      importFeedback.value = { tone: 'error', text: error instanceof Error ? error.message : '导入失败' }
    }
  })
}

function taskStatusLabel(status: LLMTask['status']): string {
  return ({ pending: '待处理', running: '处理中', success: '已完成', failed: '失败', needs_review: '需要检查', stale: '已过期', cancelled: '已取消' } as Record<string, string>)[status]
}

function taskTone(status: LLMTask['status']): string {
  if (status === 'success') return 'success'
  if (status === 'failed' || status === 'stale') return 'danger'
  if (status === 'needs_review') return 'warning'
  if (status === 'running') return 'active'
  return 'neutral'
}

function taskTypeLabel(type: LLMTask['type']): string {
  return ({ segmentation: '对话分段', concept_extraction: 'Concept 提取', title: '标题生成', summary: '摘要生成', origin_concepts: '起源 Concept', conversation: '对话', maintenance: '维护建议' } as Record<string, string>)[type]
}

function taskResponse(task: LLMTask): string {
  return taskDrafts.value[task.id] ?? task.response ?? ''
}

function setTaskDraft(taskId: string, value: string): void {
  taskDrafts.value[taskId] = value
}

function applyTask(task: LLMTask): void {
  const response = taskResponse(task)
  if (!response.trim()) return notify('请先粘贴 LLM 返回结果')
  const result = store.applyTaskResult(task.id, response)
  if (result.ok) {
    notify(task.type === 'segmentation' ? '分段结果已校验并写入知识库' : '结构化结果已校验并写入知识库')
    selectedTaskId.value = null
  } else notify(result.errors[0] ?? '校验失败，请修正后重试')
}

async function executeApiTask(task: LLMTask): Promise<void> {
  const result = await store.executeTask(task.id)
  if (result.ok) notify('API 任务已完成')
  else notify(result.error ?? 'API 任务失败')
}

function retryTask(task: LLMTask): void {
  store.retryTask(task.id)
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

function downloadText(filename: string, content: string, type = 'text/plain'): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function exportConfig(): void {
  downloadText('nexus-config.yaml', dump(store.config), 'text/yaml;charset=utf-8')
  notify('配置 YAML 已导出')
}

function exportSnapshot(): void {
  const payload = { export_version: 1, exported_at: new Date().toISOString(), graph: currentGraph.value, concepts: store.concepts, units: store.units }
  downloadText('nexus-graph-snapshot.json', JSON.stringify(payload, null, 2), 'application/json')
  notify('图谱快照已导出')
}

function exportKnowledgeBase(): void {
  downloadText('nexus-knowledge-base.json', store.exportKnowledgeBase(), 'application/json')
  notify('完整知识库 JSON 已导出')
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
  const lines = [`# ${concept.name}`, '', `状态：${concept.status}`, '', '## 别名', ...(conceptAliases.length ? conceptAliases.map((alias) => `- ${alias.alias}`) : ['- 暂无']), '', '## 笔记', concept.notes || '暂无', '', '## 关联 KnowledgeUnit', ...(conceptUnits.length ? conceptUnits.map((unit) => `- ${unit.title || '待命名知识单元'}：${unit.summary || '暂无摘要'}`) : ['- 暂无']), '', '## 关系', ...(relations.length ? relations.map((relation) => `- ${relation.relationType}：${store.concepts.find((item) => item.id === (relation.parentConceptId === concept.id ? relation.childConceptId : relation.parentConceptId))?.name ?? '未知'}`) : ['- 暂无'])]
  downloadText(`${concept.name.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}.md`, lines.join('\n'), 'text/markdown;charset=utf-8')
  notify('Concept Markdown 已导出')
}

function exportSession(session: Session): void {
  const payload = { export_version: 1, exported_at: new Date().toISOString(), session, messages: store.messages.filter((message) => message.sessionId === session.id), units: store.units.filter((unit) => unit.sessionId === session.id), nav: store.navNodes.filter((node) => node.sessionId === session.id) }
  downloadText(`${session.title || 'session'}.json`, JSON.stringify(payload, null, 2), 'application/json')
  notify('Session JSON 已导出')
}

function saveProvider(): void {
  const providers = store.config.llm.providers.filter((provider) => provider.id !== providerDraft.value.id)
  store.updateConfig({ llm: { ...store.config.llm, providers: [...providers, { ...providerDraft.value }], defaultProvider: providerDraft.value.id } })
  notify('Provider 配置已保存')
}

function updateMode(mode: 'api' | 'prompt_paste' | null): void {
  store.updateConfig({ llm: { ...store.config.llm, mode } })
  notify(mode ? `已切换到 ${mode === 'api' ? 'API 模式' : 'Prompt 粘贴模式'}` : '请选择 LLM 模式')
}

function toggleSession(sessionId: string): void {
  expandedSessionIds.value = expandedSessionIds.value.includes(sessionId) ? expandedSessionIds.value.filter((id) => id !== sessionId) : [...expandedSessionIds.value, sessionId]
}

function sessionForUnit(unit: KnowledgeUnit): Session | undefined {
  return store.sessions.find((session) => session.id === unit.sessionId)
}

watch(selectedUnitId, (unitId) => {
  const unit = unitId ? store.units.find((item) => item.id === unitId) : null
  if (unit) {
    unitDraftTitle.value = unit.title ?? ''
    unitDraftSummary.value = unit.summary ?? ''
  }
})

watch(() => store.config.ui.theme, (theme) => {
  document.documentElement.dataset.theme = theme
}, { immediate: true })

onMounted(async () => {
  await store.init()
  if (!store.activeSessions.length) store.loadDemoData()
  if (!store.selectedSessionId && store.activeSessions[0]) store.setSelectedSession(store.activeSessions[0].id)
  const provider = store.config.llm.providers[0]
  if (provider) providerDraft.value = { ...provider }
})
</script>

<template>
  <div class="app-shell" @dragover.prevent @drop="handleDrop">
    <aside class="sidebar" :class="{ collapsed: isSidebarCollapsed }">
      <div class="brand-lockup">
        <div class="brand-mark"><Network :size="19" /></div>
        <div v-if="!isSidebarCollapsed" class="brand-copy"><strong>Nexus</strong><span>织知工作台</span></div>
      </div>
      <button class="collapse-button icon-button" :aria-label="isSidebarCollapsed ? '展开导航' : '收起导航'" :title="isSidebarCollapsed ? '展开导航' : '收起导航'" @click="isSidebarCollapsed = !isSidebarCollapsed">
        <Menu :size="18" />
      </button>
      <nav class="primary-nav" aria-label="主导航">
        <button v-for="item in navItems" :key="item.id" class="nav-item" :class="{ active: activeView === item.id }" :title="item.label" @click="setView(item.id)">
          <component :is="item.icon" :size="18" />
          <span v-if="!isSidebarCollapsed">{{ item.label }}</span>
          <b v-if="item.badge?.() && !isSidebarCollapsed" class="nav-badge">{{ item.badge?.() }}</b>
        </button>
      </nav>
      <div v-if="!isSidebarCollapsed" class="sidebar-footer">
        <div class="local-status"><span class="status-dot" />本地数据已保存</div>
        <div class="sidebar-meta">Windows · Linux 优先</div>
      </div>
    </aside>

    <main class="main-shell">
      <header class="topbar">
        <div class="topbar-title"><span class="eyebrow">NEXUS / {{ activeView === 'graph' ? 'KNOWLEDGE MAP' : 'WORKSPACE' }}</span><h1>{{ viewTitle }}</h1></div>
        <div class="topbar-actions">
          <div class="global-search" :class="{ expanded: showSearch }">
            <Search :size="17" />
            <input v-model="searchQuery" aria-label="搜索 Concept、KnowledgeUnit 或消息" placeholder="搜索 Concept、单元或消息" @focus="showSearch = true" />
            <button v-if="searchQuery" class="clear-search icon-button" aria-label="清空搜索" @click="searchQuery = ''"><X :size="14" /></button>
            <div v-if="showSearch && searchQuery" class="search-popover">
              <div v-if="store.search(searchQuery).concepts.length" class="search-group"><span class="search-group-title">Concept</span><button v-for="concept in store.search(searchQuery).concepts.slice(0, 5)" :key="concept.id" @click="openConcept(concept.id); showSearch = false"><Layers3 :size="14" />{{ concept.name }}</button></div>
              <div v-if="store.search(searchQuery).units.length" class="search-group"><span class="search-group-title">KnowledgeUnit</span><button v-for="unit in store.search(searchQuery).units.slice(0, 4)" :key="unit.id" @click="openUnit(unit.id); showSearch = false"><BookOpen :size="14" />{{ unit.title || '待命名知识单元' }}</button></div>
              <div v-if="store.search(searchQuery).messages.length" class="search-group"><span class="search-group-title">消息</span><button v-for="message in store.search(searchQuery).messages.slice(0, 4)" :key="message.id" @click="openMessage(message.id); showSearch = false"><History :size="14" />{{ message.content.slice(0, 42) }}</button></div>
              <div v-if="!Object.values(store.search(searchQuery)).some((items) => items.length)" class="empty-search">没有匹配结果</div>
            </div>
          </div>
          <button class="button secondary-button" @click="triggerImport"><Upload :size="16" />导入 JSON</button>
          <input ref="importInput" type="file" accept="application/json,.json" hidden @change="handleImport" />
          <button class="icon-button" title="导出完整知识库" aria-label="导出完整知识库" @click="exportKnowledgeBase"><Database :size="17" /></button>
          <button class="icon-button" title="恢复知识库备份" aria-label="恢复知识库备份" @click="triggerRestore"><FolderOpen :size="17" /></button>
          <input ref="restoreInput" type="file" accept="application/json,.json" hidden @change="handleRestore" />
          <button class="icon-button" title="帮助与规范" aria-label="帮助与规范"><CircleHelp :size="18" /></button>
        </div>
      </header>

      <section class="content-shell">
        <div v-if="importFeedback" class="feedback-banner" :class="`feedback-${importFeedback.tone}`"><Check v-if="importFeedback.tone === 'success'" :size="16" /><CircleHelp v-else :size="16" /><span>{{ importFeedback.text }}</span><div v-if="pendingImportRaw" class="feedback-actions"><button class="text-button" @click="resolveChangedImport('replace')">更新变化会话</button><button class="text-button" @click="resolveChangedImport('new')">作为新会话</button><button class="text-button" @click="resolveChangedImport('skip')">跳过</button></div><button class="icon-button" aria-label="关闭提示" @click="importFeedback = null; pendingImportRaw = null"><X :size="15" /></button></div>

        <section v-if="activeView === 'overview'" class="view-panel overview-view">
          <div class="hero-band">
            <div><span class="eyebrow accent">LOCAL-FIRST KNOWLEDGE WORKSPACE</span><h2>把散落的对话，织成可继续探索的知识。</h2><p>从 DeepSeek 历史记录开始，整理 Concept、KnowledgeUnit 与跨会话上下文。</p></div>
            <div class="hero-actions"><button class="button primary-button" @click="triggerImport"><Upload :size="16" />导入对话 JSON</button><button class="button ghost-button" @click="setView('graph')"><Network :size="16" />查看图谱</button></div>
          </div>

          <div class="metric-grid">
            <article class="metric-card"><div class="metric-icon blue"><History :size="18" /></div><span>会话</span><strong>{{ store.stats.sessions }}</strong><small>跨来源持续积累</small></article>
            <article class="metric-card"><div class="metric-icon teal"><BookOpen :size="18" /></div><span>KnowledgeUnit</span><strong>{{ store.stats.units }}</strong><small>具体讨论片段</small></article>
            <article class="metric-card"><div class="metric-icon amber"><Layers3 :size="18" /></div><span>Concept</span><strong>{{ store.stats.concepts }}</strong><small>可复用知识主体</small></article>
            <article class="metric-card"><div class="metric-icon violet"><ListChecks :size="18" /></div><span>待处理任务</span><strong>{{ store.stats.pendingTasks }}</strong><small>{{ store.config.llm.mode ? (store.config.llm.mode === 'api' ? 'API 模式' : 'Prompt 粘贴') : '尚未选择模式' }}</small></article>
          </div>

          <div class="overview-grid">
            <section class="surface-section import-section" @dragover.prevent @drop="handleDrop">
              <div class="section-heading"><div><span class="eyebrow">START HERE</span><h3>导入历史对话</h3></div><FolderOpen :size="19" /></div>
              <div class="dropzone"><div class="drop-icon"><ArrowDownToLine :size="22" /></div><strong>拖入 JSON 文件</strong><span>支持 DeepSeek 扩展导出的标准格式</span><button class="button secondary-button" @click="triggerImport"><Upload :size="15" />选择文件</button></div>
              <div class="import-note"><span class="status-dot" />原始 Session 和 Message 会先本地保存，LLM 整理由任务队列控制。</div>
            </section>
            <section class="surface-section"><div class="section-heading"><div><span class="eyebrow">RECENT SESSIONS</span><h3>最近会话</h3></div><button class="text-button" @click="setView('sessions')">查看全部 <ArrowRight :size="14" /></button></div><div class="recent-list"><button v-for="session in store.activeSessions.slice(0, 4)" :key="session.id" class="recent-row" @click="selectSession(session.id)"><div class="session-avatar"><History :size="15" /></div><div class="row-main"><strong>{{ session.title }}</strong><span>{{ session.platform }} · {{ session.messageCount }} 条消息 · {{ session.unitCount }} 个单元</span></div><ChevronRight :size="16" /></button></div></section>
          </div>
          <section class="surface-section insight-section"><div class="section-heading"><div><span class="eyebrow">WORKFLOW</span><h3>整理进度</h3></div><button class="text-button" @click="setView('tasks')">打开任务中心 <ArrowRight :size="14" /></button></div><div class="workflow-track"><div class="workflow-step done"><span>1</span><strong>原始数据</strong><small>本地落库</small></div><div class="workflow-line done" /><div class="workflow-step" :class="{ done: store.stats.units > 0 }"><span>2</span><strong>语义整理</strong><small>{{ store.stats.units ? '已有结果' : '等待 LLM 任务' }}</small></div><div class="workflow-line" :class="{ done: store.stats.units > 0 }" /><div class="workflow-step" :class="{ done: store.stats.concepts > 0 }"><span>3</span><strong>Concept 图谱</strong><small>{{ store.stats.concepts ? '可以探索' : '等待 Concept' }}</small></div><div class="workflow-line" :class="{ done: store.stats.concepts > 0 }" /><div class="workflow-step"><span>4</span><strong>继续追问</strong><small>从图谱开始</small></div></div></section>
        </section>

        <section v-else-if="activeView === 'graph'" class="view-panel graph-view">
          <div class="page-toolbar"><div><span class="eyebrow">GLOBAL GRAPH / REVISION {{ store.graphRevision }}</span><h2>Concept 关系网络</h2></div><div class="toolbar-actions"><div class="compact-search"><Search :size="15" /><input v-model="graphSearch" placeholder="过滤节点" aria-label="过滤图谱节点" /></div><button class="button secondary-button" @click="exportSnapshot"><Download :size="15" />导出快照</button><button class="icon-button" title="重置布局" aria-label="重置布局" @click="notify('布局将在下次打开图谱时重新计算')"><RotateCcw :size="17" /></button></div></div>
          <div class="graph-layout">
            <div class="graph-main"><GraphCanvas :key="graphLayoutNonce" :snapshot="currentGraph" :selected-unit-ids="store.selectedContextIds" :reduced-motion="store.config.ui.reducedMotion" @select-concept="openConcept" @select-unit="openUnit" @select-message="openMessage" /></div>
            <aside class="graph-controls surface-section"><div class="panel-heading"><div><span class="eyebrow">VIEW</span><h3>显示选项</h3></div><SlidersHorizontal :size="17" /></div><label class="toggle-row"><span><strong>KnowledgeUnit</strong><small>点击 Concept 时始终展开</small></span><input v-model="graphShowUnits" type="checkbox" /></label><label class="toggle-row"><span><strong>未归类 Message</strong><small>显示尚未整理的原始消息</small></span><input v-model="graphShowMessages" type="checkbox" /></label><label class="toggle-row"><span><strong>待确认关系</strong><small>以虚线呈现建议关系</small></span><input v-model="graphShowProposed" type="checkbox" /></label><div class="graph-mini-stats"><div><strong>{{ graphOverview.concepts }}</strong><span>Concept</span></div><div><strong>{{ graphOverview.units }}</strong><span>Unit</span></div><div><strong>{{ graphOverview.edges }}</strong><span>边</span></div></div><div class="graph-control-note"><GitBranch :size="15" /><span>父子关系会增加吸引力，子 Concept 倾向靠近父节点；拖拽只改变视图位置。</span></div></aside>
          </div>
        </section>

        <section v-else-if="activeView === 'sessions'" class="view-panel sessions-view"><div class="page-toolbar"><div><span class="eyebrow">SESSION ARCHIVE</span><h2>会话与探索树</h2></div><button class="button secondary-button" @click="triggerImport"><Upload :size="15" />导入更多</button></div><div class="session-list surface-section"><div v-for="session in store.activeSessions" :key="session.id" class="session-block"><button class="session-row" @click="toggleSession(session.id); selectSession(session.id)"><div class="session-avatar"><History :size="16" /></div><div class="row-main"><strong>{{ session.title }}</strong><span>{{ session.platform }} · {{ session.messageCount }} 条消息 · {{ session.unitCount }} 个 KnowledgeUnit</span></div><span v-if="session.localOnly" class="soft-tag">仅本地</span><ChevronDown v-if="expandedSessionIds.includes(session.id)" :size="17" /><ChevronRight v-else :size="17" /></button><div v-if="expandedSessionIds.includes(session.id)" class="session-expanded"><div class="session-meta-line"><span>创建于 {{ new Date(session.createdAt).toLocaleDateString('zh-CN') }}</span><label class="inline-toggle"><input type="checkbox" :checked="session.localOnly" @change="store.toggleSessionLocalOnly(session.id, ($event.target as HTMLInputElement).checked)" />仅本地 API 禁止</label><button class="text-button" @click.stop="exportSession(session)"><Download :size="14" />导出 Session</button></div><div class="unit-timeline"><button v-for="unit in store.units.filter((item) => item.sessionId === session.id)" :key="unit.id" class="timeline-unit" :class="{ selected: selectedUnitId === unit.id }" @click="openUnit(unit.id)"><span class="timeline-dot" /><div><strong>{{ unit.title || '待命名知识单元' }}</strong><span>{{ unit.summary || '等待摘要生成' }}</span><small>{{ store.unitConceptNames(unit.id).join(' · ') || '未关联 Concept' }}</small></div></button><div v-if="!store.units.some((unit) => unit.sessionId === session.id)" class="empty-inline">该 Session 还没有完成分段。</div></div></div></div></div></section>

        <section v-else-if="activeView === 'concepts'" class="view-panel concepts-view"><div class="page-toolbar"><div><span class="eyebrow">CONCEPT INDEX</span><h2>Concept 目录</h2></div><button class="button secondary-button" @click="setView('graph')"><Network :size="15" />在图谱中查看</button></div><div class="concepts-layout"><div class="concept-list surface-section"><div class="list-toolbar"><span>{{ store.activeConcepts.length }} 个 active Concept</span><div class="compact-search"><Search :size="14" /><input v-model="graphSearch" placeholder="过滤 Concept" /></div></div><button v-for="concept in store.activeConcepts.filter((item) => !graphSearch || item.name.toLocaleUpperCase().includes(graphSearch.toLocaleUpperCase()))" :key="concept.id" class="concept-list-row" :class="{ selected: selectedConceptId === concept.id }" @click="openConcept(concept.id)"><span class="concept-swatch" /><div><strong>{{ concept.name }}</strong><span>{{ store.units.filter((unit) => store.unitConcepts.some((link) => link.unitId === unit.id && link.conceptId === concept.id)).length }} 个 KnowledgeUnit</span></div><ChevronRight :size="15" /></button></div><div class="concept-detail surface-section"><template v-if="selectedConcept"><div class="detail-header"><div><span class="eyebrow">CONCEPT DETAIL</span><h3>{{ selectedConcept.name }}</h3></div><button class="icon-button" title="归档 Concept" aria-label="归档 Concept" @click="archiveSelectedConcept"><Archive :size="16" /></button></div><div class="alias-row"><span>别名</span><span v-for="alias in store.aliases.filter((item) => item.conceptId === selectedConcept?.id)" :key="alias.id" class="soft-tag">{{ alias.alias }}</span><span v-if="!store.aliases.some((item) => item.conceptId === selectedConcept?.id)" class="muted">暂无别名</span></div><div class="note-box"><label>用户笔记</label><textarea :value="selectedConcept.notes" placeholder="记录这个 Concept 的长期理解" @change="(event) => { const value = (event.target as HTMLTextAreaElement).value; store.updateConceptNotes?.(selectedConcept!.id, value) }" /></div><div class="relation-summary"><div><span>父 Concept</span><strong>{{ selectedConceptParents.length }}</strong></div><div><span>子 Concept</span><strong>{{ selectedConceptChildren.length }}</strong></div><div><span>关联单元</span><strong>{{ selectedConceptUnits.length }}</strong></div></div><div class="detail-subsection"><div class="subsection-title"><strong>关联 KnowledgeUnit</strong><span>{{ selectedConceptUnits.length }}</span></div><button v-for="unit in selectedConceptUnits" :key="unit.id" class="mini-unit-row" @click="openUnit(unit.id)"><BookOpen :size="14" /><span>{{ unit.title || '待命名知识单元' }}</span><ChevronRight :size="14" /></button><div v-if="!selectedConceptUnits.length" class="empty-inline">还没有关联单元</div></div><div class="detail-subsection"><div class="subsection-title"><strong>维护关系</strong><span>手动确认</span></div><div class="relation-form"><select v-model="relationParentId" aria-label="父 Concept"><option value="">选择父 Concept</option><option v-for="concept in store.activeConcepts" :key="concept.id" :value="concept.id">{{ concept.name }}</option></select><select v-model="relationChildId" aria-label="子 Concept"><option value="">选择子 Concept</option><option v-for="concept in store.activeConcepts" :key="concept.id" :value="concept.id">{{ concept.name }}</option></select><select v-model="relationType" aria-label="关系类型"><option value="hierarchy">父子</option><option value="related">相关</option></select><button class="button secondary-button" @click="createRelationFromForm"><Link2 :size="14" />建立</button></div></div><div class="detail-subsection"><div class="subsection-title"><strong>合并到</strong><span>可撤销事务</span></div><div class="merge-form"><select v-model="mergeTargetId" aria-label="合并目标"><option value="">选择目标 Concept</option><option v-for="concept in store.activeConcepts.filter((item) => item.id !== selectedConcept?.id)" :key="concept.id" :value="concept.id">{{ concept.name }}</option></select><button class="button danger-button" @click="mergeSelectedConcept"><GitBranch :size="14" />合并</button></div></div></template><div v-else class="empty-detail"><Layers3 :size="30" /><strong>选择一个 Concept</strong><span>查看它关联的 KnowledgeUnit、层级关系和笔记。</span></div></div></div></section>

        <section v-else-if="activeView === 'tasks'" class="view-panel tasks-view"><div class="page-toolbar"><div><span class="eyebrow">LLM TASK QUEUE</span><h2>任务中心</h2></div><div class="task-toolbar-meta"><span class="soft-tag" :class="store.config.llm.mode ? 'tag-active' : 'tag-warning'">{{ store.config.llm.mode ? (store.config.llm.mode === 'api' ? 'API 模式' : 'Prompt 粘贴') : '未选择模式' }}</span><span>{{ store.tasks.length }} 个任务</span></div></div><div v-if="!store.config.llm.mode" class="mode-callout"><Sparkles :size="19" /><div><strong>先选择 LLM 模式</strong><span>原始数据可以继续浏览；选择 API 或 Prompt 粘贴后才能启动整理任务。</span></div><button class="button primary-button" @click="setView('settings')"><Settings2 :size="15" />去设置</button></div><div class="task-layout"><div class="task-list surface-section"><div class="task-list-heading"><div><strong>任务队列</strong><span>正常结果自动落图，异常结果需要检查</span></div><button class="icon-button" title="刷新任务" aria-label="刷新任务" @click="store.refreshFromDb"><RefreshCw :size="16" /></button></div><div v-for="group in [taskGroups.active, taskGroups.review, taskGroups.completed]" :key="group[0]?.status || 'empty'" class="task-group"><button v-for="task in group" :key="task.id" class="task-row" :class="{ selected: selectedTaskId === task.id }" @click="selectedTaskId = task.id"><div class="task-state" :class="`state-${taskTone(task.status)}`"><LoaderCircle v-if="task.status === 'running'" class="spin" :size="15" /><Check v-else-if="task.status === 'success'" :size="15" /><CircleHelp v-else :size="15" /></div><div class="row-main"><strong>{{ taskTypeLabel(task.type) }}</strong><span>{{ task.scopeLabel || task.id }} · {{ new Date(task.createdAt).toLocaleString('zh-CN') }}</span></div><span class="status-label" :class="`label-${taskTone(task.status)}`">{{ taskStatusLabel(task.status) }}</span><ChevronRight :size="15" /></button></div><div v-if="!store.tasks.length" class="empty-state compact"><ListChecks :size="28" /><strong>还没有任务</strong><span>导入 JSON 后，整理任务会出现在这里。</span></div></div><div class="task-detail surface-section"><template v-if="selectedTask"><div class="detail-header"><div><span class="eyebrow">TASK DETAIL</span><h3>{{ taskTypeLabel(selectedTask.type) }}</h3><span class="detail-subtitle">{{ selectedTask.scopeLabel }}</span></div><span class="status-label" :class="`label-${taskTone(selectedTask.status)}`">{{ taskStatusLabel(selectedTask.status) }}</span></div><div class="task-meta-grid"><div><span>模式</span><strong>{{ selectedTask.mode === 'api' ? 'API' : 'Prompt 粘贴' }}</strong></div><div><span>Prompt 版本</span><strong>{{ selectedTask.promptVersion }}</strong></div><div><span>重试次数</span><strong>{{ selectedTask.retryCount }}</strong></div></div><div class="prompt-box"><div class="subsection-title"><strong>Prompt</strong><button class="text-button" @click="copyTaskPrompt(selectedTask)"><Clipboard :size="14" />复制</button></div><pre>{{ selectedTask.prompt }}</pre></div><div class="response-box"><label for="task-response">粘贴 LLM 返回结果</label><textarea id="task-response" :value="taskResponse(selectedTask)" placeholder="在网页端执行 Prompt 后，将完整响应粘贴到这里" @input="setTaskDraft(selectedTask!.id, ($event.target as HTMLTextAreaElement).value)" /><div class="response-actions"><button class="button primary-button" @click="applyTask(selectedTask)"><Check :size="15" />校验并应用</button><button v-if="selectedTask.status === 'needs_review'" class="button secondary-button" @click="selectedTaskId = selectedTask.id"><RefreshCw :size="15" />生成修复 Prompt</button></div><div v-if="selectedTask.validationErrors" class="validation-errors"><strong>校验问题</strong><span v-for="(error, index) in JSON.parse(selectedTask.validationErrors)" :key="index">{{ error }}</span></div></div></template><div v-else class="empty-detail"><ListChecks :size="30" /><strong>选择一个任务</strong><span>查看 Prompt、原始响应和本地校验结果。</span></div></div></div></section>

        <section v-else-if="activeView === 'settings'" class="view-panel settings-view"><div class="page-toolbar"><div><span class="eyebrow">LOCAL CONFIGURATION</span><h2>设置</h2></div><button class="button secondary-button" @click="exportConfig"><Download :size="15" />导出 config.yaml</button></div><div class="settings-grid"><section class="surface-section settings-section"><div class="section-heading"><div><span class="eyebrow">LLM MODE</span><h3>选择任务模式</h3></div><Sparkles :size="18" /></div><p class="section-description">首次启动不预设模式。选择后才会启动 LLM 整理；原始数据始终先保存到本地。</p><div class="mode-cards"><button class="mode-card" :class="{ selected: store.config.llm.mode === 'api' }" @click="updateMode('api')"><div class="mode-icon blue"><Send :size="18" /></div><div><strong>API 模式</strong><span>通过 OpenAI 兼容端点直接执行任务</span></div><Check v-if="store.config.llm.mode === 'api'" :size="17" /></button><button class="mode-card" :class="{ selected: store.config.llm.mode === 'prompt_paste' }" @click="updateMode('prompt_paste')"><div class="mode-icon amber"><Clipboard :size="18" /></div><div><strong>Prompt 粘贴模式</strong><span>复制 Prompt 到网页端，再粘贴回复</span></div><Check v-if="store.config.llm.mode === 'prompt_paste'" :size="17" /></button></div></section><section class="surface-section settings-section"><div class="section-heading"><div><span class="eyebrow">PROVIDER</span><h3>OpenAI 兼容连接</h3></div><Database :size="18" /></div><p class="section-description">API Key 按你的配置以明文写入 YAML；只在明确启动 API 任务时发送。</p><div class="form-grid"><label>名称<input v-model="providerDraft.name" /></label><label>Provider ID<input v-model="providerDraft.id" /></label><label class="span-two">Base URL<input v-model="providerDraft.baseUrl" /></label><label>模型<input v-model="providerDraft.model" /></label><label>API Key<input v-model="providerDraft.apiKey" type="text" /></label></div><div class="settings-actions"><button class="button primary-button" @click="saveProvider"><Check :size="15" />保存 Provider</button><span class="form-hint">并发数默认 2，可在配置文件中调整为 1～4。</span></div></section><section class="surface-section settings-section"><div class="section-heading"><div><span class="eyebrow">STORAGE</span><h3>本地数据</h3></div><Database :size="18" /></div><div class="storage-grid"><div><span>数据库</span><strong>nexus.db · 本地浏览器存储原型</strong></div><div><span>图谱 revision</span><strong>{{ store.graphRevision }}</strong></div><div><span>配置</span><strong>config.yaml（导出）</strong></div></div><div class="settings-actions"><button class="button secondary-button" @click="notify('Tauri 文件系统接入将在桌面壳层启用')"><FolderOpen :size="15" />选择数据库路径</button><button class="button secondary-button" @click="store.clearAllData(); notify('本地演示数据已清空')"><Trash2 :size="15" />清空原型数据</button></div></section><section class="surface-section settings-section"><div class="section-heading"><div><span class="eyebrow">MOTION & ACCESSIBILITY</span><h3>界面偏好</h3></div><PanelRight :size="18" /></div><label class="toggle-row"><span><strong>减少动态效果</strong><small>遵循 prefers-reduced-motion，缩短图谱和面板动画</small></span><input :checked="store.config.ui.reducedMotion" type="checkbox" @change="store.updateConfig({ ui: { ...store.config.ui, reducedMotion: ($event.target as HTMLInputElement).checked } })" /></label></section></div></section>
      </section>
    </main>

    <aside v-if="isDetailOpen && (selectedConcept || selectedUnit || selectedMessage)" class="detail-drawer" :class="{ open: isDetailOpen }">
      <div class="drawer-header"><div><span class="eyebrow">DETAIL</span><h3>{{ selectedConcept?.name || selectedUnit?.title || '消息详情' }}</h3></div><button class="icon-button" aria-label="关闭详情" title="关闭详情" @click="isDetailOpen = false"><X :size="17" /></button></div>
      <div v-if="selectedUnit" class="drawer-content"><div class="drawer-tags"><span class="soft-tag">KnowledgeUnit</span><span class="soft-tag">{{ sessionForUnit(selectedUnit)?.title }}</span></div><label class="field-label" for="unit-title">标题 <small>≤30 字</small></label><input id="unit-title" v-model="unitDraftTitle" class="drawer-input" maxlength="30" /><label class="field-label" for="unit-summary">摘要 <small>≤120 字</small></label><textarea id="unit-summary" v-model="unitDraftSummary" class="drawer-textarea" maxlength="120" /><button class="button primary-button full-button" @click="saveUnit"><Check :size="15" />保存单元</button><div class="drawer-section"><div class="subsection-title"><strong>关联 Concept</strong><span>{{ store.unitConceptNames(selectedUnit.id).length }}</span></div><div class="chip-list"><button v-for="conceptId in store.unitConcepts.filter((link) => link.unitId === selectedUnit?.id).map((link) => link.conceptId)" :key="conceptId" class="concept-chip" @click="openConcept(conceptId)">{{ store.concepts.find((concept) => concept.id === conceptId)?.name }}<X :size="12" @click.stop="removeConceptFromUnit(selectedUnit!.id, conceptId)" /></button><span v-if="!store.unitConceptNames(selectedUnit.id).length" class="muted">暂无关联</span></div><div class="add-inline"><input v-model="newUnitConcept" placeholder="添加 Concept" @keyup.enter="addConceptToSelectedUnit" /><button class="icon-button" aria-label="添加 Concept" title="添加 Concept" @click="addConceptToSelectedUnit"><Plus :size="15" /></button></div></div><div class="drawer-section"><div class="subsection-title"><strong>包含消息</strong><span>{{ store.unitMessages(selectedUnit.id).length }}</span></div><div class="message-stack"><article v-for="message in store.unitMessages(selectedUnit.id)" :key="message.id" class="message-card" :class="message.role"><span>{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI' : '系统' }}</span><p>{{ message.content }}</p></article></div></div><button class="text-button" @click="selectedUnitId = null; setView('sessions')"><ArrowRight :size="14" />打开所属 Session</button></div>
      <div v-else-if="selectedConcept" class="drawer-content"><div class="drawer-tags"><span class="soft-tag">Concept</span><span class="soft-tag">{{ selectedConceptUnits.length }} 个 KnowledgeUnit</span></div><div class="drawer-section"><div class="subsection-title"><strong>层级关系</strong></div><div class="relation-list"><span v-for="relation in [...selectedConceptParents, ...selectedConceptChildren]" :key="relation.id" class="relation-pill"><GitBranch :size="13" />{{ store.concepts.find((concept) => concept.id === (relation.childConceptId === selectedConcept!.id ? relation.parentConceptId : relation.childConceptId))?.name }}</span><span v-if="!selectedConceptParents.length && !selectedConceptChildren.length" class="muted">暂无已确认层级</span></div></div><div class="drawer-section"><div class="subsection-title"><strong>关联单元</strong></div><button v-for="unit in selectedConceptUnits.slice(0, 8)" :key="unit.id" class="mini-unit-row" @click="openUnit(unit.id)"><BookOpen :size="14" /><span>{{ unit.title || '待命名知识单元' }}</span><ChevronRight :size="14" /></button></div><button class="button primary-button full-button" @click="copyText(`请围绕 Concept「${selectedConcept!.name}」继续讨论。已有知识：${selectedConceptUnits.map((unit) => unit.summary).filter(Boolean).join('；')}`, 'Concept 上下文已复制')"><Send :size="15" />从此 Concept 开始新对话</button></div>
      <div v-else-if="selectedMessage" class="drawer-content"><div class="drawer-tags"><span class="soft-tag">{{ selectedMessage.role }}</span><span class="soft-tag">消息 #{{ selectedMessage.orderInSession + 1 }}</span></div><p class="message-detail-content">{{ selectedMessage.content }}</p><button v-if="selectedMessage.unitId" class="text-button" @click="openUnit(selectedMessage.unitId)"><BookOpen :size="14" />打开所属 KnowledgeUnit</button></div>
    </aside>

    <aside v-if="store.selectedUnits.length" class="context-drawer"><div class="context-header"><div><span class="eyebrow">CONTEXT BUILDER</span><h3>已选上下文</h3></div><button class="icon-button" aria-label="清空上下文" title="清空上下文" @click="store.clearContext"><X :size="16" /></button></div><div class="context-count"><strong>{{ store.selectedUnits.length }}</strong><span>个 KnowledgeUnit · 可跨 Session</span></div><div class="context-list"><div v-for="(unit, index) in store.selectedUnits" :key="unit.id" class="context-item"><span class="context-index">{{ index + 1 }}</span><div><strong>{{ unit.title || '待命名知识单元' }}</strong><span>{{ sessionForUnit(unit)?.title }}</span></div><button class="icon-button" aria-label="移除上下文" @click="store.selectContext(unit.id, false)"><X :size="13" /></button></div></div><label class="toggle-row context-toggle"><span><strong>附带完整原文</strong><small>默认只注入标题、摘要和 Concept</small></span><input v-model="contextIncludeFull" type="checkbox" /></label><button class="button primary-button full-button" @click="createContextPrompt"><Clipboard :size="15" />复制上下文 Prompt</button><span class="context-hint">{{ contextIncludeFull ? '已选择完整消息，发起前请确认长度。' : '摘要模式更适合控制上下文长度。' }}</span></aside>

    <div v-if="toast" class="toast" role="status"><Check :size="15" />{{ toast }}</div>
  </div>
</template>
