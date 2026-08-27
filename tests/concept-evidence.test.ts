import { describe, expect, it } from 'vitest'
import { resolveConceptEvidence } from '@/services/concept-evidence'
import type { KnowledgeUnit, Message, MessageConcept, Session, SessionConcept, UnitConcept } from '@/types/domain'

const now = '2026-08-28T00:00:00.000Z'
const session = (id: string, updatedAt: string, deletedAt: string | null = null): Session => ({
  id, source: 'local', platform: 'local', title: id, summary: '', createdAt: now, updatedAt,
  messageCount: 0, unitCount: 0, knowledgeKind: 'unknown', knowledgeRetainInGraph: false,
  revision: 1, localOnly: false, deletedAt,
})
const message = (id: string, sessionId: string, orderInSession: number, unitId: string | null = null, conceptIds: string[] = []): Message => ({
  id, sessionId, unitId, role: orderInSession % 2 ? 'assistant' : 'user', content: id,
  orderInSession, timestamp: null, metadata: conceptIds.length ? { concept_ids: conceptIds } : null,
})
const unit = (id: string, sessionId: string): KnowledgeUnit => ({
  id, sessionId, title: id, summary: '', orderInSession: 0, status: 'ready', revision: 1,
  createdAt: now, updatedAt: now,
})
const sessionLink = (sessionId: string, conceptId: string): SessionConcept => ({ sessionId, conceptId, source: 'manual', createdAt: now })
const messageLink = (messageId: string, conceptId: string): MessageConcept => ({ messageId, conceptId, source: 'manual', createdAt: now })
const unitLink = (unitId: string, conceptId: string): UnitConcept => ({ unitId, conceptId, source: 'manual', createdAt: now })

describe('resolveConceptEvidence', () => {
  it('keeps Session, Message, and optional reading-excerpt evidence at their declared scopes', () => {
    const result = resolveConceptEvidence({
      conceptId: 'topic',
      sessions: [session('whole', '2026-08-28T03:00:00.000Z'), session('local', '2026-08-28T02:00:00.000Z'), session('excerpt', '2026-08-28T01:00:00.000Z')],
      units: [unit('whole-unit', 'whole'), unit('local-unit', 'local'), unit('excerpt-unit', 'excerpt')],
      messages: [
        message('whole-0', 'whole', 0, 'whole-unit'), message('whole-1', 'whole', 1),
        message('local-0', 'local', 0, 'local-unit'), message('local-1', 'local', 1),
        message('excerpt-0', 'excerpt', 0, 'excerpt-unit'), message('excerpt-1', 'excerpt', 1, 'excerpt-unit'),
      ],
      sessionConcepts: [sessionLink('whole', 'topic')],
      messageConcepts: [messageLink('local-1', 'topic')],
      unitConcepts: [unitLink('excerpt-unit', 'topic')],
    })

    expect(result.sessions.map((item) => item.id)).toEqual(['whole', 'local', 'excerpt'])
    expect(result.units.map((item) => item.id)).toEqual(['whole-unit', 'excerpt-unit'])
    expect(result.messages.map((item) => item.id)).toEqual(['whole-0', 'whole-1', 'local-1', 'excerpt-0', 'excerpt-1'])
  })

  it('supports legacy Message metadata and excludes archived Session evidence', () => {
    const result = resolveConceptEvidence({
      conceptId: 'topic',
      sessions: [session('active', '2026-08-28T00:00:00.000Z'), session('archived', '2026-08-29T00:00:00.000Z', now)],
      units: [],
      messages: [message('active-message', 'active', 0, null, ['topic']), message('archived-message', 'archived', 0, null, ['topic'])],
      sessionConcepts: [sessionLink('archived', 'topic')],
      messageConcepts: [],
      unitConcepts: [],
    })

    expect(result.sessions.map((item) => item.id)).toEqual(['active'])
    expect(result.messages.map((item) => item.id)).toEqual(['active-message'])
  })
})
