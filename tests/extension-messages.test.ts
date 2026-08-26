import { describe, expect, it } from 'vitest'
import {
  extractConversationSnapshots,
  mergeCapturedMessages,
  orderCapturedMessages,
  selectConversationPath,
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

  it('keeps the real Spine Leaf conversation order despite DeepSeek pairwise timestamp skew', () => {
    // Extracted from data/2-sessions.json. DeepSeek stamped every assistant
    // placeholder 3-5 ms before its user turn even though the API/tree order
    // correctly alternates question then answer.
    const realConversationExcerpt: CapturedMessage[] = [
      { ...captured('m-1', 'user', 'Spine Leaf是不是就是Clos?', 0), timestamp: '2026-06-29T07:47:58.224Z' },
      { ...captured('m-2', 'assistant', 'Spine-Leaf 是 Clos 的一种实现', 1), timestamp: '2026-06-29T07:47:58.221Z' },
      { ...captured('m-3', 'user', 'fat tree是不是也是clos？', 2), timestamp: '2026-06-29T07:49:29.329Z' },
      { ...captured('m-4', 'assistant', 'Fat Tree 也是 Clos 的一种', 3), timestamp: '2026-06-29T07:49:29.324Z' },
      { ...captured('m-5', 'user', '为什么clos不阻塞', 4), timestamp: '2026-06-29T08:30:59.346Z' },
      { ...captured('m-6', 'assistant', 'Clos 通过充足的中间级路径实现不阻塞', 5), timestamp: '2026-06-29T08:30:59.342Z' },
    ]

    expect(orderCapturedMessages(realConversationExcerpt).map((item) => item.content)).toEqual([
      'Spine Leaf是不是就是Clos?',
      'Spine-Leaf 是 Clos 的一种实现',
      'fat tree是不是也是clos？',
      'Fat Tree 也是 Clos 的一种',
      '为什么clos不阻塞',
      'Clos 通过充足的中间级路径实现不阻塞',
    ])
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

  it('rebuilds the selected DeepSeek branch from parent ids when the API array is newest-page-first', () => {
    const payload = {
      data: {
        chat_session: { id: 'clos-session', title: 'Spine Leaf与Clos关系', current_message_id: 'm-6' },
        chat_messages: [
          message('m-5', 'user', '为什么clos不阻塞', { parent_id: 'm-4' }),
          message('m-6', 'assistant', '因为存在足够的中间级路径', { parent_id: 'm-5' }),
          message('m-3', 'user', 'fat tree是不是也是clos？', { parent_id: 'm-2' }),
          message('m-4', 'assistant', 'Fat Tree也是Clos的一种', { parent_id: 'm-3' }),
          message('m-1', 'user', 'Spine Leaf是不是就是Clos?', { parent_id: null }),
          message('m-2', 'assistant', 'Spine-Leaf是Clos的一种实现', { parent_id: 'm-1' }),
        ],
      },
    }
    const snapshot = extractConversationSnapshots(payload)[0]
    expect(snapshot?.currentMessageId).toBe('m-6')
    expect(selectConversationPath(snapshot?.messages ?? [], snapshot?.currentMessageId).map((item) => item.content)).toEqual([
      'Spine Leaf是不是就是Clos?',
      'Spine-Leaf是Clos的一种实现',
      'fat tree是不是也是clos？',
      'Fat Tree也是Clos的一种',
      '为什么clos不阻塞',
      '因为存在足够的中间级路径',
    ])
  })

  it('exports only the branch selected by current_message_id after regeneration', () => {
    const messages: CapturedMessage[] = [
      { ...captured('m-1', 'user', '问题', 0), parentId: null },
      { ...captured('m-2-old', 'assistant', '旧回答', 1), parentId: 'm-1' },
      { ...captured('m-2-new', 'assistant', '重新生成的回答', 2), parentId: 'm-1' },
      { ...captured('m-3', 'user', '基于新回答的追问', 3), parentId: 'm-2-new' },
      { ...captured('m-4', 'assistant', '后续回答', 4), parentId: 'm-3' },
    ]
    expect(selectConversationPath(messages, 'm-4').map((item) => item.content)).toEqual([
      '问题',
      '重新生成的回答',
      '基于新回答的追问',
      '后续回答',
    ])
  })

  it('preserves array order for providers that do not expose a parent chain', () => {
    const messages = [
      captured('m-2', 'assistant', '页面当前顺序第一条', 0),
      captured('m-1', 'user', '页面当前顺序第二条', 1),
    ]
    expect(selectConversationPath(messages).map((item) => item.content)).toEqual(['页面当前顺序第一条', '页面当前顺序第二条'])
  })
})
