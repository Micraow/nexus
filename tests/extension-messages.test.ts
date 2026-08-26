import { describe, expect, it } from 'vitest'
import {
  extractConversationSnapshots,
  mergeCapturedMessages,
  orderCapturedMessages,
  type CapturedMessage,
} from '../extension/src/message-extraction'

function message(id: string, role: 'user' | 'assistant', content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, role, content, ...extra }
}

function captured(id: string, role: 'user' | 'assistant', content: string, sourceOrder: number): CapturedMessage {
  return { messageId: id, role, content, sourceOrder }
}

describe('DeepSeek message extraction', () => {
  it('keeps messages bound to their own chat session', () => {
    const payload = {
      data: {
        sessions: [
          {
            chat_session: { id: 'session-a', title: 'A' },
            chat_messages: [message('a-1', 'user', 'A 的问题'), message('a-2', 'assistant', 'A 的回答')],
          },
          {
            chat_session: { id: 'session-b', title: 'B' },
            chat_messages: [message('b-1', 'user', 'B 的问题'), message('b-2', 'assistant', 'B 的回答')],
          },
        ],
      },
    }

    const snapshots = extractConversationSnapshots(payload)
    expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['session-a', 'session-b'])
    expect(snapshots.find((snapshot) => snapshot.sessionId === 'session-a')?.messages.map((item) => item.content)).toEqual(['A 的问题', 'A 的回答'])
    expect(snapshots.find((snapshot) => snapshot.sessionId === 'session-b')?.messages.map((item) => item.content)).toEqual(['B 的问题', 'B 的回答'])
  })

  it('does not copy a scoped response to unrelated session ids in metadata', () => {
    const snapshots = extractConversationSnapshots({
      data: {
        chat_session: { id: 'session-a', title: 'A' },
        chat_messages: [message('a-1', 'user', 'A 的问题')],
        metadata: { session_id: 'session-b' },
      },
    })
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.sessionId).toBe('session-a')
  })

  it('does not guess a URL target when the response also contains another scoped snapshot', () => {
    const snapshots = extractConversationSnapshots(
      {
        data: {
          chat_session: { id: 'session-a', title: 'A' },
          chat_messages: [message('a-1', 'user', 'A 的问题')],
          extra: { chat_messages: [message('unknown-1', 'user', '未标明归属的消息')] },
        },
      },
      'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=session-b',
    )
    expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['session-a'])
  })

  it('uses the session-specific URL when the response omits chat_session', () => {
    const snapshots = extractConversationSnapshots(
      { data: { chat_messages: [message('b-1', 'user', 'B 的问题')] } },
      'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=session-b',
    )
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.sessionId).toBe('session-b')
  })

  it('inherits a session id from a response wrapper around chat_messages', () => {
    const snapshots = extractConversationSnapshots({
      session_id: 'session-b',
      data: { chat_messages: [message('b-1', 'user', 'B 的问题')] },
    })
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.sessionId).toBe('session-b')
  })

  it('accepts a titled share-style conversation with a generic id', () => {
    const snapshots = extractConversationSnapshots({
      id: 'shared-session',
      title: '分享会话',
      messages: [message('m-1', 'user', '第一个问题')],
    })
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.sessionId).toBe('shared-session')
  })

  it('orders reversed timestamp snapshots chronologically and preserves order when timestamps are absent', () => {
    const reversed = orderCapturedMessages([
      { ...captured('m-2', 'assistant', '回答', 0), timestamp: '2026-01-01T00:00:02.000Z' },
      { ...captured('m-1', 'user', '问题', 1), timestamp: '2026-01-01T00:00:01.000Z' },
    ])
    expect(reversed.map((item) => item.content)).toEqual(['问题', '回答'])

    const noTimestamps = orderCapturedMessages([
      captured('m-2', 'assistant', '后一个', 0),
      captured('m-1', 'user', '前一个', 1),
    ])
    expect(noTimestamps.map((item) => item.content)).toEqual(['后一个', '前一个'])
  })

  it('merges repeated full snapshots without duplicating messages', () => {
    const first = [captured('m-1', 'user', '问题', 0), captured('m-2', 'assistant', '回答', 1)]
    const second = [
      captured('m-1', 'user', '问题', 0),
      captured('m-2', 'assistant', '回答', 1),
      captured('m-3', 'user', '追问', 2),
    ]
    const merged = mergeCapturedMessages(first, second)
    expect(merged.map((item) => item.content)).toEqual(['问题', '回答', '追问'])
  })

  it('uses a longer full snapshot when older turns are lazy-loaded at the front', () => {
    const partial = [captured('m-2', 'assistant', '回答', 0), captured('m-3', 'user', '追问', 1)]
    const full = [
      captured('m-1', 'user', '最早的问题', 0),
      captured('m-2', 'assistant', '回答', 1),
      captured('m-3', 'user', '追问', 2),
    ]
    expect(mergeCapturedMessages(partial, full).map((item) => item.content)).toEqual(['最早的问题', '回答', '追问'])
  })
})
