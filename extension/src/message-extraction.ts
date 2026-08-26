import type { ExportedMessage } from './types'

/** Internal representation keeps the fields needed to merge network snapshots. */
export interface CapturedMessage extends ExportedMessage {
  messageId?: string
  sourceOrder: number
  orderHint?: number
}

export interface ConversationSnapshot {
  sessionId: string
  title?: string
  messages: CapturedMessage[]
}

interface RecordLike {
  [key: string]: unknown
}

interface SessionInfo {
  id: string
  title?: string
}

const SESSION_ID_KEYS = [
  'chat_session_id',
  'session_id',
  'conversation_id',
  'conversationId',
  'chatId',
  'external_session_id',
] as const
const TITLE_KEYS = ['title', 'name', 'chat_title', 'session_title'] as const
const MESSAGE_ID_KEYS = ['message_id', 'messageId', 'uuid', 'id'] as const
const ORDER_KEYS = ['order_in_session', 'order', 'sequence', 'seq', 'index'] as const
const MESSAGE_ARRAY_KEYS = ['chat_messages', 'messages'] as const

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function recordValue(record: RecordLike, keys: readonly string[]): string {
  for (const key of keys) {
    const value = scalarText(record[key])
    if (value) return value
  }
  return ''
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function normalizeRole(value: unknown): ExportedMessage['role'] | null {
  const role = String(value ?? '').toLowerCase()
  if (role === 'user' || role === 'human') return 'user'
  if (role === 'assistant' || role === 'ai' || role === 'bot' || role === 'model') return 'assistant'
  if (role === 'system') return 'system'
  return null
}

export function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  let candidate: string | number = value
  if (typeof value === 'number' && value < 1_000_000_000_000) candidate = value * 1000
  if (typeof value === 'string' && /^\d{10,13}$/.test(value.trim())) {
    const numeric = Number(value)
    candidate = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
  }
  const date = new Date(candidate)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function fragmentContent(record: RecordLike, role: ExportedMessage['role']): string {
  if (!Array.isArray(record.fragments)) return ''
  const expectedTypes = role === 'user' ? new Set(['REQUEST']) : new Set(['RESPONSE', 'ANSWER'])
  const values = record.fragments
    .filter((fragment): fragment is RecordLike => Boolean(fragment && typeof fragment === 'object'))
    .filter((fragment) => expectedTypes.has(String(fragment.type ?? '').toUpperCase()))
    .map((fragment) => typeof fragment.content === 'string' ? fragment.content : '')
    .filter(Boolean)
  return values.join('\n\n').trim()
}

function messageContent(record: RecordLike, role: ExportedMessage['role']): string {
  const direct = typeof record.content === 'string' ? record.content : ''
  const fragments = fragmentContent(record, role)
  if (fragments) return fragments
  if (direct.trim()) return direct.trim()
  for (const key of ['text', 'request_content', 'response_content', 'answer']) {
    if (typeof record[key] === 'string' && text(record[key])) return text(record[key])
  }
  return ''
}

function normalizeMessageRecord(record: RecordLike, sourceOrder: number): CapturedMessage | null {
  const role = normalizeRole(record.role ?? record.sender)
  if (!role) return null
  const content = messageContent(record, role)
  if (!content) return null
  const messageId = recordValue(record, MESSAGE_ID_KEYS) || undefined
  const orderHint = ORDER_KEYS.map((key) => numericValue(record[key])).find((value) => value !== undefined)
  const timestamp = normalizeTimestamp(
    record.inserted_at ?? record.insert_time ?? record.created_at ?? record.createdAt ?? record.timestamp,
  )
  return {
    role,
    content,
    ...(timestamp ? { timestamp } : {}),
    ...(messageId ? { messageId } : {}),
    sourceOrder,
    ...(orderHint !== undefined ? { orderHint } : {}),
  }
}

function collectMessageRecords(node: unknown, out: CapturedMessage[], counter = { value: 0 }): void {
  if (Array.isArray(node)) {
    node.forEach((item) => collectMessageRecords(item, out, counter))
    return
  }
  if (!node || typeof node !== 'object') return
  const record = node as RecordLike
  const message = normalizeMessageRecord(record, counter.value)
  if (message) {
    counter.value += 1
    out.push(message)
    return
  }
  Object.entries(record).forEach(([key, value]) => {
    // Fragment objects are part of their parent message, never standalone turns.
    if (key === 'fragments') return
    if (value && typeof value === 'object') collectMessageRecords(value, out, counter)
  })
}

function nestedSessionInfo(record: RecordLike): SessionInfo | null {
  for (const key of ['chat_session', 'session', 'conversation']) {
    const nested = record[key]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue
    const nestedRecord = nested as RecordLike
    const id = recordValue(nestedRecord, ['id', ...SESSION_ID_KEYS])
    if (id) return { id, title: recordValue(nestedRecord, TITLE_KEYS) || undefined }
  }
  return null
}

function sessionInfo(record: RecordLike): SessionInfo | null {
  const nested = nestedSessionInfo(record)
  if (nested) return nested
  const id = recordValue(record, SESSION_ID_KEYS)
  return id ? { id, title: recordValue(record, TITLE_KEYS) || undefined } : null
}

function sessionInfoForMessageArray(record: RecordLike): SessionInfo | null {
  const nested = nestedSessionInfo(record)
  if (nested) return nested
  const direct = sessionInfo(record)
  if (direct) return direct
  // A generic `id` is safe only on a titled record that directly owns the
  // message array. Untitled response/request IDs are not conversation IDs.
  const title = recordValue(record, TITLE_KEYS)
  const id = title ? recordValue(record, ['id']) : ''
  return id ? { id, title } : null
}

function sessionIdFromUrl(url: string): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url, 'https://chat.deepseek.com')
    const pathMatch = parsed.pathname.match(/\/(?:a\/)?chat\/s\/([A-Za-z0-9_-]+)/)
    if (pathMatch) return pathMatch[1]
    for (const key of SESSION_ID_KEYS) {
      const value = parsed.searchParams.get(key)
      if (value?.trim()) return value.trim()
    }
  } catch {
    const pathMatch = url.match(/\/(?:a\/)?chat\/s\/([A-Za-z0-9_-]+)/)
    if (pathMatch) return pathMatch[1]
  }
  return null
}

