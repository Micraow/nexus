import type { ExportedConversation, ExportedMessage, ListProgress, SessionEntry, WorkbenchRequest } from './types'

interface CapturedMessage {
  role?: unknown
  sender?: unknown
  content?: unknown
  insert_time?: unknown
  created_at?: unknown
}

const SESSION_HREF_PATTERN = /\/a\/chat\/s\/([A-Za-z0-9_-]+)/
const CAPTURE_EVENT = 'nexus:captured-json'
const NOISE_TEXTS = new Set(['复制', '重新生成', '编辑', '删除', '继续生成'])

/** session id -> normalized messages captured from network responses. */
const captureCache = new Map<string, ExportedMessage[]>()
let lastScrollGrowth = -1
let scrollAttempts = 0

function normalizeRole(value: unknown): ExportedMessage['role'] | null {
  const role = String(value ?? '').toLowerCase()
  if (role === 'user' || role === 'human') return 'user'
  if (role === 'assistant' || role === 'ai' || role === 'bot' || role === 'model') return 'assistant'
  if (role === 'system') return 'system'
  return null
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function collectMessages(node: unknown, out: Array<{ message: ExportedMessage; at?: string; order: number }>): number {
  if (Array.isArray(node)) {
    node.forEach((item) => collectMessages(item, out))
    return out.length
  }
  if (!node || typeof node !== 'object') return out.length
  const record = node as Record<string, unknown>
  const role = normalizeRole(record.role ?? record.sender)
  const content = typeof record.content === 'string' ? record.content : undefined
  if (role && content != null && content.trim() && !(record.content != null && typeof record.content === 'object')) {
    out.push({
      message: { role, content },
      at: normalizeTimestamp(record.insert_time ?? record.created_at),
      order: out.length,
    })
    return out.length
  }
  Object.values(record).forEach((value) => {
    if (value && typeof value === 'object') collectMessages(value, out)
  })
  return out.length
}

function storeCaptured(url: string, body: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return
  }
  const collected: Array<{ message: ExportedMessage; at?: string; order: number }> = []
  collectMessages(parsed, collected)
  if (!collected.length) return
  const sessionIds = new Set<string>()
  const urlMatch = url.match(SESSION_HREF_PATTERN)
  if (urlMatch) sessionIds.add(urlMatch[1])
  const huntIds = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(huntIds)
    if (!node || typeof node !== 'object') return
    Object.entries(node as Record<string, unknown>).forEach(([key, value]) => {
      if ((key === 'chat_session_id' || key === 'session_id') && typeof value === 'string' && value.length >= 8) sessionIds.add(value)
      if (value && typeof value === 'object') huntIds(value)
    })
  }
  huntIds(parsed)
  if (!sessionIds.size) return
  const messages = collected
    .sort((left, right) => {
      if (left.at && right.at) return left.at.localeCompare(right.at)
      return left.order - right.order
    })
    .map((entry) => ({ role: entry.message.role, content: entry.message.content, ...(entry.at ? { timestamp: entry.at } : {}) }))
  sessionIds.forEach((id) => captureCache.set(id, messages))
}

window.addEventListener(CAPTURE_EVENT, (event) => {
  const detail = (event as CustomEvent<{ body: string; url: string }>).detail
  if (detail?.body) storeCaptured(detail.url ?? '', detail.body)
})

function currentSessionId(): string | null {
  return document.location.pathname.match(SESSION_HREF_PATTERN)?.[1] ?? null
}

function sidebarAnchors(): HTMLAnchorElement[] {
  return [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((anchor) => SESSION_HREF_PATTERN.test(anchor.getAttribute('href') ?? ''))
}

function listVisibleSessions(): SessionEntry[] {
  return sidebarAnchors().map((anchor) => ({
    externalSessionId: (anchor.getAttribute('href') ?? '').match(SESSION_HREF_PATTERN)?.[1] ?? '',
    title: (anchor.textContent ?? '').trim().slice(0, 120),
  })).filter((entry) => entry.externalSessionId)
}

function sidebarScrollContainer(): HTMLElement | null {
  const anchor = sidebarAnchors()[0]
  let element = anchor?.parentElement
  while (element) {
    const style = window.getComputedStyle(element)
    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 40) return element
    element = element.parentElement
  }
  return document.querySelector<HTMLElement>('nav div[class]')
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function listScrollStep(): Promise<ListProgress> {
  const container = sidebarScrollContainer()
  if (!container) return { discovered: listVisibleSessions().length, reachedEnd: true, attempts: ++scrollAttempts }
  container.scrollTop = container.scrollHeight
  await wait(750)
  const discovered = listVisibleSessions().length
  const reachedEnd = discovered === lastScrollGrowth || container.scrollHeight - container.scrollTop <= container.clientHeight + 4
  lastScrollGrowth = discovered
  scrollAttempts += 1
  return { discovered, reachedEnd, attempts: scrollAttempts }
}

function isSessionReady(sessionId: string | null): boolean {
  if (sessionId && captureCache.has(sessionId)) return true
  return document.querySelectorAll('.ds-markdown').length > 0
}

async function waitForSession(sessionId: string | null, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isSessionReady(sessionId)) return true
    await wait(400)
  }
  return isSessionReady(sessionId)
}

