import { buildExportPayload, exportPayloadDataUrl, type ExportSessionState } from './export-payload'
import type { ListProgress, SessionEntry, WorkbenchRequest, WorkbenchResponse } from './types'

type SessionState = ExportSessionState

const state = {
  sourceTabId: null as number | null,
  sessions: new Map<string, SessionState>(),
  selected: new Set<string>(),
  paused: false,
  loadingAll: false,
  running: false,
  filter: '',
}

const elements = {
  sourceStatus: document.querySelector<HTMLSpanElement>('#source-status'),
  openSource: document.querySelector<HTMLButtonElement>('#open-source'),
  refreshList: document.querySelector<HTMLButtonElement>('#refresh-list'),
  loadAll: document.querySelector<HTMLButtonElement>('#load-all'),
  currentSession: document.querySelector<HTMLButtonElement>('#export-current'),
  search: document.querySelector<HTMLInputElement>('#session-search'),
  selectAll: document.querySelector<HTMLInputElement>('#select-all'),
  sessionList: document.querySelector<HTMLDivElement>('#session-list'),
  progressBar: document.querySelector<HTMLDivElement>('#progress-bar span'),
  progressText: document.querySelector<HTMLSpanElement>('#progress-text'),
  countSuccess: document.querySelector<HTMLElement>('#count-success'),
  countFailed: document.querySelector<HTMLElement>('#count-failed'),
  countPending: document.querySelector<HTMLElement>('#count-pending'),
  pause: document.querySelector<HTMLButtonElement>('#pause-queue'),
  resume: document.querySelector<HTMLButtonElement>('#resume-queue'),
  retryFailed: document.querySelector<HTMLButtonElement>('#retry-failed'),
  download: document.querySelector<HTMLButtonElement>('#download-json'),
  errorList: document.querySelector<HTMLDivElement>('#error-list'),
}

function notify(text: string, tone: 'info' | 'error' = 'info'): void {
  const banner = document.querySelector<HTMLDivElement>('#notice')
  if (!banner) return
  banner.textContent = text
  banner.dataset.tone = tone
  banner.hidden = false
  window.setTimeout(() => {
    if (banner.textContent === text) banner.hidden = true
  }, 5000)
}

async function findSourceTab(): Promise<boolean> {
  const tabs = await chrome.tabs.query({ url: ['https://chat.deepseek.com/*'] })
  state.sourceTabId = tabs[0]?.id ?? null
  if (elements.sourceStatus) {
    if (state.sourceTabId == null) {
      elements.sourceStatus.textContent = '未找到 DeepSeek 标签页，请先登录并打开 chat.deepseek.com'
      elements.sourceStatus.dataset.tone = 'error'
    } else {
      elements.sourceStatus.textContent = '已连接 DeepSeek 标签页'
      elements.sourceStatus.dataset.tone = 'ok'
    }
  }
  return state.sourceTabId != null
}

async function sendToSource(message: WorkbenchRequest): Promise<WorkbenchResponse> {
  if (state.sourceTabId == null && !(await findSourceTab())) return { ok: false, error: '未找到 DeepSeek 标签页' }
  try {
    return await chrome.tabs.sendMessage(state.sourceTabId as number, message) as WorkbenchResponse
  } catch {
    state.sourceTabId = null
    return { ok: false, error: '无法与 DeepSeek 页面通信：请刷新 DeepSeek 标签页后重试' }
  }
}

function mergeSessions(list: SessionEntry[] | undefined): number {
  ;(list ?? []).forEach((entry) => {
    if (!entry.externalSessionId) return
    const existing = state.sessions.get(entry.externalSessionId)
    if (existing) {
      if (entry.title && entry.title !== existing.entry.title) existing.entry.title = entry.title
      return
    }
    state.sessions.set(entry.externalSessionId, { entry, status: 'pending' })
  })
  return state.sessions.size
}

