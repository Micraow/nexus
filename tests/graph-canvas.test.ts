// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import GraphCanvas from '@/components/GraphCanvas.vue'
import type { GraphSnapshot } from '@/types/domain'

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub)
Object.defineProperty(SVGSVGElement.prototype, 'viewBox', {
  configurable: true,
  get: () => ({ baseVal: { x: 0, y: 0, width: 800, height: 600 } }),
})

const mounted: Array<ReturnType<typeof createApp>> = []

afterEach(() => {
  mounted.splice(0).forEach((app) => {
    try { app.unmount() } catch { /* mount may fail before Vue registers it */ }
  })
  document.body.innerHTML = ''
})

function mountGraph(listeners: Record<string, (...args: unknown[]) => void> = {}, hasChildren = true): HTMLElement {
  const snapshot: GraphSnapshot = {
    revision: 1,
    nodes: [{
      id: 'concept:root',
      type: 'concept',
      refId: 'root',
      label: '根主题',
      degree: 0,
      unitCount: 1,
      hasChildren,
      expanded: false,
    }],
    edges: [],
  }
  const target = document.createElement('div')
  Object.defineProperties(target, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  })
  document.body.appendChild(target)
  const app = createApp(GraphCanvas, { snapshot, reducedMotion: true, ...listeners })
  mounted.push(app)
  app.mount(target)
  return target
}

describe('GraphCanvas progressive disclosure', () => {
  it('selects and toggles an expandable Concept from its body', async () => {
    const selectConcept = vi.fn()
    const toggleConcept = vi.fn()
    const target = mountGraph({ onSelectConcept: selectConcept, onToggleConcept: toggleConcept })
    await nextTick()

    const node = target.querySelector<SVGGElement>('.graph-node')!
    expect(target.querySelector('svg')?.getAttribute('role')).toBe('group')
    expect(node.getAttribute('role')).toBe('button')
    expect(node.getAttribute('transform')).toMatch(/^translate\(/)
    expect(node.getAttribute('aria-expanded')).toBe('false')
    expect(target.querySelector('.graph-node-expand-control')).toBeNull()
    expect(target.querySelector('.graph-node-expand-toggle')).toBeNull()
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(selectConcept).toHaveBeenCalledWith('root')
    expect(toggleConcept).toHaveBeenCalledWith('root', true)

    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(selectConcept).toHaveBeenCalledTimes(2)
    expect(toggleConcept).toHaveBeenNthCalledWith(2, 'root', true)

    node.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(selectConcept).toHaveBeenCalledTimes(3)
    expect(toggleConcept).toHaveBeenNthCalledWith(3, 'root', true)
  })

  it('only opens details when the selected Concept is a leaf', async () => {
    const selectConcept = vi.fn()
    const toggleConcept = vi.fn()
    const target = mountGraph({ onSelectConcept: selectConcept, onToggleConcept: toggleConcept }, false)
    await nextTick()

    const node = target.querySelector<SVGGElement>('.graph-node')!
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(selectConcept).toHaveBeenCalledWith('root')
    expect(toggleConcept).not.toHaveBeenCalled()

    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(selectConcept).toHaveBeenCalledTimes(2)
    expect(toggleConcept).not.toHaveBeenCalled()
  })
})
