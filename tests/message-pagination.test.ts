import { describe, expect, it } from 'vitest'
import { FULLSCREEN_MESSAGE_PAGE_SIZE, messagePageCount, paginateMessages } from '@/services/message-pagination'
import type { Message } from '@/types/domain'

const messages = Array.from({ length: 45 }, (_, index): Message => ({
  id: `message-${index}`,
  sessionId: index < 22 ? 'session-a' : 'session-b',
  unitId: null,
  role: index % 2 ? 'assistant' : 'user',
  content: `message ${index}`,
  orderInSession: index < 22 ? index : index - 22,
  timestamp: null,
  metadata: null,
}))

describe('fullscreen message pagination', () => {
  it('pages a multi-Session topic conversation without dropping messages', () => {
    expect(FULLSCREEN_MESSAGE_PAGE_SIZE).toBe(20)
    expect(messagePageCount(messages)).toBe(3)
    expect(paginateMessages(messages, 0)).toHaveLength(20)
    expect(paginateMessages(messages, 1)).toHaveLength(20)
    expect(paginateMessages(messages, 2).map((message) => message.id)).toEqual([
      'message-40', 'message-41', 'message-42', 'message-43', 'message-44',
    ])
  })

  it('clamps invalid page requests to a valid page', () => {
    expect(paginateMessages(messages, -1)[0]?.id).toBe('message-0')
    expect(paginateMessages(messages, 99)[0]?.id).toBe('message-40')
    expect(messagePageCount([])).toBe(1)
  })
})