function render(): void {
  if (!elements.sessionList) return
  const filter = state.filter.trim().toLowerCase()
  const rows = [...state.sessions.values()]
    .filter((item) => !filter || item.entry.title.toLowerCase().includes(filter) || item.entry.externalSessionId.toLowerCase().includes(filter))
    .sort((left, right) => left.entry.title.localeCompare(right.entry.title, 'zh-CN'))
  elements.sessionList.replaceChildren(...rows.map((item) => buildRow(item)))
  if (elements.selectAll) {
    elements.selectAll.checked = state.selected.size > 0 && state.selected.size === state.sessions.size
    elements.selectAll.indeterminate = state.selected.size > 0 && state.selected.size < state.sessions.size
  }
  const counts = { success: 0, failed: 0, pending: 0 }
  let finished = 0
  const selectedItems = [...state.selected].map((id) => state.sessions.get(id)).filter(Boolean) as SessionState[]
  selectedItems.forEach((item) => {
    if (item.status === 'success') counts.success += 1
    if (item.status === 'failed') counts.failed += 1
    if (item.status === 'pending') counts.pending += 1
    if (item.status === 'success' || item.status === 'failed') finished += 1
  })
  const total = Math.max(1, selectedItems.length)
  if (elements.progressBar) elements.progressBar.style.width = `${Math.round((finished / total) * 100)}%`
  if (elements.progressText) elements.progressText.textContent = state.selected.size ? `已处理 ${finished} / ${total} 个选中会话` : '尚未选择会话'
  if (elements.countSuccess) elements.countSuccess.textContent = String(counts.success)
  if (elements.countFailed) elements.countFailed.textContent = String(counts.failed)
  if (elements.countPending) elements.countPending.textContent = String([...state.selected].filter((id) => state.sessions.get(id)?.status === 'pending').length)
  if (elements.download) elements.download.disabled = state.selected.size === 0 || (counts.success === 0 && counts.failed === 0)
  renderErrors()
}

function buildRow(item: SessionState): HTMLElement {
  const row = document.createElement('label')
  row.className = 'session-row'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = state.selected.has(item.entry.externalSessionId)
  checkbox.disabled = item.status === 'running'
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selected.add(item.entry.externalSessionId)
    else state.selected.delete(item.entry.externalSessionId)
    render()
  })
  const title = document.createElement('span')
  title.className = 'session-title'
  title.textContent = item.entry.title || `会话 ${item.entry.externalSessionId.slice(0, 10)}`
  const id = document.createElement('code')
  id.className = 'session-id'
  id.textContent = item.entry.externalSessionId.slice(0, 12)
  const tag = document.createElement('span')
  tag.className = `status-tag status-${item.status}`
  tag.textContent = ({ pending: '待导出', running: '读取中', success: '成功', failed: '失败' })[item.status]
  if (item.error) tag.title = item.error
  row.append(checkbox, title, id, tag)
  return row
}

function renderErrors(): void {
  if (!elements.errorList) return
  const failures = [...state.sessions.values()].filter((item) => item.status === 'failed')
  elements.errorList.replaceChildren(...failures.map((item) => {
    const line = document.createElement('div')
    line.className = 'error-row'
    const label = document.createElement('strong')
    label.textContent = item.entry.title || item.entry.externalSessionId
    const reason = document.createElement('span')
    reason.textContent = item.error ?? '未知原因'
    line.append(label, reason)
    return line
  }))
  elements.errorList.hidden = failures.length === 0
}

async function refreshList(): Promise<void> {
  if (!(await findSourceTab())) return
  const response = await sendToSource({ type: 'LIST_VISIBLE' })
  if (!response.ok) return notify(response.error, 'error')
  if (response.kind === 'list') mergeSessions(response.sessions)
  render()
  notify(`已发现 ${state.sessions.size} 个侧边栏会话`)
}

async function loadAllHistory(): Promise<void> {
  if (state.loadingAll) return
  if (!(await findSourceTab())) return
  const workbenchTab = await chrome.tabs.getCurrent()
  state.loadingAll = true
  if (elements.loadAll) elements.loadAll.disabled = true
  try {
    // DeepSeek only fetches the next session page while its virtual list is active.
    if (state.sourceTabId != null) {
      await chrome.tabs.update(state.sourceTabId, { active: true })
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    }
    const reset = await sendToSource({ type: 'LIST_RESET' })
    if (!reset.ok) throw new Error(reset.error)
    if (reset.kind === 'list') mergeSessions(reset.sessions)
    for (let step = 0; step < 240; step += 1) {
      if (state.paused || state.sourceTabId == null) break
      const response = await sendToSource({ type: 'LIST_SCROLL_STEP' })
      if (!response.ok) throw new Error(response.error)
      let progress: ListProgress = { discovered: state.sessions.size, reachedEnd: step >= 59, attempts: step }
      if (response.kind === 'list') {
        mergeSessions(response.sessions)
        if (response.progress) progress = response.progress
      }
      render()
      notify(`正在滚动加载历史：已发现 ${progress.discovered} 个`)
      if (progress.reachedEnd) break
    }
    notify(`历史加载完成，共 ${state.sessions.size} 个会话；可勾选后批量导出。`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '懒加载失败', 'error')
  } finally {
    state.loadingAll = false
    if (elements.loadAll) elements.loadAll.disabled = false
    if (workbenchTab?.id != null) await chrome.tabs.update(workbenchTab.id, { active: true })
    render()
  }
}

