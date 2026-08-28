import { describe, expect, it } from 'vitest'
import { FULLSCREEN_MESSAGE_PAGE_SIZE, messagePageCount, paginateMessages } from '@/services/message-pagination'
import type { Message } from '@/types/domain'

const makeMessage = (id: string, sessionId: string, orderInSession: number): Message => ({
  id,
  sessionId,
  unitId: null,
  role: orderInSession % 2 ? 'assistant' : 'user',
  content: `${sessionId} message ${orderInSession}`,
  orderInSession,
  timestamp: null,
  metadata: null,
})

const messages = [
  ...Array.from({ length: 22 }, (_, index) => makeMessage(`a-${index}`, 'session-a', index)),
  ...Array.from({ length: 23 }, (_, index) => makeMessage(`b-${index}`, 'session-b', index)),
]

describe('fullscreen message pagination', () => {
  it('keeps every Session together, even when a Session exceeds the old page size', () => {
    expect(FULLSCREEN_MESSAGE_PAGE_SIZE).toBe(20)
    expect(messagePageCount(messages)).toBe(2)
    expect(paginateMessages(messages, 0)).toHaveLength(22)
    expect(paginateMessages(messages, 1)).toHaveLength(23)
    expect(paginateMessages(messages, 0).every((message) => message.sessionId === 'session-a')).toBe(true)
    expect(paginateMessages(messages, 1).every((message) => message.sessionId === 'session-b')).toBe(true)
  })

  it('groups interleaved messages by Session and orders each transcript locally', () => {
    const interleaved = [
      makeMessage('b-2', 'session-b', 2),
      makeMessage('a-1', 'session-a', 1),
      makeMessage('b-0', 'session-b', 0),
      makeMessage('a-0', 'session-a', 0),
    ]
    expect(messagePageCount(interleaved)).toBe(2)
    expect(paginateMessages(interleaved, 0).map((message) => message.id)).toEqual(['b-0', 'b-2'])
    expect(paginateMessages(interleaved, 1).map((message) => message.id)).toEqual(['a-0', 'a-1'])
  })

  it('clamps invalid page requests to a valid page', () => {
    expect(paginateMessages(messages, -1)[0]?.id).toBe('a-0')
    expect(paginateMessages(messages, 99)[0]?.id).toBe('b-0')
    expect(messagePageCount([])).toBe(1)
    expect(paginateMessages([], 0)).toEqual([])
  })
})
