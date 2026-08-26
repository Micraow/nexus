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

function mountGraph(listeners: Record<string, (...args: unknown[]) => void> = {}): HTMLElement {
  const snapshot: GraphSnapshot = {
    revision: 1,
    nodes: [{
      id: 'concept:root',
      type: 'concept',
      refId: 'root',
      label: '根主题',
      degree: 0,
      unitCount: 1,
      hasChildren: true,
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
  it('keeps concept selection separate from explicit expansion', async () => {
    const selectConcept = vi.fn()
    const toggleConcept = vi.fn()
    const target = mountGraph({ onSelectConcept: selectConcept, onToggleConcept: toggleConcept })
    await nextTick()

    const expandControl = target.querySelector<SVGGElement>('.graph-node-expand-control')
    expect(expandControl).not.toBeNull()
    expandControl!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(toggleConcept).toHaveBeenCalledWith('root', true)
    expect(selectConcept).not.toHaveBeenCalled()

    target.querySelector<SVGGElement>('.graph-node')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(selectConcept).toHaveBeenCalledWith('root')
    expect(toggleConcept).toHaveBeenCalledTimes(1)
  })
})
