// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import App from '@/App.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Concept, ConceptRelation } from '@/types/domain'

const mounted: Array<ReturnType<typeof createApp>> = []

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
})

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount())
  document.body.innerHTML = ''
})

describe('full-graph maintenance entry', () => {
  it('is discoverable on a knowledge page and disappears with its panel on unrelated pages', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    useWorkspaceStore(pinia).init = async () => undefined
    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    const navButton = (label: string) => [...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes(label))

    navButton('知识主题')!.click()
    await nextTick()
    const entry = target.querySelector<HTMLButtonElement>('.concepts-view .maintenance-entry-button')
    expect(entry?.textContent).toContain('全图知识维护')

    entry!.click()
    await nextTick()
    expect(target.querySelector('.maintenance-panel')?.textContent).toContain('扫描整个知识图谱')
    expect(target.querySelector('.maintenance-panel')?.textContent).not.toContain('优先关注：')

    navButton('设置')!.click()
    await nextTick()
    expect(target.querySelector('.maintenance-entry-button')).toBeNull()
    expect(target.querySelector('.maintenance-panel')).toBeNull()
  })

  it('confirms every proposed relation in one action while retaining row actions beforehand', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    store.init = async () => undefined
    const now = '2026-08-29T00:00:00.000Z'
    store.concepts = [
      { id: 'root', name: '根主题', normalizedName: '根主题', notes: '', status: 'active', createdAt: now, updatedAt: now },
      { id: 'child', name: '子主题', normalizedName: '子主题', notes: '', status: 'active', createdAt: now, updatedAt: now },
    ] satisfies Concept[]
    store.relations = [
      { id: 'r1', parentConceptId: 'root', childConceptId: 'child', relationType: 'hierarchy', source: 'llm', status: 'proposed', createdAt: now, updatedAt: now },
      { id: 'r2', parentConceptId: 'root', childConceptId: 'child', relationType: 'related', source: 'maintenance', status: 'proposed', createdAt: now, updatedAt: now },
    ] satisfies ConceptRelation[]
    store.confirmRelation = (relationId, status) => {
      const relation = store.relations.find((item) => item.id === relationId)
      if (relation) relation.status = status
    }

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    const tasksNav = [...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes('任务中心'))!
    tasksNav.click()
    await nextTick()

    expect(target.querySelectorAll('.pending-relation-row')).toHaveLength(2)
    expect(target.querySelectorAll('.pending-relation-row .maintenance-relation-actions .text-button')).toHaveLength(4)
    const confirmAll = target.querySelector<HTMLButtonElement>('.confirm-all-relations')!
    expect(confirmAll.textContent).toContain('确认全部 2 条关系')

    confirmAll.click()
    await nextTick()
    expect(store.relations.every((relation) => relation.status === 'confirmed')).toBe(true)
    expect(target.querySelector('.pending-relation-inbox')).toBeNull()
  })
})
