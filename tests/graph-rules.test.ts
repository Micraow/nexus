import { describe, expect, it } from 'vitest'
import type { ConceptRelation } from '@/types/domain'
import { wouldCreateHierarchyCycle } from '@/utils/graph-rules'

function relation(parentId: string, childId: string, extra: Partial<ConceptRelation> = {}): ConceptRelation {
  return {
    id: `relation_${parentId}_${childId}`,
    parentConceptId: parentId,
    childConceptId: childId,
    relationType: 'hierarchy',
    source: 'manual',
    status: 'confirmed',
    createdAt: '',
    updatedAt: '',
    ...extra,
  }
}

describe('wouldCreateHierarchyCycle', () => {
  const relations = [
    relation('rdma', 'rdma_congestion'),
    relation('congestion_control', 'rdma_congestion'),
    relation('rdma_congestion', 'ecn'),
  ]

  it('detects direct self loops', () => {
    expect(wouldCreateHierarchyCycle('a', 'a', [])).toBe(true)
  })

  it('detects cycles through multiple hops', () => {
    expect(wouldCreateHierarchyCycle('ecn', 'rdma', relations)).toBe(true)
  })

  it('allows multi-parent DAG edges that do not close a loop', () => {
    expect(wouldCreateHierarchyCycle('pfc', 'rdma_congestion', relations)).toBe(false)
    expect(wouldCreateHierarchyCycle('congestion_control', 'dcqcn', relations)).toBe(false)
  })

  it('ignores related edges but counts proposed hierarchy proposals', () => {
    const withRelated = [...relations, { ...relation('ecn', 'pfc'), relationType: 'related' as const }]
    expect(wouldCreateHierarchyCycle('pfc', 'ecn', withRelated)).toBe(false)
    const withProposed = [...relations, relation('ecn', 'rdma', { status: 'proposed' })]
    expect(wouldCreateHierarchyCycle('rdma', 'ecn', withProposed)).toBe(true)
  })

  it('ignores rejected relations', () => {
    const withRejected = [...relations, relation('ecn', 'rdma', { status: 'rejected' })]
    expect(wouldCreateHierarchyCycle('rdma', 'ecn', withRejected)).toBe(false)
  })
})
