import { describe, expect, it } from 'vitest'
import { buildGraph } from '@/services/graph'

const now = '2026-08-24T00:00:00.000Z'

describe('derived graph', () => {
  it('builds concept co-occurrence with accumulated weight', () => {
    const snapshot = buildGraph({
      concepts: [
        { id: 'c1', name: 'A', normalizedName: 'A', notes: '', status: 'active', createdAt: now, updatedAt: now },
        { id: 'c2', name: 'B', normalizedName: 'B', notes: '', status: 'active', createdAt: now, updatedAt: now },
      ],
      units: [
        { id: 'u1', sessionId: 's', title: 'U1', summary: '', orderInSession: 0, status: 'ready', revision: 1, createdAt: now, updatedAt: now },
        { id: 'u2', sessionId: 's', title: 'U2', summary: '', orderInSession: 1, status: 'ready', revision: 1, createdAt: now, updatedAt: now },
      ],
      messages: [],
      unitConcepts: [
        { unitId: 'u1', conceptId: 'c1', source: 'manual', createdAt: now },
        { unitId: 'u1', conceptId: 'c2', source: 'manual', createdAt: now },
        { unitId: 'u2', conceptId: 'c1', source: 'manual', createdAt: now },
        { unitId: 'u2', conceptId: 'c2', source: 'manual', createdAt: now },
      ],
      relations: [],
      revision: 4,
    })
    const coOccurrence = snapshot.edges.find((edge) => edge.type === 'co_occurrence')
    expect(coOccurrence?.weight).toBe(2)
    expect(snapshot.nodes.filter((node) => node.type === 'concept')).toHaveLength(2)
  })

  it('shows expanded units for one concept without globally enabling units', () => {
    const snapshot = buildGraph({
      concepts: [{ id: 'c1', name: 'A', normalizedName: 'A', notes: '', status: 'active', createdAt: now, updatedAt: now }],
      units: [{ id: 'u1', sessionId: 's', title: 'U1', summary: '', orderInSession: 0, status: 'ready', revision: 1, createdAt: now, updatedAt: now }],
      messages: [],
      unitConcepts: [{ unitId: 'u1', conceptId: 'c1', source: 'manual', createdAt: now }],
      relations: [],
      revision: 1,
      expandedConceptIds: ['c1'],
    })
    expect(snapshot.nodes.some((node) => node.id === 'unit:u1')).toBe(true)
  })

  it('keeps assigned messages visible and connects a session into an ordered chain', () => {
    const snapshot = buildGraph({
      concepts: [],
      units: [{ id: 'u1', sessionId: 's', title: 'U1', summary: '', orderInSession: 0, status: 'ready', revision: 1, createdAt: now, updatedAt: now }],
      messages: [
        { id: 'm1', sessionId: 's', unitId: 'u1', role: 'user', content: '问题', orderInSession: 0 },
        { id: 'm2', sessionId: 's', unitId: 'u1', role: 'assistant', content: '回答', orderInSession: 1 },
        { id: 'm3', sessionId: 's', unitId: null, role: 'user', content: '追问', orderInSession: 2 },
      ],
      unitConcepts: [],
      relations: [],
      revision: 1,
      showMessages: true,
    })
    expect(snapshot.nodes.filter((node) => node.type === 'message')).toHaveLength(3)
    expect(snapshot.edges.filter((edge) => edge.type === 'conversation')).toHaveLength(2)
  })

  it('shows retained exploratory sessions only when that view is enabled', () => {
    const input = {
      concepts: [], units: [], unitConcepts: [], relations: [], revision: 1,
      messages: [{ id: 'm1', sessionId: 's', role: 'user' as const, content: '选题讨论', orderInSession: 0 }],
      sessions: [{ id: 's', source: 'chrome_import' as const, platform: 'deepseek', title: '讨论', createdAt: now, updatedAt: now, messageCount: 1, unitCount: 0, knowledgeKind: 'discussion' as const, knowledgeRetainInGraph: true, revision: 1, localOnly: false }],
    }
    expect(buildGraph(input).nodes).toHaveLength(0)
    expect(buildGraph({ ...input, showRetainedSessions: true }).nodes).toHaveLength(1)
  })

  it('treats related concept edges as undirected', () => {
    const concepts = [
      { id: 'c1', name: '甲', normalizedName: '甲', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'c2', name: '乙', normalizedName: '乙', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({
      concepts,
      units: [],
      messages: [],
      unitConcepts: [],
      relations: [
        { id: 'r1', parentConceptId: 'c1', childConceptId: 'c2', relationType: 'related', source: 'llm', status: 'confirmed', createdAt: now, updatedAt: now },
        { id: 'r2', parentConceptId: 'c2', childConceptId: 'c1', relationType: 'related', source: 'llm', status: 'confirmed', createdAt: now, updatedAt: now },
      ],
      revision: 1,
    })
    expect(snapshot.edges.filter((edge) => edge.type === 'related')).toHaveLength(1)
  })
})
