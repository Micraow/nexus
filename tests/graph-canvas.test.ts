// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive } from 'vue'
import GraphCanvas from '@/components/GraphCanvas.vue'
import type { GraphSnapshot } from '@/types/domain'

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  private target: Element | null = null

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this)
  }

  observe(target: Element): void { this.target = target }
  disconnect(): void {}

  trigger(): void {
    if (!this.target) return
    this.callback([{ target: this.target, contentRect: this.target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
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
  ResizeObserverStub.instances = []
})

function mountSnapshot(snapshot: GraphSnapshot, listeners: Record<string, (...args: unknown[]) => void> = {}, props: Record<string, unknown> = {}): HTMLElement {
  const target = document.createElement('div')
  Object.defineProperties(target, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  })
  document.body.appendChild(target)
  const app = createApp(GraphCanvas, { snapshot, reducedMotion: true, ...props, ...listeners })
  mounted.push(app)
  app.mount(target)
  return target
}

function mountReactiveSnapshot(snapshot: GraphSnapshot, initialProps: Record<string, unknown> = {}): { target: HTMLElement; state: Record<string, unknown> } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const state = reactive({ snapshot, reducedMotion: true, ...initialProps })
  const wrapper = defineComponent({
    setup: () => () => h(GraphCanvas, state),
  })
  const app = createApp(wrapper)
  mounted.push(app)
  app.mount(target)
  return { target, state }
}

async function flushResizeObserver(): Promise<void> {
  ResizeObserverStub.instances.at(-1)?.trigger()
  await new Promise((resolve) => window.setTimeout(resolve, 150))
  await nextTick()
}

