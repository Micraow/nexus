<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NavTreeNode } from '@/types/domain'
import { cleanGraphText } from '@/services/graph'

const props = defineProps<{
  nodes: NavTreeNode[]
  selectedNodeId?: string | null
}>()

const emit = defineEmits<{
  (event: 'select-node', node: NavTreeNode): void
}>()

const NODE_RADIUS = 18
const HORIZONTAL_GAP = 72
const VERTICAL_GAP = 78
const PADDING_X = 28
const PADDING_Y = 28

interface PositionedNode {
  node: NavTreeNode
  x: number
  y: number
}

interface PositionedEdge {
  id: string
  source: PositionedNode
  target: PositionedNode
  path: string
}

function sortNodes(nodes: NavTreeNode[]): NavTreeNode[] {
  return nodes.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

/**
 * Lay out leaves from left to right and center each ancestor above its direct
 * children. Coordinates are explicit so connectors cannot drift when labels,
 * responsive CSS or nested branches change size.
 */
function buildLayout(nodes: NavTreeNode[]): { nodes: PositionedNode[]; edges: PositionedEdge[]; width: number; height: number } {
  const unique = new Map<string, NavTreeNode>()
  nodes.forEach((node) => { if (!unique.has(node.id)) unique.set(node.id, node) })
  const children = new Map<string, NavTreeNode[]>()
  unique.forEach((node) => {
    if (!node.parentId || node.parentId === node.id || !unique.has(node.parentId)) return
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  })
  children.forEach((siblings, parentId) => children.set(parentId, sortNodes(siblings)))

  const roots = sortNodes([...unique.values()].filter((node) => !node.parentId || node.parentId === node.id || !unique.has(node.parentId)))
  const positioned = new Map<string, PositionedNode>()
  const visiting = new Set<string>()
  let leafIndex = 0

  const visit = (node: NavTreeNode, depth: number): PositionedNode => {
    const existing = positioned.get(node.id)
    if (existing) return existing
    visiting.add(node.id)
    const childPositions = (children.get(node.id) ?? [])
      .filter((child) => !visiting.has(child.id))
      .map((child) => visit(child, depth + 1))
    const x = childPositions.length
      ? (childPositions[0].x + childPositions[childPositions.length - 1].x) / 2
      : PADDING_X + leafIndex++ * HORIZONTAL_GAP
    const result = { node, x, y: PADDING_Y + depth * VERTICAL_GAP }
    positioned.set(node.id, result)
    visiting.delete(node.id)
    return result
  }

  roots.forEach((root) => visit(root, 0))
  // Malformed cyclic components have no root. Render each remaining component
  // once instead of recursing forever or silently losing navigation targets.
  sortNodes([...unique.values()].filter((node) => !positioned.has(node.id))).forEach((node) => visit(node, 0))

  const positionedNodes = [...positioned.values()].sort((left, right) => left.y - right.y || left.x - right.x)
  const edges = positionedNodes.flatMap((target): PositionedEdge[] => {
    if (!target.node.parentId) return []
    const source = positioned.get(target.node.parentId)
    if (!source || source.node.id === target.node.id) return []
    const startY = source.y + NODE_RADIUS
    const endY = target.y - NODE_RADIUS
    const middleY = (startY + endY) / 2
    return [{
      id: `${source.node.id}->${target.node.id}`,
      source,
      target,
      path: `M ${source.x} ${startY} C ${source.x} ${middleY}, ${target.x} ${middleY}, ${target.x} ${endY}`,
    }]
  })
  const maxX = Math.max(PADDING_X, ...positionedNodes.map((item) => item.x))
  const maxY = Math.max(PADDING_Y, ...positionedNodes.map((item) => item.y))
  return {
    nodes: positionedNodes,
    edges,
    width: Math.max(88, maxX + PADDING_X),
    height: Math.max(88, maxY + PADDING_Y),
  }
}

const layout = computed(() => buildLayout(props.nodes))
const pathNodeIds = computed(() => {
  const result = new Set<string>()
  const byId = new Map(props.nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  let current = props.selectedNodeId ? byId.get(props.selectedNodeId) : undefined
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    result.add(current.id)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return result
})
const inspectedNodeId = ref<string | null>(null)
const inspectedNode = computed(() => layout.value.nodes.find((item) => item.node.id === inspectedNodeId.value) ?? null)
const nodeLabel = (node: NavTreeNode): string => cleanGraphText(node.label) || '未命名探索节点'

function edgeOnPath(edge: PositionedEdge): boolean {
  return pathNodeIds.value.has(edge.source.node.id) && pathNodeIds.value.has(edge.target.node.id)
}
</script>

<template>
  <div class="conversation-tree-map" :style="{ minWidth: `${layout.width}px`, minHeight: `${layout.height}px` }">
    <svg class="conversation-tree-svg" :viewBox="`0 0 ${layout.width} ${layout.height}`" :width="layout.width" :height="layout.height" role="tree" aria-label="对话探索树">
      <g class="conversation-tree-edges" aria-hidden="true">
        <path
          v-for="edge in layout.edges"
          :key="edge.id"
          class="conversation-tree-edge"
          :class="{ 'is-path': edgeOnPath(edge) }"
          :d="edge.path"
          :data-source-id="edge.source.node.id"
          :data-target-id="edge.target.node.id"
          :data-start-x="edge.source.x"
          :data-start-y="edge.source.y + NODE_RADIUS"
          :data-end-x="edge.target.x"
          :data-end-y="edge.target.y - NODE_RADIUS"
        />
      </g>
      <g
        v-for="item in layout.nodes"
        :key="item.node.id"
        class="conversation-tree-node"
        :class="{ 'is-current': item.node.id === selectedNodeId, 'is-path': pathNodeIds.has(item.node.id), 'is-pending': item.node.id.startsWith('pending-nav-') }"
        :transform="`translate(${item.x} ${item.y})`"
        role="treeitem"
        tabindex="0"
        :aria-label="nodeLabel(item.node)"
        :aria-current="item.node.id === selectedNodeId ? 'true' : undefined"
        :data-node-id="item.node.id"
        :data-x="item.x"
        :data-y="item.y"
        @click="emit('select-node', item.node)"
        @keydown.enter.prevent="emit('select-node', item.node)"
        @keydown.space.prevent="emit('select-node', item.node)"
        @mouseenter="inspectedNodeId = item.node.id"
        @mouseleave="inspectedNodeId = null"
        @focus="inspectedNodeId = item.node.id"
        @blur="inspectedNodeId = null"
      >
        <circle class="conversation-tree-node-halo" :r="NODE_RADIUS + 7" />
        <circle class="conversation-tree-node-circle" :r="NODE_RADIUS" />
        <title>{{ nodeLabel(item.node) }}</title>
      </g>
    </svg>
    <div
      v-if="inspectedNode"
      class="conversation-tree-tooltip"
      role="tooltip"
      :style="{ left: `${inspectedNode.x + NODE_RADIUS + 8}px`, top: `${inspectedNode.y}px` }"
    >{{ nodeLabel(inspectedNode.node) }}</div>
    <p v-if="!layout.nodes.length" class="empty-inline">这个会话还没有探索节点。</p>
  </div>
</template>
