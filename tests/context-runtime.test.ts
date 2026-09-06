import { describe, expect, it } from 'vitest'
import type { Message } from '@/types/domain'
import { buildWorkingMemory, formatEvidenceCards, indexEvidence, searchEvidence } from '@/services/context-runtime'

const message = (id: string, content: string): Message => ({ id, sessionId: 's1', unitId: null, role: 'user', content, orderInSession: 0, timestamp: null, metadata: null })

describe('context runtime', () => {
  it('indexes long messages with stable offsets and hashes', () => {
    const chunks = indexEvidence([message('m1', 'a'.repeat(1300))], 100)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks[0]).toMatchObject({ id: 'm1:chunk:0', charStart: 0, messageId: 'm1' })
    expect(chunks.at(-1)?.charEnd).toBe(1300)
    expect(chunks.every((chunk) => chunk.contentHash)).toBe(true)
  })

  it('retrieves only relevant evidence under a token budget', () => {
    const chunks = indexEvidence([message('m1', 'RDMA 拥塞控制与 ECN。'), message('m2', '无关内容')])
    const cards = searchEvidence(chunks, { query: '拥塞控制', maxTokens: 20 })
    expect(cards).toHaveLength(1)
    expect(cards[0].sourceMessageId).toBe('m1')
    expect(JSON.parse(formatEvidenceCards(cards))[0]).toMatchObject({ source_message_id: 'm1' })
  })

  it('builds bounded working memory without deleting source messages', () => {
    const memory = buildWorkingMemory({ sessionId: 's1', summary: '已有摘要', messages: [message('m1', '最近问题')], maxRecent: 1 })
    expect(memory.summary).toBe('已有摘要')
    expect(memory.sessionId).toBe('s1')
    expect(memory.revision).toBe(1)
  })
})