function mountGraph(listeners: Record<string, (...args: unknown[]) => void> = {}, hasChildren = true): HTMLElement {
  return mountSnapshot({
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
  }, listeners)
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

  it('filters a complete hierarchy snapshot to roots until a parent is expanded', async () => {
    const snapshot: GraphSnapshot = {
      revision: 2,
      nodes: [
        { id: 'concept:root', type: 'concept', refId: 'root', label: '根主题', degree: 1, unitCount: 0, depth: 0, parentIds: [], hasChildren: true },
        { id: 'concept:child', type: 'concept', refId: 'child', label: '子主题', degree: 1, unitCount: 0, depth: 1, parentIds: ['root'], hasChildren: false },
      ],
      edges: [{ id: 'edge:h', source: 'concept:root', target: 'concept:child', type: 'hierarchy', weight: 1, status: 'confirmed' }],
    }
    const collapsed = mountSnapshot(snapshot)
    await nextTick()
    expect([...collapsed.querySelectorAll<SVGGElement>('.graph-node')].map((node) => node.dataset.refId)).toEqual(['root'])

    const expanded = mountSnapshot(snapshot, {}, { expandedConceptIds: ['root'] })
    await nextTick()
    expect([...expanded.querySelectorAll<SVGGElement>('.graph-node')].map((node) => node.dataset.refId).sort()).toEqual(['child', 'root'])
  })
  it('does not promote a child with a stale depth zero value to a root', async () => {
    const snapshot: GraphSnapshot = {
      revision: 3,
      nodes: [
        { id: 'concept:root', type: 'concept', refId: 'root', label: '根主题', degree: 1, unitCount: 0, depth: 0, parentIds: [], hasChildren: true },
        { id: 'concept:child', type: 'concept', refId: 'child', label: '子主题', degree: 1, unitCount: 0, depth: 0, parentIds: ['root'], hasChildren: false },
      ],
      edges: [{ id: 'edge:h', source: 'concept:root', target: 'concept:child', type: 'hierarchy', weight: 1, status: 'confirmed' }],
    }
    const target = mountSnapshot(snapshot)
    await nextTick()
    expect([...target.querySelectorAll<SVGGElement>('.graph-node')].map((node) => node.dataset.refId)).toEqual(['root'])
  })

  it('renders no concept nodes when hierarchy has no valid root', async () => {
    const target = mountSnapshot({
      revision: 4,
      nodes: [
        { id: 'concept:a', type: 'concept', refId: 'a', label: '甲', degree: 1, unitCount: 0, parentIds: ['b'], hasChildren: true },
        { id: 'concept:b', type: 'concept', refId: 'b', label: '乙', degree: 1, unitCount: 0, parentIds: ['a'], hasChildren: true },
      ],
      edges: [
        { id: 'edge:ab', source: 'concept:a', target: 'concept:b', type: 'hierarchy', weight: 1, status: 'confirmed' },
        { id: 'edge:ba', source: 'concept:b', target: 'concept:a', type: 'hierarchy', weight: 1, status: 'confirmed' },
      ],
    })
    await nextTick()

    expect(target.querySelectorAll('.graph-node')).toHaveLength(0)
  })

  it('uses full external hierarchy relations when a stale snapshot only contains a child', async () => {
    const target = mountSnapshot({
      revision: 5,
      nodes: [{ id: 'concept:child', type: 'concept', refId: 'child', label: '子主题', degree: 1, unitCount: 0 }],
      edges: [],
    }, {}, {
      hierarchyRelations: [{ parentConceptId: 'root', childConceptId: 'child', relationType: 'hierarchy', status: 'confirmed' }],
    })
    await nextTick()
    expect(target.querySelectorAll('.graph-node')).toHaveLength(0)
  })

  it('does not disclose a proposed child while proposed edges are hidden', async () => {
    const target = mountSnapshot({
      revision: 6,
      nodes: [
        { id: 'concept:root', type: 'concept', refId: 'root', label: '根主题', degree: 1, unitCount: 0, hasChildren: true },
        { id: 'concept:child', type: 'concept', refId: 'child', label: '子主题', degree: 1, unitCount: 0 },
      ],
      edges: [{ id: 'edge:h', source: 'concept:root', target: 'concept:child', type: 'hierarchy', weight: 1, status: 'proposed' }],
    }, {}, {
      hierarchyRelations: [{ parentConceptId: 'root', childConceptId: 'child', relationType: 'hierarchy', status: 'proposed' }],
      expandedConceptIds: ['root'],
      showProposed: false,
    })
    await nextTick()
    expect([...target.querySelectorAll<SVGGElement>('.graph-node')].map((node) => node.dataset.refId)).toEqual(['root'])
  })

  it('hides Reading Unit association links until the link itself is hovered', async () => {
    const target = mountSnapshot({
      revision: 7,
      nodes: [
        { id: 'concept:root', type: 'concept', refId: 'root', label: '根', degree: 1, unitCount: 1 },
        { id: 'unit:u1', type: 'unit', refId: 'u1', label: '片段', degree: 1, unitCount: 0 },
      ],
      edges: [{ id: 'edge:a', source: 'concept:root', target: 'unit:u1', type: 'association', weight: 1 }],
    })
    await nextTick()
    const link = target.querySelector<SVGLineElement>('.graph-link-unit')!
    expect(link).toBeTruthy()
    expect(link.getAttribute('class')).not.toContain('is-hovered')
    link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    expect(link.getAttribute('class')).toContain('is-hovered')
    link.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    expect(link.getAttribute('class')).not.toContain('is-hovered')
  })

  it('sizes Concept nodes by stable hierarchy scope instead of transient evidence degree', async () => {
    const target = mountSnapshot({
      revision: 8,
      nodes: [
        { id: 'concept:parent', type: 'concept', refId: 'parent', label: '父', degree: 0, unitCount: 0, childCount: 2, descendantCount: 6 },
        { id: 'concept:leaf', type: 'concept', refId: 'leaf', label: '叶', degree: 20, unitCount: 20, childCount: 0, descendantCount: 0 },
      ],
      edges: [],
    })
    await nextTick()
    const parentRadius = Number(target.querySelector<SVGCircleElement>('[data-ref-id="parent"] circle')?.getAttribute('r'))
    const leafRadius = Number(target.querySelector<SVGCircleElement>('[data-ref-id="leaf"] circle')?.getAttribute('r'))
    expect(parentRadius).toBeGreaterThan(leafRadius)
    expect(leafRadius).toBe(16)
  })

  it('makes stronger semantic links darker and slightly thicker', async () => {
    const target = mountSnapshot({
      revision: 9,
      nodes: [
        { id: 'concept:a', type: 'concept', refId: 'a', label: '甲', degree: 2, unitCount: 0 },
        { id: 'concept:b', type: 'concept', refId: 'b', label: '乙', degree: 2, unitCount: 0 },
        { id: 'concept:c', type: 'concept', refId: 'c', label: '丙', degree: 2, unitCount: 0 },
      ],
      edges: [
        { id: 'edge:weak', source: 'concept:a', target: 'concept:b', type: 'co_occurrence', weight: 1 },
        { id: 'edge:strong', source: 'concept:a', target: 'concept:c', type: 'co_occurrence', weight: 12 },
      ],
    })
    await nextTick()
    const weak = target.querySelector<SVGLineElement>('[data-edge-id="edge:weak"]')!
    const strong = target.querySelector<SVGLineElement>('[data-edge-id="edge:strong"]')!
    expect(Number(strong.getAttribute('stroke-width'))).toBeGreaterThan(Number(weak.getAttribute('stroke-width')))
    const luminance = (hex: string) => Number.parseInt(hex.slice(1, 3), 16) + Number.parseInt(hex.slice(3, 5), 16) + Number.parseInt(hex.slice(5, 7), 16)
    expect(luminance(strong.getAttribute('stroke') ?? '#ffffff')).toBeLessThan(luminance(weak.getAttribute('stroke') ?? '#ffffff'))
  })

  it('ignores repeated ResizeObserver notifications when canvas dimensions did not change', async () => {
    const target = mountGraph()
    await nextTick()
    const viewport = target.querySelector('.graph-viewport')
    const node = target.querySelector('[data-ref-id="root"]')

    await flushResizeObserver()
    await flushResizeObserver()

    expect(target.querySelector('.graph-viewport')).toBe(viewport)
    expect(target.querySelector('[data-ref-id="root"]')).toBe(node)
  })

  it('reflows on a real resize while preserving a fixed dragged node position', async () => {
    const target = mountSnapshot({
      revision: 10,
      nodes: [{ id: 'concept:root', type: 'concept', refId: 'root', label: '根', degree: 0, unitCount: 0, x: 120, y: 140, fixed: true }],
      edges: [],
    })
    await nextTick()
    const graphHost = target.querySelector<HTMLElement>('.graph-canvas')!
    const previousViewport = target.querySelector('.graph-viewport')
    expect(target.querySelector('[data-ref-id="root"]')?.getAttribute('transform')).toBe('translate(120,140)')
    Object.defineProperties(graphHost, {
      clientWidth: { configurable: true, value: 920 },
      clientHeight: { configurable: true, value: 680 },
    })

    await flushResizeObserver()

    expect(target.querySelector('.graph-viewport')).not.toBe(previousViewport)
    expect(target.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 920 680')
    expect(target.querySelector('[data-ref-id="root"]')?.getAttribute('transform')).toBe('translate(120,140)')
  })

  it('keeps existing nodes stable through progressive expand and recursive collapse', async () => {
    const snapshot: GraphSnapshot = {
      revision: 11,
      nodes: [
        { id: 'concept:root', type: 'concept', refId: 'root', label: '根', degree: 1, unitCount: 0, parentIds: [], childCount: 1, descendantCount: 2, hasChildren: true },
        { id: 'concept:child', type: 'concept', refId: 'child', label: '子', degree: 2, unitCount: 0, parentIds: ['root'], childCount: 1, descendantCount: 1, hasChildren: true },
        { id: 'concept:grandchild', type: 'concept', refId: 'grandchild', label: '孙', degree: 1, unitCount: 0, parentIds: ['child'], childCount: 0, descendantCount: 0 },
      ],
      edges: [
        { id: 'edge:root-child', source: 'concept:root', target: 'concept:child', type: 'hierarchy', weight: 1, status: 'confirmed' },
        { id: 'edge:child-grandchild', source: 'concept:child', target: 'concept:grandchild', type: 'hierarchy', weight: 1, status: 'confirmed' },
      ],
    }
    const { target, state } = mountReactiveSnapshot(snapshot, { expandedConceptIds: [] })
    await nextTick()
    const rootTransform = target.querySelector('[data-ref-id="root"]')?.getAttribute('transform')

    state.expandedConceptIds = ['root']
    await nextTick()
    expect([...target.querySelectorAll<SVGGElement>('.graph-node')].map((node) => node.dataset.refId).sort()).toEqual(['child', 'root'])
    expect(target.querySelector('[data-ref-id="root"]')?.getAttribute('transform')).toBe(rootTransform)

    state.expandedConceptIds = ['root', 'child']
    await nextTick()
    expect(target.querySelector('[data-ref-id="grandchild"]')).toBeTruthy()

    state.expandedConceptIds = []
    await nextTick()
    expect([...target.querySelectorAll<SVGGElement>('.graph-node')].map((node) => node.dataset.refId)).toEqual(['root'])
    expect(target.querySelector('.graph-transition-old')).toBeNull()
  })

  it('anchors a root even when expansion happens before the first simulation tick', async () => {
    const snapshot: GraphSnapshot = {
      revision: 13,
      nodes: [
        { id: 'concept:root', type: 'concept', refId: 'root', label: '根', degree: 1, unitCount: 0, parentIds: [], hasChildren: true },
        { id: 'concept:child', type: 'concept', refId: 'child', label: '子', degree: 1, unitCount: 0, parentIds: ['root'] },
      ],
      edges: [{ id: 'edge:h', source: 'concept:root', target: 'concept:child', type: 'hierarchy', weight: 1, status: 'confirmed' }],
    }
    const { target, state } = mountReactiveSnapshot(snapshot, { expandedConceptIds: [], reducedMotion: false })
    const rootTransform = target.querySelector('[data-ref-id="root"]')?.getAttribute('transform')
    state.expandedConceptIds = ['root']
    await nextTick()
    await new Promise((resolve) => window.setTimeout(resolve, 140))

    expect(target.querySelector('[data-ref-id="root"]')?.getAttribute('transform')).toBe(rootTransform)
    expect(target.querySelector('[data-ref-id="child"]')).toBeTruthy()
  })

  it('only creates topology fade layers when reduced motion is disabled', async () => {
    const snapshot: GraphSnapshot = {
      revision: 12,
      nodes: [
        { id: 'concept:root', type: 'concept', refId: 'root', label: '根', degree: 1, unitCount: 0, parentIds: [], hasChildren: true },
        { id: 'concept:child', type: 'concept', refId: 'child', label: '子', degree: 1, unitCount: 0, parentIds: ['root'] },
      ],
      edges: [{ id: 'edge:h', source: 'concept:root', target: 'concept:child', type: 'hierarchy', weight: 1, status: 'confirmed' }],
    }
    const reduced = mountReactiveSnapshot(snapshot, { expandedConceptIds: [], reducedMotion: true })
    await nextTick()
    reduced.state.expandedConceptIds = ['root']
    await nextTick()
    expect(reduced.target.querySelector('.graph-transition-old')).toBeNull()
    const reducedTransforms = [...reduced.target.querySelectorAll<SVGGElement>('.graph-node')].map((node) => node.getAttribute('transform'))
    await new Promise((resolve) => window.setTimeout(resolve, 250))
    expect([...reduced.target.querySelectorAll<SVGGElement>('.graph-node')].map((node) => node.getAttribute('transform'))).toEqual(reducedTransforms)

    const animated = mountReactiveSnapshot(snapshot, { expandedConceptIds: [], reducedMotion: false })
    await nextTick()
    animated.state.expandedConceptIds = ['root']
    await nextTick()
    expect(animated.target.querySelector('.graph-transition-old')).toBeTruthy()
  })
})
