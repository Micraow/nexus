import type { SegmentationResult } from '@/services/validation'
import type { EvidenceChunk, Message } from '@/types/domain'
import { stableHash } from '@/utils/id'

export interface MessageChunk {
  messages: Message[]
  start: number
  end: number
  expectedIndices: number[]
}

export function estimateTokens(messages: Message[]): number {
  return Math.ceil(messages.reduce((total, message) => total + message.content.length, 0) / 4)
}

/** Split one message into addressable evidence slices while preserving offsets. */
export function splitMessageEvidence(message: Message, maxTokens = 420, overlapChars = 80): EvidenceChunk[] {
  const text = message.content ?? ''
  if (!text.length) return []
  const maxChars = Math.max(240, maxTokens * 4)
  const overlap = Math.max(0, Math.min(overlapChars, Math.floor(maxChars / 3)))
  const chunks: EvidenceChunk[] = []
  let start = 0
  let index = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length) {
      const boundary = Math.max(start + Math.floor(maxChars * 0.6), text.lastIndexOf('\n', end))
      if (boundary > start) end = boundary
    }
    const content = text.slice(start, end)
    chunks.push({
      id: `${message.id}:chunk:${index}`,
      messageId: message.id,
      sessionId: message.sessionId,
      chunkIndex: index,
      charStart: start,
      charEnd: end,
      content,
      tokenCount: Math.max(1, Math.ceil(content.length / 4)),
      contentHash: stableHash(content),
      updatedAt: message.timestamp ?? new Date(0).toISOString(),
    })
    if (end >= text.length) break
    const next = Math.max(start + 1, end - overlap)
    start = next
    index += 1
  }
  return chunks
}

export function buildEvidenceChunks(messages: Message[], maxTokens = 420): EvidenceChunk[] {
  return messages.flatMap((message) => splitMessageEvidence(message, maxTokens))
}

/**
 * Split a session's messages into request-sized chunks. Adjacent chunks share
 * a small overlap of messages; chunk boundaries never imply unit boundaries.
 */
export function splitMessageChunks(messages: Message[], tokenBudget: number): MessageChunk[] {
  const budget = Math.max(1000, tokenBudget)
  if (estimateTokens(messages) <= budget) {
    return [{ messages, start: 0, end: messages.length, expectedIndices: messages.map((message) => message.orderInSession) }]
  }
  const chunks: MessageChunk[] = []
  let start = 0
  while (start < messages.length) {
    let end = start
    let tokens = 0
    while (end < messages.length) {
      const nextTokens = Math.max(1, Math.ceil(messages[end].content.length / 4))
      if (end > start && tokens + nextTokens > budget) break
      tokens += nextTokens
      end += 1
    }
    if (end === start) end += 1
    const chunkMessages = messages.slice(start, end)
    chunks.push({ messages: chunkMessages, start, end, expectedIndices: chunkMessages.map((message) => message.orderInSession) })
    if (end >= messages.length) break
    start = Math.max(start + 1, end - 2)
  }
  return chunks
}

export interface ChunkCombineResult {
  data?: SegmentationResult
  errors: string[]
}

/**
 * Merge per-chunk segmentation results into one whole-session result.
 * Overlapping messages must agree on their unit title hint, otherwise they are
 * reported as conflicts instead of being merged silently.
 */
export function combineSegmentationChunks(results: Array<SegmentationResult>, messageCount: number): ChunkCombineResult {
  const units: Array<{ message_indices: number[]; title_hint?: string }> = []
  const assignments = new Map<number, number>()
  const unassigned = new Set<number>()
  const errors: string[] = []
  results.forEach((result) => {
    result.units.forEach((unit) => {
      const fresh: number[] = []
      unit.message_indices.forEach((index) => {
        if (unassigned.has(index)) {
          errors.push(`消息 ${index} 同时被标记为未分配和知识单元`)
          return
        }
        const existingUnitIndex = assignments.get(index)
        if (existingUnitIndex != null) {
          const previous = units[existingUnitIndex].title_hint
          if (previous && unit.title_hint && previous !== unit.title_hint) errors.push(`重叠分块对消息 ${index} 给出了冲突主题`)
          return
        }
        fresh.push(index)
      })
      if (fresh.length) {
        const unitIndex = units.length
        units.push({ message_indices: fresh, title_hint: unit.title_hint })
        fresh.forEach((index) => assignments.set(index, unitIndex))
      }
    })
    result.unassigned_message_indices.forEach((index) => {
      if (assignments.has(index)) errors.push(`消息 ${index} 同时被分配到知识单元和未分配列表`)
      unassigned.add(index)
    })
  })
  for (let index = 0; index < messageCount; index += 1) {
    if (!assignments.has(index) && !unassigned.has(index)) errors.push(`消息 ${index} 在分块合并后仍未覆盖`)
  }
  return errors.length ? { errors } : { data: { units, unassigned_message_indices: [...unassigned].sort((left, right) => left - right) }, errors: [] }
}
