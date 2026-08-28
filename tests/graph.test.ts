import { describe, expect, it } from 'vitest'
import { buildGraph, cleanGraphText, deriveConceptRelatedPairs, graphSnapshotIsProgressiveCompatible, graphViewFallbackIsCompatible, toggleExpandedConceptIds } from '@/services/graph'

const now = '2026-08-24T00:00:00.000Z'

describe('derived graph', () => {
  it('cleans presentation markup from non-Markdown graph labels', () => {
    expect(cleanGraphText('## [[nexus:existing:RoCE]]RoCE[[/nexus]] · `token`')).toBe('RoCE · token')
  })

  it('encodes direct hierarchy child count on Concept nodes', () => {
    const snapshot = buildGraph({
      concepts: [
        { id: 'root', name: '根', normalizedName: '根', notes: '', status: 'active', createdAt: now, updatedAt: now },
        { id: 'c1', name: '子一', normalizedName: '子一', notes: '', status: 'active', createdAt: now, updatedAt: now },
        { id: 'c2', name: '子二', normalizedName: '子二', notes: '', status: 'active', createdAt: now, updatedAt: now },
      ],
      units: [], messages: [], unitConcepts: [], revision: 1,
      relations: [
        { id: 'h1', parentConceptId: 'root', childConceptId: 'c1', relationType: 'hierarchy', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now },
        { id: 'h2', parentConceptId: 'root', childConceptId: 'c2', relationType: 'hierarchy', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now },
      ],
    })
    expect(snapshot.nodes.find((node) => node.refId === 'root')?.childCount).toBe(2)
  })
  it('never reuses a more disclosed or differently filtered Worker snapshot', () => {
    expect(graphViewFallbackIsCompatible(
      { expandedConceptIds: [] },
      { expandedConceptIds: ['root'] },
    )).toBe(true)
    expect(graphViewFallbackIsCompatible(
      { expandedConceptIds: ['root', 'child'] },
      { expandedConceptIds: ['root'] },
    )).toBe(false)
    expect(graphViewFallbackIsCompatible(
      { expandedConceptIds: ['root'], showProposed: true },
      { expandedConceptIds: ['root'], showProposed: false },
    )).toBe(false)
    expect(graphViewFallbackIsCompatible(
      { expandedConceptIds: ['root'], showMessages: true },
      { expandedConceptIds: ['root'], showMessages: false },
    )).toBe(false)
  })

  it('rejects a cached snapshot that leaks descendants into a roots-only view', () => {
    const snapshot = buildGraph({
      concepts: [
        { id: 'root', name: '根', normalizedName: '根', notes: '', status: 'active', createdAt: now, updatedAt: now },
        { id: 'child', name: '子', normalizedName: '子', notes: '', status: 'active', createdAt: now, updatedAt: now },
      ],
      units: [], messages: [], unitConcepts: [],
      relations: [{ id: 'h', parentConceptId: 'root', childConceptId: 'child', relationType: 'hierarchy', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now }],
      revision: 1,
      expandedConceptIds: ['root'],
    })
    expect(graphSnapshotIsProgressiveCompatible(snapshot, { expandedConceptIds: [] })).toBe(false)
    expect(graphSnapshotIsProgressiveCompatible(snapshot, { expandedConceptIds: ['root'] })).toBe(true)
  })

  it('uses hierarchy parent references over stale depth values when checking snapshots', () => {
    const snapshot = buildGraph({
      concepts: [
        { id: 'root', name: '根', normalizedName: '根', notes: '', status: 'active', createdAt: now, updatedAt: now },
        { id: 'child', name: '子', normalizedName: '子', notes: '', status: 'active', createdAt: now, updatedAt: now },
      ],
      units: [], messages: [], unitConcepts: [],
      relations: [{ id: 'h', parentConceptId: 'root', childConceptId: 'child', relationType: 'hierarchy', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now }],
      revision: 1,
      expandedConceptIds: ['root'],
    })
    const stale = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) => node.type === 'concept' && node.refId === 'child' ? { ...node, depth: 0 } : node),
    }
    expect(graphSnapshotIsProgressiveCompatible(stale, { expandedConceptIds: [] })).toBe(false)
    expect(graphSnapshotIsProgressiveCompatible(stale, { expandedConceptIds: ['root'] })).toBe(true)
  })

  it('builds concept co-occurrence with accumulated weight', () => {
    const snapshot = buildGraph({
      concepts: [
        { id: 'c1', name: 'A', normalizedName: 'A', notes: '', status: 'active', createdAt: now, updatedAt: now },
        { id: 'c2', name: 'B', normalizedName: 'B', notes: '', status: 'active', createdAt: now, updatedAt: now },
      ],
      units: [
        { id: 'u1', sessionId: 's', title: 'U1', summary: '', orderInSession: 0, status: 'ready', revision: 1, createdAt: now, updatedAt: now },
        { id: 'u2', sessionId: 's2', title: 'U2', summary: '', orderInSession: 1, status: 'ready', revision: 1, createdAt: now, updatedAt: now },
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

  it('counts Concept co-occurrence once per Session across units and direct memberships', () => {
    const concepts = [
      { id: 'a', name: 'A', normalizedName: 'A', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'b', name: 'B', normalizedName: 'B', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({
      concepts,
      sessions: [
        { id: 's1', source: 'local', platform: 'local', title: '一', createdAt: now, updatedAt: now, messageCount: 0, unitCount: 2, knowledgeKind: 'knowledge', knowledgeRetainInGraph: true, revision: 1, localOnly: true },
        { id: 's2', source: 'local', platform: 'local', title: '二', createdAt: now, updatedAt: now, messageCount: 0, unitCount: 0, knowledgeKind: 'knowledge', knowledgeRetainInGraph: true, revision: 1, localOnly: true },
      ],
      units: [
        { id: 'u1', sessionId: 's1', title: 'U1', summary: '', orderInSession: 0, status: 'ready', revision: 1, createdAt: now, updatedAt: now },
        { id: 'u2', sessionId: 's1', title: 'U2', summary: '', orderInSession: 1, status: 'ready', revision: 1, createdAt: now, updatedAt: now },
      ],
      messages: [],
      unitConcepts: [
        { unitId: 'u1', conceptId: 'a', source: 'llm', createdAt: now },
        { unitId: 'u1', conceptId: 'b', source: 'llm', createdAt: now },
        { unitId: 'u2', conceptId: 'a', source: 'llm', createdAt: now },
      ],
      sessionConcepts: [{ sessionId: 's2', conceptId: 'a', source: 'llm', createdAt: now }, { sessionId: 's2', conceptId: 'b', source: 'llm', createdAt: now }],
      relations: [],
      revision: 1,
    })
    expect(snapshot.edges.find((edge) => edge.type === 'co_occurrence')?.weight).toBe(2)
  })

  it('does not project archived Session memberships into the active graph', () => {
    const concepts = [
      { id: 'a', name: 'A', normalizedName: 'A', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'b', name: 'B', normalizedName: 'B', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({
      concepts,
      sessions: [{ id: 'active', source: 'local', platform: 'local', title: '当前', createdAt: now, updatedAt: now, messageCount: 0, unitCount: 0, knowledgeKind: 'knowledge', knowledgeRetainInGraph: true, revision: 1, localOnly: true }],
      units: [],
      messages: [],
      unitConcepts: [],
      sessionConcepts: [
        { sessionId: 'archived', conceptId: 'a', source: 'llm', createdAt: now },
        { sessionId: 'archived', conceptId: 'b', source: 'llm', createdAt: now },
      ],
      relations: [],
      revision: 1,
    })
    expect(snapshot.edges.filter((edge) => edge.type === 'co_occurrence')).toHaveLength(0)
  })

  it('keeps knowledge units behind their explicit display toggle', () => {
    const input = {
      concepts: [
        { id: 'c1', name: 'A', normalizedName: 'A', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
        { id: 'c2', name: 'A child', normalizedName: 'A CHILD', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      ],
      units: [{ id: 'u1', sessionId: 's', title: 'U1', summary: '', orderInSession: 0, status: 'ready' as const, revision: 1, createdAt: now, updatedAt: now }],
      messages: [],
      unitConcepts: [{ unitId: 'u1', conceptId: 'c2', source: 'manual' as const, createdAt: now }],
      relations: [{ id: 'h', parentConceptId: 'c1', childConceptId: 'c2', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now }],
      revision: 1,
      expandedConceptIds: ['c1'],
    }
    expect(buildGraph(input).nodes.some((node) => node.id === 'unit:u1')).toBe(false)
    expect(buildGraph({ ...input, showUnits: true }).nodes.some((node) => node.id === 'unit:u1')).toBe(true)
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
        { id: 'r1', parentConceptId: 'c1', childConceptId: 'c2', relationType: 'related', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now },
        { id: 'r2', parentConceptId: 'c2', childConceptId: 'c1', relationType: 'related', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now },
      ],
      revision: 1,
    })
    expect(snapshot.edges.filter((edge) => edge.type === 'related')).toHaveLength(1)
  })

  it('keeps messages behind their explicit display toggle when a concept expands', () => {
    const input = {
      concepts: [{ id: 'c1', name: '主题', normalizedName: '主题', notes: '', status: 'active' as const, createdAt: now, updatedAt: now }],
      units: [{ id: 'u1', sessionId: 's', title: '单元', summary: '', orderInSession: 0, status: 'ready' as const, revision: 1, createdAt: now, updatedAt: now }],
      messages: [{ id: 'm1', sessionId: 's', unitId: 'u1', role: 'assistant' as const, content: '回答', orderInSession: 0 }],
      unitConcepts: [{ unitId: 'u1', conceptId: 'c1', source: 'llm' as const, createdAt: now }],
      relations: [],
      revision: 1,
      expandedConceptIds: ['c1'],
    }
    expect(buildGraph(input).nodes.some((node) => node.id === 'message:m1')).toBe(false)
    expect(buildGraph({ ...input, showMessages: true }).nodes.some((node) => node.id === 'message:m1')).toBe(true)
  })

  it('projects multi-concept memberships from unassigned message metadata', () => {
    const concepts = [
      { id: 'c1', name: '主题一', normalizedName: '主题一', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'c2', name: '主题二', normalizedName: '主题二', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({
      concepts,
      units: [],
      messages: [{
        id: 'm1', sessionId: 's', unitId: null, role: 'user', content: '尚未分段的消息', orderInSession: 0,
        metadata: { concept_ids: ['c1', 'c2'] },
      }],
      unitConcepts: [],
      relations: [],
      revision: 1,
      expandedConceptIds: ['c1'],
      showMessages: true,
    })
    expect(snapshot.nodes.some((node) => node.id === 'message:m1')).toBe(true)
    expect(snapshot.edges.filter((edge) => edge.type === 'association' && edge.target === 'message:m1').map((edge) => edge.source).sort()).toEqual(['concept:c1', 'concept:c2'])
  })

  it('projects direct message and session memberships from join tables', () => {
    const concepts = [
      { id: 'c1', name: '消息主题', normalizedName: '消息主题', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'c2', name: '会话主题', normalizedName: '会话主题', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({
      concepts,
      units: [],
      messages: [{ id: 'm1', sessionId: 's1', unitId: null, role: 'user', content: '探讨消息', orderInSession: 0 }],
      sessions: [{ id: 's1', source: 'chrome_import', platform: 'deepseek', title: '探讨会话', createdAt: now, updatedAt: now, messageCount: 1, unitCount: 0, knowledgeKind: 'discussion', knowledgeRetainInGraph: true, revision: 1, localOnly: false }],
      unitConcepts: [],
      messageConcepts: [{ messageId: 'm1', conceptId: 'c1', source: 'llm', createdAt: now }],
      sessionConcepts: [{ sessionId: 's1', conceptId: 'c2', source: 'llm', createdAt: now }],
      relations: [],
      revision: 1,
      expandedConceptIds: ['c1'],
      showMessages: true,
    })
    expect(snapshot.nodes.some((node) => node.id === 'message:m1')).toBe(true)
    expect(snapshot.edges.filter((edge) => edge.type === 'association' && edge.target === 'message:m1').map((edge) => edge.source).sort()).toEqual(['concept:c1', 'concept:c2'])
  })

  it('keeps Unit and Session Concept edges on messages when Unit nodes are hidden', () => {
    const concepts = [
      { id: 'unit-concept', name: '单元主题', normalizedName: '单元主题', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'session-concept', name: '会话主题', normalizedName: '会话主题', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({
      concepts,
      sessions: [{ id: 's', source: 'local', platform: 'local', title: '会话', createdAt: now, updatedAt: now, messageCount: 1, unitCount: 1, knowledgeKind: 'knowledge', knowledgeRetainInGraph: true, revision: 1, localOnly: true }],
      units: [{ id: 'u', sessionId: 's', title: '单元', summary: '', orderInSession: 0, status: 'ready', revision: 1, createdAt: now, updatedAt: now }],
      messages: [{ id: 'm', sessionId: 's', unitId: 'u', role: 'assistant', content: '回答', orderInSession: 0 }],
      unitConcepts: [{ unitId: 'u', conceptId: 'unit-concept', source: 'llm', createdAt: now }],
      sessionConcepts: [{ sessionId: 's', conceptId: 'session-concept', source: 'llm', createdAt: now }],
      relations: [],
      revision: 1,
      showUnits: false,
      showMessages: true,
    })
    expect(snapshot.nodes.some((node) => node.id === 'unit:u')).toBe(false)
    expect(snapshot.edges.filter((edge) => edge.type === 'association' && edge.target === 'message:m').map((edge) => edge.source).sort()).toEqual(['concept:session-concept', 'concept:unit-concept'])
  })

  it('shows only confirmed hierarchy roots by default and keeps related edges out of the hierarchy', () => {
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

  it('excludes proposed hierarchy and related relations unless explicitly enabled', () => {
    const concepts = [
      { id: 'root', name: '根', normalizedName: '根', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'child', name: '子', normalizedName: '子', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'other', name: '另一根', normalizedName: '另一根', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const relations = [
      { id: 'h', parentConceptId: 'root', childConceptId: 'child', relationType: 'hierarchy' as const, source: 'llm' as const, status: 'proposed' as const, createdAt: now, updatedAt: now },
      { id: 'r', parentConceptId: 'child', childConceptId: 'other', relationType: 'related' as const, source: 'maintenance' as const, status: 'proposed' as const, createdAt: now, updatedAt: now },
    ]

    const hidden = buildGraph({ concepts, units: [], messages: [], unitConcepts: [], relations, revision: 1 })
    // A pending hierarchy parent still makes `child` non-root. The proposal
    // stays hidden until explicitly enabled, so only the true roots render.
    expect(hidden.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual(['root', 'other'])
    expect(hidden.edges).toHaveLength(0)

    const visible = buildGraph({
      concepts,
      units: [],
      messages: [],
      unitConcepts: [],
      relations,
      revision: 1,
      showProposed: true,
      expandedConceptIds: ['root'],
    })
    expect(visible.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual(['root', 'child', 'other'])
    expect(visible.edges.filter((edge) => edge.type === 'hierarchy')).toHaveLength(1)
    expect(visible.edges.filter((edge) => edge.type === 'related')).toHaveLength(1)
  })

  it('keeps a malformed hierarchy cycle out of the roots-only projection', () => {
    const concepts = [
      { id: 'a', name: '甲', normalizedName: '甲', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'b', name: '乙', normalizedName: '乙', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const relations = [
      { id: 'ab', parentConceptId: 'a', childConceptId: 'b', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'ba', parentConceptId: 'b', childConceptId: 'a', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({ concepts, units: [], messages: [], unitConcepts: [], relations, revision: 1 })
    expect(snapshot.nodes.filter((node) => node.type === 'concept')).toHaveLength(0)
  })

  it('ignores LLM-authored related edges and derives shared-evidence pairs', () => {
    const concepts = [
      { id: 'a', name: '甲', normalizedName: '甲', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'b', name: '乙', normalizedName: '乙', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const sessions = [
      { id: 's1', source: 'local' as const, platform: 'local', title: '一', createdAt: now, updatedAt: now, messageCount: 2, unitCount: 0, knowledgeKind: 'knowledge' as const, knowledgeRetainInGraph: true, revision: 1, localOnly: true },
      { id: 's2', source: 'local' as const, platform: 'local', title: '二', createdAt: now, updatedAt: now, messageCount: 1, unitCount: 0, knowledgeKind: 'knowledge' as const, knowledgeRetainInGraph: true, revision: 1, localOnly: true },
    ]
    const messages = [
      { id: 'm1', sessionId: 's1', unitId: null, role: 'user' as const, content: '甲乙', orderInSession: 0, metadata: { concept_ids: ['a', 'b'] } },
      { id: 'm2', sessionId: 's1', unitId: null, role: 'assistant' as const, content: '甲乙', orderInSession: 1, metadata: { concept_ids: ['a', 'b'] } },
      { id: 'm3', sessionId: 's2', unitId: null, role: 'user' as const, content: '甲乙', orderInSession: 0, metadata: { concept_ids: ['a', 'b'] } },
    ]
    const derived = deriveConceptRelatedPairs({ concepts, sessions, units: [], messages, unitConcepts: [], sessionConcepts: [], messageConcepts: [] })
    expect(derived).toEqual([{ leftConceptId: 'a', rightConceptId: 'b', sessionCount: 2, messageCount: 3 }])
    const snapshot = buildGraph({ concepts, sessions, units: [], messages, unitConcepts: [], sessionConcepts: [], messageConcepts: [], relations: [{ id: 'r', parentConceptId: 'a', childConceptId: 'b', relationType: 'related', source: 'llm', status: 'confirmed', createdAt: now, updatedAt: now }], revision: 1 })
    expect(snapshot.edges.filter((edge) => edge.type === 'related')).toHaveLength(0)
    expect(snapshot.edges.find((edge) => edge.type === 'co_occurrence')?.weight).toBe(2)
  })

  it('does not leak a proposed child when stale expansion state is present', () => {
    const concepts = [
      { id: 'root', name: '根', normalizedName: '根', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'child', name: '待确认子主题', normalizedName: '待确认子主题', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const relations = [{ id: 'h', parentConceptId: 'root', childConceptId: 'child', relationType: 'hierarchy' as const, source: 'llm' as const, status: 'proposed' as const, createdAt: now, updatedAt: now }]
    const snapshot = buildGraph({ concepts, units: [], messages: [], unitConcepts: [], relations, revision: 1, expandedConceptIds: ['child'] })
    expect(snapshot.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual(['root'])
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

  it('aggregates hidden descendant co-occurrence once per Session into visible roots', () => {
    const concepts = [
      { id: 'a', name: 'A', normalizedName: 'A', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'a1', name: 'A1', normalizedName: 'A1', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'a2', name: 'A2', normalizedName: 'A2', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'b', name: 'B', normalizedName: 'B', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'b1', name: 'B1', normalizedName: 'B1', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const units = [
      { id: 'u1', sessionId: 's1', title: 'u1', summary: '', orderInSession: 0, status: 'ready' as const, revision: 1, createdAt: now, updatedAt: now },
      { id: 'u2', sessionId: 's1', title: 'u2', summary: '', orderInSession: 1, status: 'ready' as const, revision: 1, createdAt: now, updatedAt: now },
    ]
    const relations = [
      { id: 'ha1', parentConceptId: 'a', childConceptId: 'a1', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'ha2', parentConceptId: 'a', childConceptId: 'a2', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'hb1', parentConceptId: 'b', childConceptId: 'b1', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
    ]
    const unitConcepts = [
      { unitId: 'u1', conceptId: 'a1', source: 'llm' as const, createdAt: now },
      { unitId: 'u1', conceptId: 'b1', source: 'llm' as const, createdAt: now },
      { unitId: 'u2', conceptId: 'a1', source: 'llm' as const, createdAt: now },
      { unitId: 'u2', conceptId: 'b1', source: 'llm' as const, createdAt: now },
    ]
    const sessionConcepts = [
      { sessionId: 's2', conceptId: 'a2', source: 'llm' as const, createdAt: now },
      { sessionId: 's2', conceptId: 'b1', source: 'llm' as const, createdAt: now },
      { sessionId: 's3', conceptId: 'a1', source: 'llm' as const, createdAt: now },
    ]
    const collapsed = buildGraph({ concepts, units, messages: [], unitConcepts, sessionConcepts, relations, revision: 1 })
    expect(collapsed.edges.find((edge) => edge.type === 'co_occurrence')?.id).toContain('concept:a|concept:b')
    expect(collapsed.edges.find((edge) => edge.type === 'co_occurrence')?.weight).toBe(2)
    const expanded = buildGraph({ concepts, units, messages: [], unitConcepts, sessionConcepts, relations, revision: 1, expandedConceptIds: ['a'] })
    const hasPair = (left: string, right: string) => expanded.edges.some((edge) => edge.type === 'co_occurrence' && new Set([edge.source, edge.target]).has(left) && new Set([edge.source, edge.target]).has(right))
    expect(hasPair('concept:a1', 'concept:b')).toBe(true)
    expect(hasPair('concept:a2', 'concept:b')).toBe(true)
  })

  it('projects a hidden multi-parent Concept to the first visible ancestor on each branch', () => {
    const concepts = [
      { id: 'r1', name: '根一', normalizedName: '根一', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'r2', name: '根二', normalizedName: '根二', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'bridge', name: '桥', normalizedName: '桥', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'leaf', name: '叶', normalizedName: '叶', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'other', name: '其他', normalizedName: '其他', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const relations = [
      { id: 'h1', parentConceptId: 'r1', childConceptId: 'leaf', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'h2', parentConceptId: 'bridge', childConceptId: 'leaf', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'h3', parentConceptId: 'r2', childConceptId: 'bridge', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({
      concepts,
      units: [],
      messages: [],
      unitConcepts: [],
      sessionConcepts: [
        { sessionId: 's', conceptId: 'leaf', source: 'llm', createdAt: now },
        { sessionId: 's', conceptId: 'other', source: 'llm', createdAt: now },
      ],
      relations,
      revision: 1,
    })
    const hasPair = (left: string, right: string) => snapshot.edges.some((edge) => edge.type === 'co_occurrence' && new Set([edge.source, edge.target]).has(left) && new Set([edge.source, edge.target]).has(right))
    expect(hasPair('concept:r1', 'concept:other')).toBe(true)
    expect(hasPair('concept:r2', 'concept:other')).toBe(true)
  })

  it('does not create co-occurrence between roots from one multi-parent Concept alone', () => {
    const concepts = [
      { id: 'r1', name: '根一', normalizedName: '根一', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'r2', name: '根二', normalizedName: '根二', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
      { id: 'leaf', name: '共享子主题', normalizedName: '共享子主题', notes: '', status: 'active' as const, createdAt: now, updatedAt: now },
    ]
    const relations = [
      { id: 'h1', parentConceptId: 'r1', childConceptId: 'leaf', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'h2', parentConceptId: 'r2', childConceptId: 'leaf', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
    ]
    const snapshot = buildGraph({
      concepts,
      units: [],
      messages: [],
      unitConcepts: [],
      sessionConcepts: [{ sessionId: 's', conceptId: 'leaf', source: 'llm', createdAt: now }],
      relations,
      revision: 1,
    })
    expect(snapshot.edges.filter((edge) => edge.type === 'co_occurrence')).toHaveLength(0)
  })

  it('collapsing an ancestor removes every expanded descendant but keeps other branches', () => {
    const relations = [
      { id: 'h1', parentConceptId: 'r', childConceptId: 'c', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'h2', parentConceptId: 'c', childConceptId: 'g', relationType: 'hierarchy' as const, source: 'llm' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'h3', parentConceptId: 'x', childConceptId: 'y', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
    ]
    expect(toggleExpandedConceptIds(['r', 'c', 'g', 'x'], 'r', relations, false).sort()).toEqual(['x'])
  })

  it('uses the same proposed-relation boundary when collapsing disclosure state', () => {
    const relations = [
      { id: 'h1', parentConceptId: 'r', childConceptId: 'c', relationType: 'hierarchy' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
      { id: 'h2', parentConceptId: 'c', childConceptId: 'g', relationType: 'hierarchy' as const, source: 'llm' as const, status: 'proposed' as const, createdAt: now, updatedAt: now },
      { id: 'related', parentConceptId: 'c', childConceptId: 'x', relationType: 'related' as const, source: 'manual' as const, status: 'confirmed' as const, createdAt: now, updatedAt: now },
    ]
    expect(toggleExpandedConceptIds(['r', 'c', 'g', 'x'], 'r', relations, false).sort()).toEqual(['x'])
    expect(toggleExpandedConceptIds(['r', 'c', 'g', 'x'], 'r', relations, false, true).sort()).toEqual(['x'])
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
