<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, Folder, FolderOpen } from 'lucide-vue-next'
import type { Concept, ConceptRelation } from '@/types/domain'

const props = withDefaults(defineProps<{
  concepts: Concept[]
  relations: ConceptRelation[]
  selectedId?: string | null
  expandedIds?: string[]
  rootIds?: string[]
  path?: string[]
}>(), { selectedId: null, expandedIds: () => [], rootIds: undefined, path: () => [] })

const emit = defineEmits<{
  (event: 'select', conceptId: string): void
  (event: 'toggle', conceptId: string): void
}>()
const expandedIds = computed(() => new Set(props.expandedIds))
const conceptIds = computed(() => new Set(props.concepts.map((concept) => concept.id)))
const isActiveHierarchy = (relation: ConceptRelation): boolean => relation.relationType === 'hierarchy' && relation.status !== 'rejected'
const childrenByParent = computed(() => {
  const result = new Map<string, Concept[]>()
  props.relations.forEach((relation) => {
    if (!isActiveHierarchy(relation)) return
    if (!conceptIds.value.has(relation.parentConceptId) || !conceptIds.value.has(relation.childConceptId)) return
    const child = props.concepts.find((concept) => concept.id === relation.childConceptId)
    if (!child) return
    const children = result.get(relation.parentConceptId) ?? []
    if (!children.some((item) => item.id === child.id)) children.push(child)
    result.set(relation.parentConceptId, children)
  })
  result.forEach((children) => children.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')))
  return result
})
const roots = computed(() => {
  const rootIds = props.rootIds ? new Set(props.rootIds) : null
  const result = props.concepts
    .filter((concept) => rootIds
      ? rootIds.has(concept.id)
      : !props.relations.some((relation) => isActiveHierarchy(relation) && relation.childConceptId === concept.id && conceptIds.value.has(relation.parentConceptId)))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  // A cyclic hierarchy has no valid root. Keep the tree empty until the data
  // is repaired instead of presenting descendants as top-level folders.
  return result
})

function childrenOf(conceptId: string): Concept[] {
  return (childrenByParent.value.get(conceptId) ?? []).filter((child) => !props.path.includes(child.id))
}

function hasProposedParent(conceptId: string): boolean {
  return props.relations.some((relation) => relation.relationType === 'hierarchy' && relation.status === 'proposed' && relation.childConceptId === conceptId)
}
</script>

<template>
  <div class="concept-tree" role="tree">
    <div v-for="concept in roots" :key="concept.id" class="concept-tree-branch" role="treeitem" :aria-selected="selectedId === concept.id" :aria-level="path.length + 1" :aria-expanded="childrenOf(concept.id).length ? expandedIds.has(concept.id) : undefined">
      <div class="concept-tree-row" :class="{ selected: selectedId === concept.id }">
        <button v-if="childrenOf(concept.id).length" class="concept-tree-toggle" :aria-label="expandedIds.has(concept.id) ? `收起${concept.name}` : `展开${concept.name}`" :aria-expanded="expandedIds.has(concept.id)" @click.stop="emit('toggle', concept.id)">
          <ChevronRight class="concept-tree-chevron" :class="{ expanded: expandedIds.has(concept.id) }" :size="14" />
        </button>
        <span v-else class="concept-tree-spacer" />
        <button class="concept-tree-select" :aria-label="`查看${concept.name}`" @click="emit('select', concept.id)"><FolderOpen v-if="childrenOf(concept.id).length && expandedIds.has(concept.id)" :size="15" /><Folder v-else-if="childrenOf(concept.id).length" :size="15" /><span v-else class="concept-tree-leaf" aria-hidden="true" /><span class="concept-tree-label">{{ concept.name }}</span></button>
        <span v-if="hasProposedParent(concept.id)" class="concept-tree-proposed" title="包含待确认的父主题关系">?</span>
      </div>
      <div v-if="childrenOf(concept.id).length && expandedIds.has(concept.id)" class="concept-tree-children">
        <ConceptTree :concepts="concepts" :relations="relations" :selected-id="selectedId" :expanded-ids="props.expandedIds" :root-ids="childrenOf(concept.id).map((child) => child.id)" :path="[...path, concept.id]" @select="emit('select', $event)" @toggle="emit('toggle', $event)" />
      </div>
    </div>
    <div v-if="!roots.length" class="empty-inline">没有匹配的知识主题。</div>
  </div>
</template>
