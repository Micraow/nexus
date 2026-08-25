import { describe, expect, it } from 'vitest'
import { collectSessionEntries, mergeSessionEntries, sessionEntryFromUrl } from '../extension/src/session-discovery'

describe('DeepSeek session discovery', () => {
  it('finds nested history rows without treating messages as sessions', () => {
    const entries = collectSessionEntries({
      data: {
        conversations: [
          { chat_session_id: 'session-alpha-123', title: '第一段历史' },
          { id: 'session-beta-456', name: '第二段历史' },
          { id: 'message-123456', role: 'assistant', content: '不要当成会话' },
        ],
      },
    })
    expect(entries).toEqual([
      { externalSessionId: 'session-alpha-123', title: '第一段历史' },
      { externalSessionId: 'session-beta-456', title: '第二段历史' },
    ])
  })

  it('supports both current and legacy DeepSeek chat routes', () => {
    expect(sessionEntryFromUrl('https://chat.deepseek.com/a/chat/s/abc_123')).toEqual({ externalSessionId: 'abc_123', title: '' })
    expect(sessionEntryFromUrl('https://chat.deepseek.com/chat/s/xyz-789')).toEqual({ externalSessionId: 'xyz-789', title: '' })
  })

  it('keeps a network-discovered id when the DOM later supplies its title', () => {
    expect(mergeSessionEntries(
      [{ externalSessionId: 'session-alpha-123', title: '' }],
      [{ externalSessionId: 'session-alpha-123', title: '从侧边栏补全标题' }],
    )).toEqual([{ externalSessionId: 'session-alpha-123', title: '从侧边栏补全标题' }])
  })
})