function openSession(sessionId: string): boolean {
  const anchor = sidebarAnchors().find((candidate) => (candidate.getAttribute('href') ?? '').includes(sessionId))
  if (!anchor) return false
  anchor.click()
  return true
}

function extractMessagesFromDom(): ExportedMessage[] {
  const markdownNodes = [...document.querySelectorAll<HTMLElement>('.ds-markdown')]
  if (!markdownNodes.length) return []
  // The common ancestor of rendered answers also holds the interleaved user turns.
  let container = markdownNodes[0].parentElement
  while (container && container.parentElement && !container.contains(markdownNodes[markdownNodes.length - 1])) container = container.parentElement
  const host = container?.parentElement ?? container
  if (!host) return []
  const messages: ExportedMessage[] = []
  ;[...host.children].forEach((turn) => {
    if (!(turn instanceof HTMLElement)) return
    const answer = turn.querySelector('.ds-markdown')
    if (answer) {
      const text = (answer as HTMLElement).innerText.trim()
      if (text) messages.push({ role: 'assistant', content: text })
      return
    }
    const text = turn.innerText?.trim()
    if (text && !NOISE_TEXTS.has(text) && text.length <= 4000) messages.push({ role: 'user', content: text })
  })
  return messages
}

async function exportSession(externalSessionId: string | null): Promise<ExportedConversation> {
  const targetId = externalSessionId ?? currentSessionId()
  if (!targetId) throw new Error('没有找到当前会话，请先在 DeepSeek 中打开一个对话')
  const alreadyOpen = currentSessionId() === targetId
  if (!alreadyOpen && !openSession(targetId)) throw new Error('侧边栏中找不到这个会话，请先滚动加载历史列表')
  if (!alreadyOpen) {
    const opened = await waitForSession(targetId)
    if (!opened) throw new Error('等待会话内容超时：页面可能仍在加载，或 DeepSeek 界面结构已变化')
  } else {
    await waitForSession(targetId, 4_000)
  }
  const messages = captureCache.get(targetId) ?? []
  const domMessages = messages.length ? [] : extractMessagesFromDom()
  const finalMessages = messages.length ? messages : domMessages
  if (!finalMessages.length) throw new Error('未能读取到消息内容：需要先完整打开该会话一次')
  const anchorTitle = sidebarAnchors().find((candidate) => (candidate.getAttribute('href') ?? '').includes(targetId))?.textContent?.trim()
  const title = anchorTitle || document.title.replace(/ - DeepSeek$/i, '') || `会话 ${targetId.slice(0, 8)}`
  return {
    external_session_id: targetId,
    title,
    created_at: finalMessages.find((message) => message.timestamp)?.timestamp,
    messages: finalMessages.map(({ role, content, timestamp }) => ({ role, content, ...(timestamp ? { timestamp } : {}) })),
  }
}

chrome.runtime.onMessage.addListener((request: WorkbenchRequest, _sender, sendResponse) => {
  void (async () => {
    switch (request.type) {
      case 'PING':
        sendResponse({ ok: true, kind: 'list' })
        break
      case 'SOURCE_STATUS':
        sendResponse({ ok: true, kind: 'list', sessions: [] })
        break
      case 'LIST_VISIBLE':
        sendResponse({ ok: true, kind: 'list', sessions: listVisibleSessions() })
        break
      case 'LIST_SCROLL_STEP':
        sendResponse({ ok: true, kind: 'list', progress: await listScrollStep(), sessions: listVisibleSessions() })
        break
      case 'CURRENT_SESSION_ID':
        sendResponse({ ok: true, kind: 'current', currentSessionId: currentSessionId() })
        break
      case 'EXPORT_SESSION':
        try {
          sendResponse({ ok: true, kind: 'conversation', conversation: await exportSession(request.externalSessionId) })
        } catch (error) {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        break
      default:
        sendResponse({ ok: false, error: '未知的请求类型' })
    }
  })()
  return true
})

export {}