interface Candidate {
  sessionId?: string
  title?: string
  messages: CapturedMessage[]
}

function collectCandidates(
  node: unknown,
  explicit: Candidate[],
  unscoped: Candidate[],
  seen: WeakSet<object>,
  inheritedSession?: SessionInfo,
  depth = 0,
): void {
  if (!node || typeof node !== 'object' || depth > 12) return
  if (seen.has(node)) return
  seen.add(node)
  if (Array.isArray(node)) {
    node.forEach((item) => collectCandidates(item, explicit, unscoped, seen, inheritedSession, depth + 1))
    return
  }
  const record = node as RecordLike
  const ownSession = sessionInfo(record) ?? inheritedSession
  for (const key of MESSAGE_ARRAY_KEYS) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    const messages: CapturedMessage[] = []
    collectMessageRecords(value, messages)
    if (!messages.length) continue
    const info = sessionInfoForMessageArray(record) ?? ownSession
    const candidate: Candidate = { sessionId: info?.id, title: info?.title, messages: orderCapturedMessages(messages) }
    ;(candidate.sessionId ? explicit : unscoped).push(candidate)
  }
  Object.entries(record).forEach(([key, value]) => {
    if (MESSAGE_ARRAY_KEYS.includes(key as (typeof MESSAGE_ARRAY_KEYS)[number])) return
    if (value && typeof value === 'object') collectCandidates(value, explicit, unscoped, seen, ownSession, depth + 1)
  })
}

function messageSignature(message: CapturedMessage): string {
  return `${message.role}\u0000${message.content}`
}

function sameSequence(left: CapturedMessage[], right: CapturedMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => messageSignature(message) === messageSignature(right[index]))
}

function containsSequence(haystack: CapturedMessage[], needle: CapturedMessage[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((message, index) => messageSignature(message) === messageSignature(haystack[start + index]))) return true
  }
  return false
}

function overlapLength(left: CapturedMessage[], right: CapturedMessage[]): number {
  const max = Math.min(left.length, right.length)
  for (let length = max; length > 0; length -= 1) {
    const suffix = left.slice(left.length - length)
    const prefix = right.slice(0, length)
    if (sameSequence(suffix, prefix)) return length
  }
  return 0
}

/**
 * Apply an explicit per-message order when available. Otherwise retain the
 * response array order unless timestamps clearly prove that the API returned
 * the array backwards. Missing timestamps never participate in a partial sort.
 */
