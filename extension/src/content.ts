import { collectSessionEntries, mergeSessionEntries, sessionEntryFromUrl } from './session-discovery'
import { extractConversationSnapshots, mergeCapturedMessages, toExportedMessages, type CapturedMessage } from './message-extraction'
import type { ExportedConversation, ExportedMessage, ListProgress, SessionEntry, WorkbenchRequest } from './types'

const SESSION_HREF_PATTERN = /\/(?:a\/)?chat\/s\/([A-Za-z0-9_-]+)/
const CAPTURE_EVENT = 'nexus:captured-json'
const NOISE_TEXTS = new Set(['复制', '重新生成', '编辑', '删除', '继续生成'])

/** session id -> normalized messages captured from network responses. */
const captureCache = new Map<string, CapturedMessage[]>()
/** Current branch pointer returned by DeepSeek's chat_session metadata. */
const currentMessageCache = new Map<string, string>()
const sessionCache = new Map<string, SessionEntry>()
let scrollAttempts = 0
let scrollNoGrowthAttempts = 0

function resetListScan(): void {
  scrollAttempts = 0
  scrollNoGrowthAttempts = 0
  const container = sidebarScrollContainer()
  if (container) container.scrollTop = 0
}

function storeCaptured(url: string, body: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return
  }
  const discovered = mergeSessionEntries(collectSessionEntries(parsed), sessionEntryFromUrl(url) ? [sessionEntryFromUrl(url) as SessionEntry] : [])
  discovered.forEach((entry) => {
    const existing = sessionCache.get(entry.externalSessionId)
    sessionCache.set(entry.externalSessionId, { externalSessionId: entry.externalSessionId, title: entry.title || existing?.title || '' })
  })
  const snapshots = extractConversationSnapshots(parsed, url)
  snapshots.forEach((snapshot) => {
    const existing = captureCache.get(snapshot.sessionId) ?? []
    captureCache.set(snapshot.sessionId, mergeCapturedMessages(existing, snapshot.messages))
    if (snapshot.currentMessageId) currentMessageCache.set(snapshot.sessionId, snapshot.currentMessageId)
    const previous = sessionCache.get(snapshot.sessionId)
    if (snapshot.title || previous) {
      sessionCache.set(snapshot.sessionId, {
        externalSessionId: snapshot.sessionId,
        title: snapshot.title || previous?.title || '',
      })
    }
  })
}

async function readIndexedDbSession(sessionId: string): Promise<boolean> {
  if (!indexedDB.databases) return false
  try {
    const databases = await indexedDB.databases()
    for (const info of databases) {
      if (!info.name) continue
      let database: IDBDatabase | null = null
      try {
        database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(info.name as string)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        for (const storeName of Array.from(database.objectStoreNames)) {
          const records = await new Promise<unknown[]>((resolve) => {
            const values: unknown[] = []
            const request = database!.transaction(storeName, 'readonly').objectStore(storeName).openCursor()
            request.onsuccess = () => {
              const cursor = request.result
              if (!cursor) return resolve(values)
              values.push(cursor.value)
              cursor.continue()
            }
            request.onerror = () => resolve(values)
          })
          for (const value of records) {
            const snapshot = extractConversationSnapshots(value, `https://chat.deepseek.com/a/chat/s/${sessionId}`).find((item) => item.sessionId === sessionId)
            if (!snapshot) continue
            const existing = captureCache.get(sessionId) ?? []
            captureCache.set(sessionId, mergeCapturedMessages(existing, snapshot.messages))
            if (snapshot.currentMessageId) currentMessageCache.set(sessionId, snapshot.currentMessageId)
            if (snapshot.title) sessionCache.set(sessionId, { externalSessionId: sessionId, title: snapshot.title })
            return true
          }
        }
      } catch {
        // A stale or unavailable object store must not prevent other stores from being searched.
      } finally {
        database?.close()
      }
    }
  } catch {
    // IndexedDB access is a fallback only; DOM/API paths still remain available.
  }
  return false
}

window.addEventListener(CAPTURE_EVENT, (event) => {
  const detail = (event as CustomEvent<{ body: string; url: string }>).detail
  if (detail?.body) storeCaptured(detail.url ?? '', detail.body)
})

function currentSessionId(): string | null {
  return document.location.pathname.match(SESSION_HREF_PATTERN)?.[1] ?? null
}

function captureFingerprint(messages: CapturedMessage[]): string {
  if (!messages.length) return ''
  const first = messages[0]
  const last = messages[messages.length - 1]
  return [
    messages.length,
    first.messageId ?? '',
    first.content.length,
    last.messageId ?? '',
    last.content.length,
    last.timestamp ?? '',
  ].join('|')
}

