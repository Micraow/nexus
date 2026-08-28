<script setup lang="ts">
import { computed } from 'vue'
import { MessageSquare } from 'lucide-vue-next'
import type { KnowledgeUnit, NavTreeNode, NavTreeNodeUnit } from '@/types/domain'

const props = withDefaults(defineProps<{
  nodes: NavTreeNode[]
  /** Complete node list used to resolve children after the root is filtered. */
  allNodes?: NavTreeNode[]
  /** Alias for callers that describe the complete list as fullNodes. */
  fullNodes?: NavTreeNode[]
  nodeUnits: NavTreeNodeUnit[]
  units: KnowledgeUnit[]
  selectedNodeId?: string | null
  /** Hide per-node actions when the tree is used as a branch navigator. */
  showActions?: boolean
  /** IDs on the current ancestor path, used to guard malformed cyclic data. */
  visitedNodeIds?: string[]
}>(), {
  showActions: true,
})

const emit = defineEmits<{
  (event: 'select-node', node: NavTreeNode): void
  (event: 'ask', node: NavTreeNode): void
}>()

const completeNodes = computed(() => props.allNodes ?? props.fullNodes ?? props.nodes)

function childrenOf(nodeId: string): NavTreeNode[] {
  const visited = new Set(props.visitedNodeIds ?? [])
  visited.add(nodeId)
  return completeNodes.value
    .filter((node) => node.parentId === nodeId && !visited.has(node.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function unitsOf(nodeId: string): KnowledgeUnit[] {
  return props.nodeUnits
    .filter((link) => link.nodeId === nodeId)
    .sort((a, b) => a.orderInNode - b.orderInNode)
    .map((link) => props.units.find((unit) => unit.id === link.unitId))
    .filter(Boolean) as KnowledgeUnit[]
}
</script>

<template>
  <div class="nav-tree" role="tree">
    <div v-for="node in nodes" :key="node.id" class="nav-tree-branch" role="treeitem" :aria-selected="selectedNodeId === node.id" :aria-expanded="childrenOf(node.id).length ? true : undefined">
      <div class="nav-tree-row" :class="{ selected: selectedNodeId === node.id }">
        <button class="nav-tree-node" :class="{ selected: selectedNodeId === node.id }" :aria-label="node.label" :title="node.label" @click="emit('select-node', node)">
          <span class="nav-tree-marker" :class="{ root: !node.parentId }" />
          <span class="nav-tree-label">{{ node.label }}</span>
          <span v-if="unitsOf(node.id).length" class="nav-tree-count">{{ unitsOf(node.id).length }}</span>
        </button>
        <button v-if="props.showActions !== false" class="nav-tree-ask" :title="`从「${node.label}」继续追问`" :aria-label="`从「${node.label}」继续追问`" @click.stop="emit('ask', node)">
          <MessageSquare :size="13" />
        </button>
      </div>
      <div v-if="unitsOf(node.id).length" class="nav-tree-units">
        <span v-for="unit in unitsOf(node.id)" :key="unit.id" class="nav-tree-unit">{{ unit.title || '未命名阅读片段' }}</span>
      </div>
      <NavTree v-if="childrenOf(node.id).length" :nodes="childrenOf(node.id)" :all-nodes="completeNodes" :node-units="nodeUnits" :units="units" :selected-node-id="selectedNodeId" :show-actions="props.showActions" :visited-node-ids="[...(visitedNodeIds ?? []), node.id]" @select-node="emit('select-node', $event)" @ask="emit('ask', $event)" />
    </div>
    <p v-if="!nodes.length" class="empty-inline">这个会话还没有探索节点。</p>
  </div>
</template>
