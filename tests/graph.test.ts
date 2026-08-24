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
})
