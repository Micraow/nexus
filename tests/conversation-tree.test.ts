// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import ConversationTree from '@/components/ConversationTree.vue'
import type { NavTreeNode } from '@/types/domain'

const now = '2026-08-28T00:00:00.000Z'
const node = (id: string, parentId: string | null, depth: number, label = id): NavTreeNode => ({
  id,
  sessionId: 'session',
  parentId,
  label,
  depth,
  createdAt: `${now.slice(0, -5)}${String(depth).padStart(4, '0')}Z`,
})

const roots = [
  node('root', null, 0, '## 根节点'),
  node('left', 'root', 1),
  node('right', 'root', 1),
  node('leaf', 'left', 2),
]

const mounted: Array<ReturnType<typeof createApp>> = []

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount())
  document.body.innerHTML = ''
})

async function mountTree(selectedNodeId = 'leaf', onSelectNode?: (value: NavTreeNode) => void): Promise<HTMLElement> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = createApp(ConversationTree, { nodes: roots, selectedNodeId, onSelectNode })
  mounted.push(app)
  app.mount(target)
  await nextTick()
  return target
}

describe('ConversationTree', () => {
  it('lays siblings out horizontally and connects at the circle boundaries', async () => {
    const target = await mountTree()
    const left = target.querySelector<SVGGElement>('[data-node-id="left"]')!
    const right = target.querySelector<SVGGElement>('[data-node-id="right"]')!
    expect(Number(left.dataset.x)).not.toBe(Number(right.dataset.x))

    const edge = target.querySelector<SVGPathElement>('[data-source-id="root"][data-target-id="left"]')!
    const root = target.querySelector<SVGGElement>('[data-node-id="root"]')!
    expect(Number(edge.dataset.startX)).toBe(Number(root.dataset.x))
    expect(Number(edge.dataset.startY)).toBe(Number(root.dataset.y) + 18)
    expect(Number(edge.dataset.endX)).toBe(Number(left.dataset.x))
    expect(Number(edge.dataset.endY)).toBe(Number(left.dataset.y) - 18)
  })

  it('highlights the selected node and every ancestor edge without highlighting its sibling', async () => {
    const target = await mountTree('leaf')
    expect(target.querySelector('[data-node-id="root"]')?.classList.contains('is-path')).toBe(true)
    expect(target.querySelector('[data-node-id="left"]')?.classList.contains('is-path')).toBe(true)
    expect(target.querySelector('[data-node-id="leaf"]')?.classList.contains('is-current')).toBe(true)
    expect(target.querySelector('[data-node-id="right"]')?.classList.contains('is-path')).toBe(false)
    expect(target.querySelector('[data-source-id="root"][data-target-id="left"]')?.classList.contains('is-path')).toBe(true)
    expect(target.querySelector('[data-source-id="root"][data-target-id="right"]')?.classList.contains('is-path')).toBe(false)
  })

  it('shows a cleaned label on focus and remains keyboard selectable', async () => {
    const selected: string[] = []
    const target = await mountTree('leaf', (value) => selected.push(value.id))
    const root = target.querySelector<SVGGElement>('[data-node-id="root"]')!
    root.dispatchEvent(new FocusEvent('focus'))
    await nextTick()
    expect(target.querySelector('.conversation-tree-tooltip')?.textContent).toBe('根节点')
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(selected).toEqual(['root'])
  })
})
