import type { SessionEntry } from './types'

const ID_KEYS = ['chat_session_id', 'session_id', 'conversation_id', 'conversationId', 'chatId', 'id'] as const
const TITLE_KEYS = ['title', 'name', 'chat_title', 'session_title'] as const

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function looksLikeSessionId(value: string): boolean {
  return value.length >= 6 && value.length <= 180 && !/[\s/]/.test(value)
}

function recordValue(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = text(record[key])
    if (value) return value
  }
  return ''
}

function isMessageRecord(record: Record<string, unknown>): boolean {
  return Boolean(record.role || record.sender || record.content || record.message_type)
}

/**
 * DeepSeek has changed the nesting of its history response several times.
 * Discover only records that look like a conversation row, so arbitrary ids
 * in message payloads are not mistaken for sessions.
 */
export function collectSessionEntries(node: unknown, out: SessionEntry[] = []): SessionEntry[] {
  if (Array.isArray(node)) {
    node.forEach((item) => collectSessionEntries(item, out))
    return out
  }
  if (!node || typeof node !== 'object') return out
  const record = node as Record<string, unknown>
  const title = recordValue(record, TITLE_KEYS)
  const id = recordValue(record, ID_KEYS)
  const hasSessionShape = !isMessageRecord(record) && Boolean(title) && looksLikeSessionId(id)
  if (hasSessionShape && !out.some((entry) => entry.externalSessionId === id)) {
    out.push({ externalSessionId: id, title: title.slice(0, 120) })
  }
  Object.values(record).forEach((value) => {
    if (value && typeof value === 'object') collectSessionEntries(value, out)
  })
  return out
}

export function sessionEntryFromUrl(url: string): SessionEntry | null {
  const match = url.match(/\/(?:a\/)?chat\/s\/([A-Za-z0-9_-]+)/)
  return match ? { externalSessionId: match[1], title: '' } : null
}

export function mergeSessionEntries(...lists: Array<SessionEntry[] | undefined>): SessionEntry[] {
  const merged = new Map<string, SessionEntry>()
  lists.flat().filter(Boolean).forEach((entry) => {
    if (!entry?.externalSessionId) return
    const existing = merged.get(entry.externalSessionId)
    if (!existing) merged.set(entry.externalSessionId, { ...entry })
    else if (entry.title && !existing.title) existing.title = entry.title
  })
  return [...merged.values()]
}
