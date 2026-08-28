// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import ConceptTree from '@/components/ConceptTree.vue'
import type { Concept, ConceptRelation } from '@/types/domain'

const now = '2026-08-28T00:00:00.000Z'
const concepts: Concept[] = [
  { id: 'root', name: '根主题', normalizedName: '根主题', notes: '', status: 'active', createdAt: now, updatedAt: now },
  { id: 'child', name: '子主题', normalizedName: '子主题', notes: '', status: 'active', createdAt: now, updatedAt: now },
]

const mounted: Array<ReturnType<typeof createApp>> = []

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount())
  document.body.innerHTML = ''
})

function mountTree(relations: ConceptRelation[], expandedIds: string[] = []): HTMLElement {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = createApp(ConceptTree, { concepts, relations, expandedIds })
  mounted.push(app)
  app.mount(target)
  return target
}

describe('ConceptTree hierarchy', () => {
  it('keeps proposed hierarchy in the tree while exposing its review badge', async () => {
    const target = mountTree([{
      id: 'proposal',
      parentConceptId: 'root',
      childConceptId: 'child',
      relationType: 'hierarchy',
      source: 'llm',
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
    }], ['root'])
    await nextTick()

    expect(target.querySelectorAll(':scope > .concept-tree > .concept-tree-branch')).toHaveLength(1)
    expect(target.querySelectorAll('.concept-tree-children')).toHaveLength(1)
    expect(target.querySelector('.concept-tree-children .concept-tree-label')?.textContent).toBe('子主题')
    expect(target.querySelectorAll('.concept-tree-proposed')).toHaveLength(1)
  })

  it('nests only confirmed children after their parent branch is expanded', async () => {
    const target = mountTree([{
      id: 'confirmed',
      parentConceptId: 'root',
      childConceptId: 'child',
      relationType: 'hierarchy',
      source: 'manual',
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    }], ['root'])
    await nextTick()

    expect(target.querySelectorAll(':scope > .concept-tree > .concept-tree-branch')).toHaveLength(1)
    expect(target.querySelector('.concept-tree-children .concept-tree-label')?.textContent).toBe('子主题')
  })

  it('does not treat related edges as hierarchy or hide a root', async () => {
    const target = mountTree([{
      id: 'related',
      parentConceptId: 'root',
      childConceptId: 'child',
      relationType: 'related',
      source: 'manual',
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    }])
    await nextTick()

    expect([...target.querySelectorAll('.concept-tree-label')].map((label) => label.textContent)).toEqual(['根主题', '子主题'])
    expect(target.querySelectorAll('.concept-tree-children')).toHaveLength(0)
  })

  it('does not expose a review badge for a related proposal', async () => {
    const target = mountTree([{
      id: 'related-proposal',
      parentConceptId: 'root',
      childConceptId: 'child',
      relationType: 'related',
      source: 'maintenance',
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
    }])
    await nextTick()

    expect(target.querySelectorAll('.concept-tree-proposed')).toHaveLength(0)
    expect(target.querySelectorAll('.concept-tree-label')).toHaveLength(2)
  })
})
