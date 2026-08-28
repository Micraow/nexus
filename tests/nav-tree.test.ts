// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import NavTree from '@/components/NavTree.vue'
import type { KnowledgeUnit, NavTreeNode, NavTreeNodeUnit } from '@/types/domain'

const now = '2026-08-28T00:00:00.000Z'
const root: NavTreeNode = { id: 'root', sessionId: 'session', parentId: null, label: '根节点', depth: 0, createdAt: now }
const child: NavTreeNode = { id: 'child', sessionId: 'session', parentId: 'root', label: '子节点', depth: 1, createdAt: now }
const grandchild: NavTreeNode = { id: 'grandchild', sessionId: 'session', parentId: 'child', label: '孙节点', depth: 2, createdAt: now }
const units: KnowledgeUnit[] = []
const nodeUnits: NavTreeNodeUnit[] = []

const mounted: Array<ReturnType<typeof createApp>> = []

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount())
  document.body.innerHTML = ''
})

function mountTree(
  nodes: NavTreeNode[],
  allNodes: NavTreeNode[] = nodes,
  listeners: { onSelectNode?: (node: NavTreeNode) => void; onAsk?: (node: NavTreeNode) => void; showActions?: boolean } = {},
): HTMLElement {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = createApp(NavTree, {
    nodes,
    allNodes,
    nodeUnits,
    units,
    ...listeners,
  })
  mounted.push(app)
  app.mount(target)
  return target
}

describe('NavTree hierarchy', () => {
  it('renders descendants from the complete node list at every depth', async () => {
    const target = mountTree([root], [root, child, grandchild])
    await nextTick()

    expect([...target.querySelectorAll('.nav-tree-label')].map((label) => label.textContent)).toEqual(['根节点', '子节点', '孙节点'])
    expect([...target.querySelectorAll<HTMLButtonElement>('.nav-tree-node')].map((button) => button.getAttribute('aria-label'))).toEqual(['根节点', '子节点', '孙节点'])
  })

  it('bubbles select and ask events from recursive branches', async () => {
    const selected: string[] = []
    const asked: string[] = []
    const target = mountTree([root], [root, child, grandchild], {
      onSelectNode: (node) => selected.push(node.id),
      onAsk: (node) => asked.push(node.id),
    })
    await nextTick()

    const grandchildBranch = [...target.querySelectorAll<HTMLElement>('.nav-tree-branch')]
      .find((branch) => branch.querySelector('.nav-tree-label')?.textContent === '孙节点')
    expect(grandchildBranch).toBeDefined()
    grandchildBranch?.querySelector<HTMLButtonElement>('.nav-tree-node')?.click()
    grandchildBranch?.querySelector<HTMLButtonElement>('.nav-tree-ask')?.click()

    expect(selected).toEqual(['grandchild'])
    expect(asked).toEqual(['grandchild'])
  })

  it('does not recurse through repeated node IDs', async () => {
    const repeatedRoot: NavTreeNode = { ...root, parentId: 'child' }
    const target = mountTree([root], [root, child, repeatedRoot])
    await nextTick()

    expect(target.querySelectorAll('.nav-tree-label')).toHaveLength(2)
    expect([...target.querySelectorAll('.nav-tree-label')].map((label) => label.textContent)).toEqual(['根节点', '子节点'])
  })

  it('supports a compact branch navigator without per-node ask actions', async () => {
    const target = mountTree([root], [root, child, grandchild], { showActions: false })
    await nextTick()

    expect(target.querySelectorAll('.nav-tree-ask')).toHaveLength(0)
    expect(target.querySelector<HTMLElement>('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(target.querySelector<HTMLElement>('[role="treeitem"]')?.getAttribute('aria-selected')).toBe('false')
  })

  it('keeps each navigation subject as an accessible circle target', async () => {
    const target = mountTree([root], [root, child, grandchild], { showActions: false })
    await nextTick()

    const nodes = [...target.querySelectorAll<HTMLButtonElement>('.nav-tree-node')]
    expect(nodes).toHaveLength(3)
    nodes.forEach((node) => {
      expect(node.title).toBeTruthy()
      expect(node.querySelector('.nav-tree-marker')).not.toBeNull()
    })
  })

  it('cleans Markdown and Nexus delimiters from compact navigation labels', async () => {
    const markedRoot = { ...root, label: '## [[nexus:existing:根节点]]根节点[[/nexus]]' }
    const markedUnit: KnowledgeUnit = {
      id: 'unit', sessionId: 'session', title: '**阅读片段**', orderInSession: 0,
      status: 'ready', revision: 1, createdAt: now, updatedAt: now,
    }
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = createApp(NavTree, {
      nodes: [markedRoot], allNodes: [markedRoot], units: [markedUnit],
      nodeUnits: [{ nodeId: 'root', unitId: 'unit', orderInNode: 0 }],
    })
    mounted.push(app)
    app.mount(target)
    await nextTick()

    expect(target.querySelector('.nav-tree-label')?.textContent).toBe('根节点')
    expect(target.querySelector('.nav-tree-unit')?.textContent).toBe('阅读片段')
    expect(target.textContent).not.toContain('nexus')
  })
})