async function exportCurrent(): Promise<void> {
  const response = await sendToSource({ type: 'CURRENT_SESSION_ID' })
  if (!response.ok) return notify(response.error, 'error')
  const currentId = response.kind === 'current' ? response.currentSessionId : null
  if (!currentId) return notify('当前没有打开的会话', 'error')
  const existing = state.sessions.get(currentId)
  if (!existing) state.sessions.set(currentId, { entry: { externalSessionId: currentId, title: `当前会话 ${currentId.slice(0, 8)}` }, status: 'pending' })
  state.selected.add(currentId)
  render()
  void runQueue()
}

async function exportOne(id: string): Promise<void> {
  const item = state.sessions.get(id)
  if (!item) return
  item.status = 'running'
  item.error = undefined
  render()
  const response = await sendToSource({ type: 'EXPORT_SESSION', externalSessionId: id })
  if (response.ok && response.kind === 'conversation' && response.conversation) {
    item.status = 'success'
    item.conversation = response.conversation
    if (response.conversation.title) item.entry.title = response.conversation.title
  } else {
    item.status = 'failed'
    item.error = response.ok ? '返回内容为空' : response.error
  }
  render()
}

async function runQueue(): Promise<void> {
  if (state.running) return
  state.running = true
  try {
    for (;;) {
      if (state.paused) break
      const nextId = [...state.selected].find((id) => state.sessions.get(id)?.status === 'pending')
      if (!nextId) break
      await exportOne(nextId)
    }
  } finally {
    state.running = false
    render()
  }
}

function pauseQueue(): void {
  state.paused = true
  notify('将在当前会话读取完成后暂停')
}

function resumeQueue(): void {
  state.paused = false
  void runQueue()
}

function retryFailed(): void {
  let retried = 0
  state.sessions.forEach((item) => {
    if (item.status !== 'failed') return
    item.status = 'pending'
    item.error = undefined
    state.selected.add(item.entry.externalSessionId)
    retried += 1
  })
  if (!retried) return notify('没有失败的会话需要重试')
  render()
  void runQueue()
}

function downloadJson(): void {
  const payload = buildExportPayload(state.selected, state.sessions)
  if (!payload.conversations.length && !payload.errors.length) {
    notify('请先选择并读取至少一个会话。', 'error')
    return
  }
  const filename = `deepseek-export-${new Date().toISOString().slice(0, 10)}.json`
  const content = JSON.stringify(payload, null, 2)
  const url = exportPayloadDataUrl(content)
  const fallbackDownload = (): void => {
    const blobUrl = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = blobUrl
    anchor.download = filename
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000)
  }
  try {
    chrome.downloads.download({ url, filename, saveAs: true, conflictAction: 'uniquify' }, (downloadId) => {
    if (chrome.runtime.lastError || downloadId == null) {
      fallbackDownload()
      notify(`浏览器下载接口未接受请求，已切换为页面下载：${chrome.runtime.lastError?.message ?? '未知错误'}`, 'error')
      return
    }
    notify(`已导出 ${payload.conversations.length} 个会话${payload.errors.length ? `，另有 ${payload.errors.length} 个失败项写入 errors` : ''}`)
    })
  } catch (error) {
    fallbackDownload()
    notify(`下载接口不可用，已切换为页面下载：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

elements.refreshList?.addEventListener('click', () => void refreshList())
elements.loadAll?.addEventListener('click', () => void loadAllHistory())
elements.currentSession?.addEventListener('click', () => void exportCurrent())
elements.openSource?.addEventListener('click', () => void chrome.tabs.create({ url: 'https://chat.deepseek.com/' }))
elements.pause?.addEventListener('click', pauseQueue)
elements.resume?.addEventListener('click', resumeQueue)
elements.retryFailed?.addEventListener('click', retryFailed)
elements.download?.addEventListener('click', downloadJson)
elements.search?.addEventListener('input', () => {
  state.filter = elements.search?.value ?? ''
  render()
})
elements.selectAll?.addEventListener('change', () => {
  const checked = elements.selectAll?.checked ?? false
  state.sessions.forEach((item, id) => {
    if (checked) state.selected.add(id)
    else state.selected.delete(id)
  })
  render()
})

void findSourceTab().then(() => {
  if (state.sourceTabId != null) void refreshList()
})
render()
