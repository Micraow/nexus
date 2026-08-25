<script setup lang="ts">
import type { KnowledgeUnit, NavTreeNode, NavTreeNodeUnit } from '@/types/domain'

const props = defineProps<{
  nodes: NavTreeNode[]
  nodeUnits: NavTreeNodeUnit[]
  units: KnowledgeUnit[]
  selectedNodeId?: string | null
}>()

const emit = defineEmits<{
  (event: 'select-node', node: NavTreeNode): void
}>()

function childrenOf(nodeId: string): NavTreeNode[] {
  return props.nodes.filter((node) => node.parentId === nodeId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
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
    <div v-for="node in nodes" :key="node.id" class="nav-tree-branch" role="treeitem" :aria-selected="selectedNodeId === node.id">
      <button class="nav-tree-node" :class="{ selected: selectedNodeId === node.id }" @click="emit('select-node', node)">
        <span class="nav-tree-marker" :class="{ root: !node.parentId }" />
        <span class="nav-tree-label">{{ node.label }}</span>
        <span v-if="unitsOf(node.id).length" class="nav-tree-count">{{ unitsOf(node.id).length }}</span>
      </button>
      <div v-if="unitsOf(node.id).length" class="nav-tree-units">
        <span v-for="unit in unitsOf(node.id)" :key="unit.id" class="nav-tree-unit">{{ unit.title || '待命名知识单元' }}</span>
      </div>
      <NavTree v-if="childrenOf(node.id).length" :nodes="childrenOf(node.id)" :node-units="nodeUnits" :units="units" :selected-node-id="selectedNodeId" @select-node="emit('select-node', $event)" />
    </div>
    <p v-if="!nodes.length" class="empty-inline">这个会话还没有探索节点。</p>
  </div>
</template>