export function orderCapturedMessages(input: CapturedMessage[]): CapturedMessage[] {
  const entries = input.map((message, index) => ({ ...message, sourceOrder: message.sourceOrder ?? index }))
  const hinted = entries.filter((message) => message.orderHint !== undefined)
  const enoughHints = hinted.length >= Math.max(2, Math.ceil(entries.length * 0.8))
  if (enoughHints && new Set(hinted.map((message) => message.orderHint)).size === hinted.length) {
    return [...entries].sort((left, right) => (left.orderHint as number) - (right.orderHint as number) || left.sourceOrder - right.sourceOrder)
  }

  const timed = entries.filter((message): message is CapturedMessage & { timestamp: string } => Boolean(message.timestamp))
  const enoughTimes = timed.length >= Math.max(2, Math.ceil(entries.length * 0.8))
  if (enoughTimes) {
    let ascending = 0
    let descending = 0
    for (let index = 1; index < timed.length; index += 1) {
      const previous = timed[index - 1].timestamp
      const current = timed[index].timestamp
      if (current > previous) ascending += 1
      if (current < previous) descending += 1
    }
    if (descending > ascending && descending > 0) {
      return [...entries].sort((left, right) => {
        if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) return left.timestamp.localeCompare(right.timestamp)
        return left.sourceOrder - right.sourceOrder
      })
    }
  }
  return entries
}

/** Merge a full snapshot or an incremental response without duplicating turns. */
export function mergeCapturedMessages(existing: CapturedMessage[], incoming: CapturedMessage[]): CapturedMessage[] {
  if (!existing.length) return orderCapturedMessages(incoming)
  if (!incoming.length) return orderCapturedMessages(existing)

  const incomingHasIds = incoming.some((message) => message.messageId)
  if (incomingHasIds || existing.some((message) => Boolean(message.messageId))) {
    const existingIds = new Set(existing.flatMap((message) => message.messageId ? [message.messageId] : []))
    const incomingIds = new Set(incoming.flatMap((message) => message.messageId ? [message.messageId] : []))
    const incomingContainsExisting = existingIds.size > 0 && [...existingIds].every((id) => incomingIds.has(id))
    if (incomingContainsExisting && incoming.length >= existing.length) return orderCapturedMessages(incoming)
    const merged = [...existing]
    const positions = new Map(merged.filter((message) => message.messageId).map((message, index) => [message.messageId as string, index]))
    incoming.forEach((message) => {
      if (message.messageId && positions.has(message.messageId)) merged[positions.get(message.messageId) as number] = message
      else merged.push(message)
    })
    return orderCapturedMessages(merged)
  }

  if (sameSequence(existing, incoming) || containsSequence(existing, incoming)) return orderCapturedMessages(existing.length >= incoming.length ? existing : incoming)
  if (containsSequence(incoming, existing)) return orderCapturedMessages(incoming)
  const appendOverlap = overlapLength(existing, incoming)
  if (appendOverlap) return orderCapturedMessages([...existing, ...incoming.slice(appendOverlap)])
  const prependOverlap = overlapLength(incoming, existing)
  if (prependOverlap) return orderCapturedMessages([...incoming, ...existing.slice(prependOverlap)])
  // A complete snapshot is more trustworthy than a shorter partial response.
  return orderCapturedMessages(incoming.length >= existing.length ? incoming : existing)
}

function mergeCandidate(existing: Candidate | undefined, incoming: Candidate): Candidate {
  if (!existing) return incoming
  return {
    sessionId: incoming.sessionId,
    title: incoming.title || existing.title,
    messages: mergeCapturedMessages(existing.messages, incoming.messages),
  }
}

/** Extract only conversation-scoped snapshots from a DeepSeek response. */
export function extractConversationSnapshots(payload: unknown, url = ''): ConversationSnapshot[] {
  const explicit: Candidate[] = []
  const unscoped: Candidate[] = []
  collectCandidates(payload, explicit, unscoped, new WeakSet<object>())

  const grouped = new Map<string, Candidate>()
  explicit.forEach((candidate) => {
    if (!candidate.sessionId) return
    grouped.set(candidate.sessionId, mergeCandidate(grouped.get(candidate.sessionId), candidate))
  })

  // A session-specific endpoint may omit chat_session while still carrying a
  // single chat_messages array. Never apply an ambiguous response to every ID.
  const targetId = sessionIdFromUrl(url)
  if (targetId && !grouped.has(targetId) && explicit.length === 0 && unscoped.length === 1) {
    const candidate = unscoped[0]
    grouped.set(targetId, { ...candidate, sessionId: targetId })
  }

  return [...grouped.values()].map((candidate) => ({
    sessionId: candidate.sessionId as string,
    ...(candidate.title ? { title: candidate.title } : {}),
    messages: orderCapturedMessages(candidate.messages),
  }))
}

export function toExportedMessages(messages: CapturedMessage[]): ExportedMessage[] {
  return orderCapturedMessages(messages).map(({ role, content, timestamp }) => ({ role, content, ...(timestamp ? { timestamp } : {}) }))
}