function sidebarAnchors(): HTMLAnchorElement[] {
  return [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((anchor) => SESSION_HREF_PATTERN.test(anchor.getAttribute('href') ?? ''))
}

function listVisibleSessions(): SessionEntry[] {
  const domEntries = sidebarAnchors().map((anchor) => ({
    externalSessionId: (anchor.getAttribute('href') ?? '').match(SESSION_HREF_PATTERN)?.[1] ?? '',
    title: (anchor.textContent ?? '').trim().slice(0, 120),
  })).filter((entry) => entry.externalSessionId)
  domEntries.forEach((entry) => {
    const existing = sessionCache.get(entry.externalSessionId)
    sessionCache.set(entry.externalSessionId, { ...entry, title: entry.title || existing?.title || '' })
  })
  return mergeSessionEntries([...sessionCache.values()], domEntries)
}

function sidebarScrollContainer(): HTMLElement | null {
  const anchors = sidebarAnchors()
  for (const anchor of anchors) {
    let element = anchor.parentElement
    while (element) {
      const style = window.getComputedStyle(element)
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 40) return element
      element = element.parentElement
    }
  }
  const candidates = [...document.querySelectorAll<HTMLElement>('body *')]
    .filter((element) => {
      const style = window.getComputedStyle(element)
      return anchors.some((anchor) => element.contains(anchor)) && /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 40
    })
    .sort((left, right) => left.clientHeight - right.clientHeight)
  return candidates[0] ?? null
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function listScrollStep(): Promise<ListProgress> {
  const container = sidebarScrollContainer()
  if (!container) return { discovered: listVisibleSessions().length, reachedEnd: true, attempts: ++scrollAttempts }
  const previousTop = container.scrollTop
  const previousHeight = container.scrollHeight
  const previousDiscovered = listVisibleSessions().length
  const maxTop = Math.max(0, previousHeight - container.clientHeight)
  const step = Math.max(container.clientHeight * 0.75, 280)
  container.scrollTop = Math.min(previousTop + step, maxTop)
  await wait(900)
  const discovered = listVisibleSessions().length
  const heightChanged = container.scrollHeight > previousHeight + 8
  const positionAtEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 4
  const madeProgress = discovered > previousDiscovered || heightChanged
  scrollNoGrowthAttempts = madeProgress ? 0 : scrollNoGrowthAttempts + 1
  scrollAttempts += 1
  return { discovered, reachedEnd: positionAtEnd && scrollNoGrowthAttempts >= 3, attempts: scrollAttempts }
}

function isSessionReady(sessionId: string | null, baselineMarkdownCount = 0): boolean {
  if (sessionId && captureCache.has(sessionId)) return true
  const markdownCount = document.querySelectorAll('.ds-markdown').length
  return currentSessionId() === sessionId && markdownCount > 0 && markdownCount !== baselineMarkdownCount
}

async function waitForSession(sessionId: string | null, timeoutMs = 20_000): Promise<boolean> {
  if (sessionId && !captureCache.has(sessionId)) await readIndexedDbSession(sessionId)
  const deadline = Date.now() + timeoutMs
  let lastFingerprint = ''
  let stableSince = 0
  let finalIdbRead = false
  while (Date.now() < deadline) {
    if (sessionId) {
      const captured = captureCache.get(sessionId)
      if (captured?.length) {
        const fingerprint = captureFingerprint(captured)
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint
          stableSince = Date.now()
        }
        // A history response can arrive in several windows. Wait for a quiet
        // period so a short first window is not exported as the full session.
        if (stableSince && Date.now() - stableSince >= 900) {
          if (!finalIdbRead) {
            finalIdbRead = true
            await readIndexedDbSession(sessionId)
            continue
          }
          return true
        }
      }
    }
    if (currentSessionId() === sessionId && document.querySelectorAll('.ds-markdown').length > 0) {
      // DOM content is the fallback only when no network/IDB snapshot exists;
      // a partial cache must continue settling instead of masking later data.
      if (!(sessionId && captureCache.has(sessionId))) {
        await wait(500)
        return currentSessionId() === sessionId && (Boolean(sessionId && captureCache.has(sessionId)) || document.querySelectorAll('.ds-markdown').length > 0)
      }
    }
    await wait(350)
  }
  return Boolean(sessionId && captureCache.has(sessionId)) || (currentSessionId() === sessionId && document.querySelectorAll('.ds-markdown').length > 0)
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
  const messages = toExportedMessages(captureCache.get(targetId) ?? [], currentMessageCache.get(targetId))
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
        sendResponse({ ok: true, kind: 'list', sessions: listVisibleSessions() })
        break
      case 'LIST_RESET':
        resetListScan()
        sendResponse({ ok: true, kind: 'list', sessions: listVisibleSessions(), progress: { discovered: listVisibleSessions().length, reachedEnd: false, attempts: 0 } })
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
