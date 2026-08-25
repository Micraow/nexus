import { describe, expect, it } from 'vitest'
import type { Message } from '@/types/domain'
import { combineSegmentationChunks, splitMessageChunks } from '@/utils/chunks'

function message(order: number, content: string): Message {
  return {
    id: `message_${order}`,
    sessionId: 'session_1',
    unitId: null,
    role: order % 2 === 0 ? 'user' : 'assistant',
    content,
    orderInSession: order,
    timestamp: null,
    metadata: null,
  }
}

describe('splitMessageChunks', () => {
  it('keeps a short session in one chunk', () => {
    const messages = [message(0, '短问题'), message(1, '短回答')]
    const chunks = splitMessageChunks(messages, 8000)
    expect(chunks.length).toBe(1)
    expect(chunks[0].expectedIndices).toEqual([0, 1])
  })

  it('splits long sessions with overlapping messages and global indices', () => {
    const messages = Array.from({ length: 60 }, (_, index) => message(index, 'x'.repeat(400 * (index + 1) % 900 + 200)))
    const chunks = splitMessageChunks(messages, 3000)
    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach((chunk, index) => {
      expect(chunk.expectedIndices.length).toBe(chunk.messages.length)
      expect(chunk.messages[0].orderInSession).toBe(chunk.start)
      if (index > 0) {
        const previous = chunks[index - 1]
        expect(chunk.start).toBeLessThan(previous.end)
      }
    })
    expect(chunks[chunks.length - 1].end).toBe(messages.length)
  })
})

describe('combineSegmentationChunks', () => {
  it('merges non-overlapping chunk results and sorts unassigned indices', () => {
    const combined = combineSegmentationChunks([
      { units: [{ message_indices: [0, 1], title_hint: '原理' }], unassigned_message_indices: [2] },
      { units: [{ message_indices: [3, 4] }], unassigned_message_indices: [] },
    ], 5)
    expect(combined.errors).toEqual([])
    expect(combined.data?.units.map((unit) => unit.message_indices)).toEqual([[0, 1], [3, 4]])
    expect(combined.data?.unassigned_message_indices).toEqual([2])
  })

  it('reports conflicts instead of silently merging overlapping units', () => {
    const combined = combineSegmentationChunks([
      { units: [{ message_indices: [1, 2], title_hint: 'A' }], unassigned_message_indices: [] },
      { units: [{ message_indices: [2, 3], title_hint: 'B' }], unassigned_message_indices: [] },
    ], 4)
    expect(combined.data).toBeUndefined()
    expect(combined.errors.some((error) => error.includes('消息 3'))).toBe(false)
    expect(combined.errors.join('\n')).toContain('未覆盖')
  })

  it('rejects an index that is both assigned and unassigned', () => {
    const combined = combineSegmentationChunks([
      { units: [{ message_indices: [0] }], unassigned_message_indices: [0] },
    ], 1)
    expect(combined.errors.join('\n')).toContain('同时')
  })

  it('requires full coverage of all messages', () => {
    const combined = combineSegmentationChunks([
      { units: [{ message_indices: [0] }], unassigned_message_indices: [] },
    ], 3)
    expect(combined.errors.join('\n')).toContain('消息 2 在分块合并后仍未覆盖')
  })
})
