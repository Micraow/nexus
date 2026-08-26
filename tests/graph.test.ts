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

  it('keeps one-off co-occurrence edges so concepts in one unit remain connected', () => {
    const snapshot = buildGraph({
      concepts: [
        { id: 'c1', name: 'A', normalizedName: 'A', notes: '', status: 'active', createdAt: now, updatedAt: now },
        { id: 'c2', name: 'B', normalizedName: 'B', notes: '', status: 'active', createdAt: now, updatedAt: now },
      ],
      units: [{ id: 'u1', sessionId: 's', title: 'U1', summary: '', orderInSession: 0, status: 'ready', revision: 1, createdAt: now, updatedAt: now }],
      messages: [],
      unitConcepts: [
        { unitId: 'u1', conceptId: 'c1', source: 'llm', createdAt: now },
        { unitId: 'u1', conceptId: 'c2', source: 'llm', createdAt: now },
      ],
      relations: [],
      revision: 1,
    })
    expect(snapshot.edges.filter((edge) => edge.type === 'co_occurrence')).toHaveLength(1)
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

  it('shows unclassified imported sessions in the unarchived view', () => {
    const input = {
      concepts: [], units: [], unitConcepts: [], relations: [], revision: 1,
      messages: [
        { id: 'm1', sessionId: 's', role: 'user' as const, content: '原始问题', orderInSession: 0 },
        { id: 'm2', sessionId: 's', role: 'assistant' as const, content: '原始回答', orderInSession: 1 },
      ],
      sessions: [{ id: 's', source: 'chrome_import' as const, platform: 'deepseek', title: '待分类', createdAt: now, updatedAt: now, messageCount: 2, unitCount: 0, knowledgeKind: 'unknown' as const, knowledgeRetainInGraph: false, revision: 1, localOnly: false }],
    }
    const snapshot = buildGraph({ ...input, showRetainedSessions: true })
    expect(snapshot.nodes.filter((node) => node.type === 'message')).toHaveLength(2)
    expect(snapshot.edges.filter((edge) => edge.type === 'conversation')).toHaveLength(1)
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

  it('expands a selected concept through its unit to assigned messages', () => {
    const snapshot = buildGraph({
      concepts: [{ id: 'c1', name: '主题', normalizedName: '主题', notes: '', status: 'active', createdAt: now, updatedAt: now }],
      units: [{ id: 'u1', sessionId: 's', title: '单元', summary: '', orderInSession: 0, status: 'ready', revision: 1, createdAt: now, updatedAt: now }],
      messages: [{ id: 'm1', sessionId: 's', unitId: 'u1', role: 'assistant', content: '回答', orderInSession: 0 }],
      unitConcepts: [{ unitId: 'u1', conceptId: 'c1', source: 'llm', createdAt: now }],
      relations: [],
      revision: 1,
      expandedConceptIds: ['c1'],
    })
    expect(snapshot.nodes.some((node) => node.id === 'unit:u1')).toBe(true)
    expect(snapshot.nodes.some((node) => node.id === 'message:m1')).toBe(true)
  })

  it('shows only hierarchy roots by default and keeps related edges out of the hierarchy', () => {
    const concepts = [
      { id: 'root', name: '根', normalizedName: '根', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'child', name: '子', normalizedName: '子', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'other', name: '另一根', normalizedName: '另一根', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({
      concepts,
      units: [],
      messages: [],
      unitConcepts: [],
      relations: [
        { id: 'h', parentConceptId: 'root', childConceptId: 'child', relationType: 'hierarchy', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now },
        { id: 'r', parentConceptId: 'child', childConceptId: 'other', relationType: 'related', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now },
      ],
      revision: 1,
    })
    expect(snapshot.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual(['root', 'other'])
    expect(snapshot.edges.some((edge) => edge.type === 'hierarchy')).toBe(false)
    expect(snapshot.edges.filter((edge) => edge.type === 'related')).toHaveLength(1)
  })

  it('reveals one hierarchy level per expanded ancestor', () => {
    const concepts = [
      { id: 'r', name: '根', normalizedName: '根', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'c', name: '子', normalizedName: '子', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'g', name: '孙', normalizedName: '孙', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const relations = [
      { id: 'h1', parentConceptId: 'r', childConceptId: 'c', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'h2', parentConceptId: 'c', childConceptId: 'g', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
    ]
    const root = buildGraph({ concepts, units: [], messages: [], unitConcepts: [], relations, revision: 1 })
    expect(root.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual(['r'])
    const levelTwo = buildGraph({ concepts, units: [], messages: [], unitConcepts: [], relations, revision: 1, expandedConceptIds: ['r'] })
    expect(levelTwo.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual(['r', 'c'])
    expect(levelTwo.edges.filter((edge) => edge.type === 'hierarchy')).toHaveLength(1)
    const levelThree = buildGraph({ concepts, units: [], messages: [], unitConcepts: [], relations, revision: 1, expandedConceptIds: ['r', 'c'] })
    expect(levelThree.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual(['r', 'c', 'g'])
    expect(levelThree.edges.filter((edge) => edge.type === 'hierarchy')).toHaveLength(2)
  })

  it('aggregates hidden leaf co-occurrence into visible roots', () => {
    const concepts = [
      { id: 'a', name: 'A', normalizedName: 'A', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'a1', name: 'A1', normalizedName: 'A1', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'a2', name: 'A2', normalizedName: 'A2', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'b', name: 'B', normalizedName: 'B', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'b1', name: 'B1', normalizedName: 'B1', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const units = ['u1', 'u2'].map((id, index) => ({ id, sessionId: 's', title: id, summary: '', orderInSession: index, status: 'ready' as const, revision: 1, createdAt: now, updatedAt: now }))
    const relations = [
      { id: 'ha1', parentConceptId: 'a', childConceptId: 'a1', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'ha2', parentConceptId: 'a', childConceptId: 'a2', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'hb1', parentConceptId: 'b', childConceptId: 'b1', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
    ]
    const unitConcepts = [
      { unitId: 'u1', conceptId: 'a1', source: 'llm' as const, createdAt: now },
      { unitId: 'u1', conceptId: 'b1', source: 'llm' as const, createdAt: now },
      { unitId: 'u2', conceptId: 'a2', source: 'llm' as const, createdAt: now },
      { unitId: 'u2', conceptId: 'b1', source: 'llm' as const, createdAt: now },
    ]
    const collapsed = buildGraph({ concepts, units, messages: [], unitConcepts, relations, revision: 1 })
    expect(collapsed.edges.find((edge) => edge.type === 'co_occurrence')?.id).toContain('concept:a|concept:b')
    expect(collapsed.edges.find((edge) => edge.type === 'co_occurrence')?.weight).toBe(2)
    const expanded = buildGraph({ concepts, units, messages: [], unitConcepts, relations, revision: 1, expandedConceptIds: ['a'] })
    expect(expanded.edges.some((edge) => edge.source === 'concept:a1' && edge.target === 'concept:b')).toBe(true)
    expect(expanded.edges.some((edge) => edge.source === 'concept:a2' && edge.target === 'concept:b')).toBe(true)
  })

  it('supports a global expansion depth without treating related edges as hierarchy', () => {
    const concepts = [
      { id: 'r', name: '根', normalizedName: '根', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'c', name: '子', normalizedName: '子', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'g', name: '孙', normalizedName: '孙', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const relations = [
      { id: 'h1', parentConceptId: 'r', childConceptId: 'c', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'h2', parentConceptId: 'c', childConceptId: 'g', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({ concepts, units: [], messages: [], unitConcepts: [], relations, revision: 1, expandedConceptDepth: 1 })
    expect(snapshot.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual(['r', 'c'])
  })
})
