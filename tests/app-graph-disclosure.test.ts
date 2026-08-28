// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import App from '@/App.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Concept, ConceptRelation } from '@/types/domain'

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

const mounted: Array<ReturnType<typeof createApp>> = []
const now = '2026-08-29T00:00:00.000Z'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => undefined })
  Object.defineProperty(SVGSVGElement.prototype, 'viewBox', {
    configurable: true,
    get: () => ({ baseVal: { x: 0, y: 0, width: 800, height: 600 } }),
  })
})

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('App knowledge graph disclosure', () => {
  it('removes an expanded ancestor and every descendant after three node clicks', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    store.init = async () => undefined
    store.config.ui.reducedMotion = true
    store.concepts = [
      { id: 'vue', name: 'Vue', normalizedName: 'VUE', notes: '', status: 'active', createdAt: now, updatedAt: now },
      { id: 'reactivity', name: '响应式系统', normalizedName: '响应式系统', notes: '', status: 'active', createdAt: now, updatedAt: now },
      { id: 'deps', name: '依赖收集', normalizedName: '依赖收集', notes: '', status: 'active', createdAt: now, updatedAt: now },
      { id: 'scheduler', name: '调度器', normalizedName: '调度器', notes: '', status: 'active', createdAt: now, updatedAt: now },
    ] satisfies Concept[]
    store.relations = [
      { id: 'r1', parentConceptId: 'vue', childConceptId: 'reactivity', relationType: 'hierarchy', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now },
      { id: 'r2', parentConceptId: 'reactivity', childConceptId: 'deps', relationType: 'hierarchy', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now },
      { id: 'r3', parentConceptId: 'reactivity', childConceptId: 'scheduler', relationType: 'hierarchy', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now },
    ] satisfies ConceptRelation[]
    const originalToggle = store.toggleConceptExpansion
    const expansionStates: string[][] = []
    store.toggleConceptExpansion = (currentIds, conceptId, expanded, showProposed) => {
      const next = originalToggle(currentIds, conceptId, expanded, showProposed)
      expansionStates.push(next)
      return next
    }

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()
    ;[...target.querySelectorAll<HTMLButtonElement>('.nav-item')].find((button) => button.textContent?.includes('知识图谱'))!.click()
    await nextTick()

    const node = (id: string) => target.querySelector<SVGGElement>(`.graph-viewport:not(.graph-transition-old) [data-ref-id="${id}"]`)
    const clickNode = (id: string) => node(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    clickNode('vue')
    await nextTick()
    clickNode('reactivity')
    await nextTick()
    expect(node('deps')).not.toBeNull()
    expect(node('scheduler')).not.toBeNull()

    clickNode('vue')
    await nextTick()

    expect(expansionStates).toEqual([['vue'], ['vue', 'reactivity'], []])
    expect([...target.querySelectorAll<SVGGElement>('.graph-node')].map((item) => item.dataset.refId)).toEqual(['vue'])
    expect(node('vue')?.getAttribute('aria-expanded')).toBe('false')
  })
})
