<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as d3 from 'd3'
import type { GraphEdge, GraphNode, GraphSnapshot, GraphViewport } from '@/types/domain'
import { cleanGraphText } from '@/services/graph'

/** Optional hierarchy metadata accepted by recursive graph callers. */
export interface GraphConceptHierarchyMeta {
  depth?: number
  level?: number
  parentId?: string | null
  childCount?: number
  hasChildren?: boolean
}

type LevelMap = Record<string, number> | Map<string, number>
type HierarchyMap = Record<string, GraphConceptHierarchyMeta> | Map<string, GraphConceptHierarchyMeta>
type ChildrenMap = Record<string, string[]> | Map<string, string[]>
type HierarchyRelationInput = {
  parentConceptId: string
  childConceptId: string
  relationType: string
  status?: string
}

const props = withDefaults(
  defineProps<{
    snapshot: GraphSnapshot
    selectedUnitIds?: string[]
    reducedMotion?: boolean
    viewport?: GraphViewport
    /** Concept ids whose local children are currently disclosed. */
    expandedConceptIds?: string[]
    /** Optional per-node depth/level map used by recursive graph queries. */
    visibleNodeLevels?: LevelMap | number
    /** Maximum depth to render when a caller passes a complete snapshot. */
    maxVisibleLevel?: number
    /** Service-level alias used by recursive GraphViewOptions. */
    expandedConceptDepth?: number
    /** UI-level alias for callers with a complete, unfiltered snapshot. */
    visibleNodeDepth?: number
    /** Optional hierarchy metadata for concepts not yet present in snapshot. */
    conceptHierarchy?: HierarchyMap
    /** Optional child ids/counts for collapsed concepts. */
    conceptChildren?: ChildrenMap
    /** Full relation set used as the authoritative hierarchy source. */
    hierarchyRelations?: HierarchyRelationInput[]
    /** Active Concept ids used to ignore stale relations to archived records. */
    activeConceptIds?: string[]
    /** Whether proposed hierarchy edges may disclose their children. */
    showProposed?: boolean
    expandableConceptIds?: string[]
    /** Opt in to fitting after a topology update; disabled by default. */
    fitOnTopologyChange?: boolean
    /** Screen space occupied by a floating panel on the right. */
    viewportRightInset?: number
  }>(),
  {
    selectedUnitIds: () => [],
    reducedMotion: false,
    viewport: () => ({ x: 0, y: 0, scale: 1, layoutVersion: 1 }),
    visibleNodeLevels: undefined,
    maxVisibleLevel: undefined,
    expandedConceptDepth: undefined,
    visibleNodeDepth: undefined,
    conceptHierarchy: undefined,
    conceptChildren: undefined,
    showProposed: false,
    expandableConceptIds: () => [],
    fitOnTopologyChange: false,
    viewportRightInset: 0,
  },
)

const emit = defineEmits<{
  (event: 'select-concept', id: string): void
  (event: 'select-unit', id: string, additive: boolean): void
  (event: 'select-message', id: string): void
  (event: 'box-select-unit', id: string): void
  (event: 'layout-change', entry: { nodeType: GraphNode['type']; refId: string; x: number; y: number; fixed: boolean }): void
  (event: 'viewport-change', viewport: { x: number; y: number; scale: number }): void
  /** The parent owns expansion state and performs the next recursive query. */
  (event: 'toggle-concept', id: string, expanded: boolean): void
}>()

const host = ref<HTMLElement | null>(null)
const svg = ref<SVGSVGElement | null>(null)
const brushSelectionCount = ref(0)
let simulation: d3.Simulation<GraphNode & d3.SimulationNodeDatum, undefined> | null = null
let resizeObserver: ResizeObserver | null = null
// 当前视图变换的实时值；重渲染时用它恢复，避免快照变化把缩放重置回持久化视口。
let liveTransform: d3.ZoomTransform | null = null
// 用户是否手动平移/缩放过：首次挂载的自动铺满只在该值为 false 时生效。
let userMovedViewport = false
// 首次快照可能是空图，等异步 worker 返回节点后再做一次自动铺满。
let hasFittedData = false
// 拓扑展开时复用已经稳定的坐标，避免新增节点让整张图重新爆散。
const nodePositions = new Map<string, { x: number; y: number }>()
// 重渲染会替换 simulation；用 generation 和 timer 忽略旧布局的延迟 fit。
let renderGeneration = 0
let fitTimer: number | null = null
let resizeTimer: number | null = null
let paintFrame: number | null = null
let renderedSize: { width: number; height: number } | null = null
let draggingNodeId: string | null = null
let dragStartPoint: { x: number; y: number } | null = null
let dragMoved = false
let draggedDescendants = new Map<string, { x: number; y: number }>()
let dragPinnedNodes = new Map<string, { x: number; y: number }>()
let suppressClickNodeId: string | null = null
let suppressClickTimer: number | null = null
let lastNodeSignature = ''
let lastViewportRightInset = 0
// Coordinates are retained for future re-expansion, while this set tracks
// only the nodes that were visible in the previous render. The distinction
// lets a collapsed branch fade back in when it is opened again.
let lastVisibleNodeIds = new Set<string>()

const palette: Record<string, string> = {
  concept: '#2c6e9e',
  unit: '#7b8794',
  message: '#b9c3cc',
}

function edgeColor(edge: GraphEdge): string {
  // Edge strength is encoded by darkness as well as width. Keep hierarchy
  // links in the primary blue family, while weak evidence links converge to
  // a neutral charcoal as their weight grows.
  const bases: Record<string, [number, number, number]> = {
    hierarchy: [44, 110, 158],
    related: [148, 160, 170],
    conversation: [156, 151, 139],
    association: [166, 174, 181],
    co_occurrence: [122, 143, 154],
    manual: [130, 140, 150],
  }
  const [r, g, b] = bases[edge.type] ?? bases.manual
  const strength = Math.min(1, Math.log2(Math.max(1, edge.weight) + 1) / 4)
  // Even a single occurrence remains legible; repeated evidence trends dark.
  const darkness = 0.22 + strength * 0.58
  return d3.rgb(Math.round(r * (1 - darkness)), Math.round(g * (1 - darkness)), Math.round(b * (1 - darkness))).formatHex()
}

function edgeWidth(edge: GraphEdge): number {
  // Hierarchy is the visual backbone. Co-occurrence still communicates its
  // Session count, but remains thinner than a parent-child edge.
  if (edge.type === 'co_occurrence') return Math.min(3.2, 0.9 + Math.log2(edge.weight + 1) * 0.62)
  if (edge.type === 'hierarchy') return Math.min(3.4, 2.05 + Math.log2(edge.weight + 1) * 0.28)
  if (edge.type === 'manual') return 1.05
  if (edge.type === 'related') return Math.min(2.4, 0.82 + Math.log2(edge.weight + 1) * 0.42)
  return 0.9
}

function mapValue<T>(map: Record<string, T> | Map<string, T> | undefined, key: string): T | undefined {
  if (!map) return undefined
  return map instanceof Map ? map.get(key) : map[key]
}

function conceptMeta(conceptId: string): GraphConceptHierarchyMeta | undefined {
  return mapValue(props.conceptHierarchy, conceptId) ?? mapValue(props.conceptHierarchy, `concept:${conceptId}`)
}

function nodeLevel(node: GraphNode): number | undefined {
  const levels = props.visibleNodeLevels
  // A numeric `visibleNodeLevels` value is the max-depth shorthand, not a
  // claim that every node has that level.
  if (typeof levels === 'number') return undefined
  const dynamicNode = node as GraphNode & { depth?: number; level?: number }
  return mapValue(levels, node.id) ?? mapValue(levels, node.refId)
    ?? conceptMeta(node.refId)?.depth ?? conceptMeta(node.refId)?.level
    ?? dynamicNode.depth ?? dynamicNode.level
}

function configuredMaxLevel(): number | undefined {
  const direct = props.maxVisibleLevel ?? props.expandedConceptDepth ?? props.visibleNodeDepth
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  if (typeof props.visibleNodeLevels === 'number' && Number.isFinite(props.visibleNodeLevels)) return props.visibleNodeLevels
  return undefined
}

/**
 * A caller may either pre-filter the snapshot (legacy behavior) or pass a
 * depth limit alongside a complete recursive snapshot. Unknown levels stay
 * visible so old snapshots are never accidentally hidden.
 */
function visibleSnapshot(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const maxLevel = configuredMaxLevel()
  let nodes = props.snapshot.nodes
  let edges = props.snapshot.edges
  if (maxLevel != null) {
    nodes = nodes.filter((node) => {
      const level = nodeLevel(node)
      return level == null || level <= maxLevel
    })
  }

  // A stale Worker/legacy snapshot can contain the complete Concept graph.
  // Re-apply the disclosure contract at the final rendering boundary so a
  // response cannot flash descendants before the store's compatibility guard
  // has rebuilt it. Snapshots without hierarchy metadata remain compatible
  // with older callers and are left untouched.
  const conceptNodes = nodes.filter((node) => node.type === 'concept')
  const conceptIds = new Set(conceptNodes.map((node) => node.refId))
  // The snapshot is progressive and can omit undisclosed active children, so
  // callers may provide the complete active Concept id set. Without it,
  // retain the conservative legacy behavior and only trust ids in the
  // current snapshot.
  const activeConceptIds = props.activeConceptIds === undefined
    ? conceptIds
    : new Set(props.activeConceptIds)
  const parentsByConcept = new Map<string, Set<string>>()
  const visibleChildrenByParent = new Map<string, Set<string>>()
  const externalHierarchyProvided = props.hierarchyRelations !== undefined
  const externalHierarchy = (props.hierarchyRelations ?? []).filter((relation) => relation.relationType === 'hierarchy'
    && relation.status !== 'rejected'
    // A supplied active-id list is authoritative. Legacy callers that omit it
    // still rely on the relation list to reconstruct a stale progressive
    // snapshot, so do not discard those references here.
    && (props.activeConceptIds === undefined
      || (activeConceptIds.has(relation.parentConceptId) && activeConceptIds.has(relation.childConceptId))))
  const visibleExternalHierarchy = externalHierarchy.filter((relation) => relation.status === 'confirmed' || (props.showProposed && relation.status === 'proposed') || relation.status == null)
  const externalHierarchyEdgeKeys = new Set(visibleExternalHierarchy.map((relation) => `concept:${relation.parentConceptId}|concept:${relation.childConceptId}`))
  externalHierarchy.forEach((relation) => {
    if (relation.parentConceptId === relation.childConceptId) return
    const parents = parentsByConcept.get(relation.childConceptId) ?? new Set<string>()
    parents.add(relation.parentConceptId)
    parentsByConcept.set(relation.childConceptId, parents)
    if (relation.status === 'confirmed' || (props.showProposed && relation.status === 'proposed') || relation.status == null) {
      const children = visibleChildrenByParent.get(relation.parentConceptId) ?? new Set<string>()
      children.add(relation.childConceptId)
      visibleChildrenByParent.set(relation.parentConceptId, children)
    }
  })
  if (!externalHierarchyProvided) {
    conceptNodes.forEach((node) => {
      const parentIds = (node.parentIds ?? (node.parentId ? [node.parentId] : []))
        .map((id) => id.startsWith('concept:') ? id.slice('concept:'.length) : id)
        .filter((id) => conceptIds.has(id) && id !== node.refId)
      if (parentIds.length) parentsByConcept.set(node.refId, new Set(parentIds))
    })
  }
  edges.forEach((edge) => {
    if (edge.type !== 'hierarchy') return
    // When the caller supplied the complete relation set, stale snapshot
    // edges must not override status or disclose a proposed child.
    if (externalHierarchyProvided) return
    const source = edge.source.startsWith('concept:') ? edge.source.slice('concept:'.length) : edge.source
    const target = edge.target.startsWith('concept:') ? edge.target.slice('concept:'.length) : edge.target
    if (!conceptIds.has(source) || !conceptIds.has(target) || source === target) return
    const parents = parentsByConcept.get(target) ?? new Set<string>()
    parents.add(source)
    parentsByConcept.set(target, parents)
    const children = visibleChildrenByParent.get(source) ?? new Set<string>()
    children.add(target)
    visibleChildrenByParent.set(source, children)
  })
  if (externalHierarchyProvided) {
    edges = edges.filter((edge) => edge.type !== 'hierarchy' || externalHierarchyEdgeKeys.has(`${edge.source}|${edge.target}`))
  }
  const hasHierarchyMetadata = externalHierarchyProvided
    || conceptNodes.some((node) => node.depth != null || node.parentId != null || (node.parentIds?.length ?? 0) > 0)
    || edges.some((edge) => edge.type === 'hierarchy')
  if (hasHierarchyMetadata && conceptNodes.length) {
    // Parent references are the source of truth. A stale depth value (for
    // example `depth: 0` on an imported child) must never promote a child to
    // the initial root projection.
    const roots = conceptNodes
      .filter((node) => !(parentsByConcept.get(node.refId)?.size))
      .map((node) => node.refId)
    // A cyclic snapshot has no valid root. Keep the strict roots-only view
    // empty until the hierarchy is repaired instead of leaking every node.
    const rootIds = roots
    const expanded = new Set((props.expandedConceptIds ?? []).map((id) => id.startsWith('concept:') ? id.slice('concept:'.length) : id))
    // An explicitly expanded descendant requires its ancestor path to be
    // visible before its own children can be considered.
    ;[...expanded].forEach((id) => {
      const queue = [id]
      const visited = new Set<string>()
      for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index]
        if (visited.has(current)) continue
        visited.add(current)
        ;(parentsByConcept.get(current) ?? new Set<string>()).forEach((parentId) => {
          expanded.add(parentId)
          queue.push(parentId)
        })
      }
    })
    const visibleConceptIds = new Set<string>()
    const queue = rootIds.slice()
    for (let index = 0; index < queue.length; index += 1) {
      const parentId = queue[index]
      if (visibleConceptIds.has(parentId)) continue
      visibleConceptIds.add(parentId)
      if (!expanded.has(parentId)) continue
      ;(visibleChildrenByParent.get(parentId) ?? new Set<string>()).forEach((childId) => {
        if (conceptIds.has(childId) && !visibleConceptIds.has(childId)) queue.push(childId)
      })
    }
    const visibleNodeIds = new Set(nodes.filter((node) => node.type !== 'concept' || visibleConceptIds.has(node.refId)).map((node) => node.id))
    nodes = nodes.filter((node) => visibleNodeIds.has(node.id))
    edges = edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
  }

  const visibleIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
  }
}

function expandedConceptSet(): Set<string> {
  return new Set(props.expandedConceptIds ?? [])
}

function conceptHasChildren(node: GraphNode, edges: GraphEdge[]): boolean {
  const conceptId = node.refId
  const children = mapValue(props.conceptChildren, conceptId) ?? mapValue(props.conceptChildren, `concept:${conceptId}`)
  if (children?.length) return true
  const meta = conceptMeta(conceptId)
  if (meta?.hasChildren || (meta?.childCount ?? 0) > 0) return true
  const dynamicNode = node as GraphNode & { childCount?: number; hasChildren?: boolean }
  if (dynamicNode.hasChildren || (dynamicNode.childCount ?? 0) > 0) return true
  if ((props.expandableConceptIds ?? []).includes(conceptId)) return true
  const conceptNodeId = `concept:${conceptId}`
  if (edges.some((edge) => edge.type === 'hierarchy' && (edge.source === conceptNodeId || edge.source === conceptId))) return true
  // Hierarchy edges are progressively disclosed and therefore may not exist
  // in the current `edges` projection. Use the authoritative relation list so
  // a root remains expandable while its direct children are still hidden.
  const activeIds = props.activeConceptIds === undefined
    ? new Set(props.snapshot.nodes.filter((candidate) => candidate.type === 'concept').map((candidate) => candidate.refId))
    : new Set(props.activeConceptIds)
  return (props.hierarchyRelations ?? []).some((relation) => relation.relationType === 'hierarchy'
    && relation.status !== 'rejected'
    && (relation.status === 'confirmed' || (props.showProposed && relation.status === 'proposed') || relation.status == null)
    && relation.parentConceptId === conceptId
    && relation.childConceptId !== conceptId
    && activeIds.has(relation.parentConceptId)
    && activeIds.has(relation.childConceptId))
}

function nodeRadius(node: GraphNode, fallbackChildCount = 0): number {
  const childCount = node.childCount ?? fallbackChildCount
  const descendantCount = node.descendantCount ?? childCount
  return node.type === 'concept'
    // Hierarchy counts stay stable while disclosure moves evidence and
    // co-occurrence edges between a hidden descendant and its visible parent.
    ? Math.min(42, 16 + Math.log2(descendantCount + 1) * 5.5 + Math.log2(childCount + 1) * 2)
    : node.type === 'unit' ? 11 : 7
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mapSignature<T>(map: Record<string, T> | Map<string, T> | undefined): string {
  if (!map) return ''
  const entries = map instanceof Map ? [...map.entries()] : Object.entries(map)
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${JSON.stringify(value)}`)
    .join('|')
}

function canvasSize(): { width: number; height: number } {
  return {
    width: Math.max(host.value?.clientWidth ?? 0, 480),
    height: Math.max(host.value?.clientHeight ?? 0, 460),
  }
}

function scheduleResizeRender(): void {
  const nextSize = canvasSize()
  if (renderedSize && nextSize.width === renderedSize.width && nextSize.height === renderedSize.height) return
  if (resizeTimer != null) window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null
    const settledSize = canvasSize()
    if (renderedSize && settledSize.width === renderedSize.width && settledSize.height === renderedSize.height) return
    render()
  }, 120)
}

function render(): void {
  if (!svg.value || !host.value) return
  // A cache miss while the graph worker is preparing the requested disclosure
  // used to replace a healthy graph with an empty SVG for one render. Keep the
  // previous projection in place until that response arrives. A truly empty
  // graph still renders normally because it has no previously visible nodes.
  if (props.snapshot.nodes.length === 0
    && lastVisibleNodeIds.size > 0
    && (props.hierarchyRelations?.length ?? 0) > 0) return
  draggingNodeId = null
  const generation = ++renderGeneration
  // A repeated render must first retire all work owned by the previous DOM.
  // Otherwise ResizeObserver bursts can leave several simulations scheduling
  // paint frames against detached selections, which presents as persistent
  // flicker even when the graph topology itself is unchanged.
  simulation?.stop()
  simulation = null
  if (paintFrame != null) {
    cancelAnimationFrame(paintFrame)
    paintFrame = null
  }
  if (fitTimer != null) {
    window.clearTimeout(fitTimer)
    fitTimer = null
  }
  const element = svg.value
  const { width, height } = canvasSize()
  const viewportRightInset = Math.max(0, Math.min(props.viewportRightInset, width - 240))
  const layoutWidth = width - viewportRightInset
  const previousViewportRightInset = lastViewportRightInset
  const viewportInsetChanged = viewportRightInset !== previousViewportRightInset
  lastViewportRightInset = viewportRightInset
  renderedSize = { width, height }
  const root = d3.select(element)
  const snapshot = visibleSnapshot()
  // Worker responses are allowed to arrive with a different insertion order
  // (for example after a promoted Concept becomes a root).  Topology is a set
  // of ids, not an array order; sorting prevents a harmless ordering change
  // from starting a disclosure transition and rebuilding the layout.
  const nodeSignature = snapshot.nodes.map((node) => node.id).sort().join('|')
  const topologyChanged = nodeSignature !== lastNodeSignature
  const previousVisibleNodeIds = lastVisibleNodeIds

  // Preserve the old topology only while disclosing new nodes. A collapse
  // must remove descendants immediately, including from the accessibility
  // tree, and a previous transition clone must never become the next source.
  const nextVisibleNodeIds = new Set(snapshot.nodes.map((node) => node.id))
  const topologyExpanded = snapshot.nodes.some((node) => !previousVisibleNodeIds.has(node.id))
  const topologyContracted = [...previousVisibleNodeIds].some((id) => !nextVisibleNodeIds.has(id))
  const previousViewport = root.select<SVGGElement>('.graph-viewport:not(.graph-transition-old)').node()
  const previousTransitionLayer = !props.reducedMotion && topologyExpanded && !topologyContracted && previousViewport
    ? previousViewport.cloneNode(true) as SVGGElement
    : null
  root.selectAll('*').remove()
  if (previousTransitionLayer) {
    previousTransitionLayer.classList.add('graph-transition-old')
    previousTransitionLayer.setAttribute('pointer-events', 'none')
    previousTransitionLayer.setAttribute('opacity', '1')
    root.node()?.appendChild(previousTransitionLayer)
    d3.select(previousTransitionLayer)
      .transition('graph-disclosure-old')
      .duration(260)
      .attr('opacity', 0)
      .on('end', function () { this.remove() })
  }
  root.attr('viewBox', `0 0 ${width} ${height}`).attr('aria-label', '知识主题图谱')

  const viewport = root.append('g').attr('class', 'graph-viewport')
  const brushLayer = root.append('g').attr('class', 'graph-brush-layer')
  // Shift+拖动留给框选，其余交互仍交给 d3.zoom 的默认过滤规则。
  let restoringViewport = true
  let fittingProgrammatically = false
  // 真实会话的节点密度跨度很大，允许从总览缩到局部细节；边界仍保留，避免画布彻底丢失。
  const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.08, 12]).filter((event) => {
    if ((event.type === 'mousedown' || event.type === 'pointerdown') && event.shiftKey) return false
    return (!event.ctrlKey || event.type === 'wheel') && !event.button
  }).on('zoom', (event) => {
    viewport.attr('transform', event.transform)
    viewport.classed('show-detail-labels', event.transform.k >= 0.85)
    liveTransform = event.transform
    if (!restoringViewport) {
      if (!fittingProgrammatically) userMovedViewport = true
      if (!fittingProgrammatically) emit('viewport-change', { x: event.transform.x, y: event.transform.y, scale: event.transform.k })
    }
  })
  root.call(zoom)
  const initialViewport = props.viewport ?? { x: 0, y: 0, scale: 1 }
  root.call(zoom.transform, liveTransform ?? d3.zoomIdentity.translate(initialViewport.x, initialViewport.y).scale(initialViewport.scale))
  restoringViewport = false

  const links = snapshot.edges.map((edge) => ({ ...edge }))
  const knownNodeIds = previousVisibleNodeIds
  const anchorByNode = new Map<string, string>()
  const childrenByAnchor = new Map<string, string[]>()
  links.forEach((edge) => {
    if (edge.type !== 'hierarchy' && edge.type !== 'association') return
    // Only a deterministic seed for newly disclosed nodes; D3 still settles
    // the final position through the force simulation.
    if (!anchorByNode.has(edge.target)) {
      anchorByNode.set(edge.target, edge.source)
      const siblings = childrenByAnchor.get(edge.source) ?? []
      siblings.push(edge.target)
      childrenByAnchor.set(edge.source, siblings)
    }
  })
  childrenByAnchor.forEach((siblings) => siblings.sort())
  // A user can expand a root before the first simulation tick has populated
  // nodePositions. The previous rendered node set still constitutes a valid
  // layout because deterministic seeds were already painted synchronously.
  const hasPreviousLayout = previousVisibleNodeIds.size > 0
  const seedPositions = new Map(nodePositions)
  // A newly disclosed child may carry a stale persisted coordinate from the
  // full-graph layout. Ignore that coordinate and reseed it around its now
  // visible parent; otherwise the first expansion renders a large jump before
  // the force simulation can correct it.
  if (hasPreviousLayout) {
    snapshot.nodes.forEach((node) => {
      if (!previousVisibleNodeIds.has(node.id) && anchorByNode.has(node.id)) seedPositions.delete(node.id)
    })
  }
  snapshot.nodes.forEach((node) => {
    if (!seedPositions.has(node.id) && node.x != null && node.y != null) {
      seedPositions.set(node.id, { x: node.x, y: node.y })
    }
  })
  // Seed roots before children are mapped. A first-click expansion can happen
  // before the initial force simulation has produced a persisted coordinate;
  // in that case an unseeded child would otherwise default to the canvas
  // center and all siblings could fly into the same corner.
  const hierarchyChildNodeIds = new Set(snapshot.edges
    .filter((edge) => edge.type === 'hierarchy')
    .map((edge) => edge.target))
  // When the relation list is authoritative, stale parentIds on a Worker
  // snapshot must not hide a Concept that was just promoted to a root. Legacy
  // snapshots without that list still use their embedded parent metadata.
  if (props.hierarchyRelations === undefined) {
    snapshot.nodes
      .filter((node) => node.type === 'concept' && (node.parentIds?.length || node.parentId))
      .forEach((node) => hierarchyChildNodeIds.add(node.id))
  }
  const rootConcepts = snapshot.nodes
    .filter((node) => node.type === 'concept' && !hierarchyChildNodeIds.has(node.id))
    .sort((left, right) => left.id.localeCompare(right.id))
  const rootCount = rootConcepts.length
  rootConcepts.forEach((node, rootIndex) => {
    if (seedPositions.has(node.id)) return
    const angle = rootCount > 1 ? (rootIndex / rootCount) * Math.PI * 2 - Math.PI / 2 : 0
    const radius = rootCount > 1 ? Math.min(layoutWidth, height) * 0.24 : 0
    seedPositions.set(node.id, { x: layoutWidth / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius })
  })
  const snapshotNodeById = new Map(snapshot.nodes.map((node) => [node.id, node]))
  // Worker insertion order is not a layout input. Keep fallback seeds stable
  // for unanchored units/messages as well as roots.
  const stableNodeIndex = new Map(snapshot.nodes.slice().sort((left, right) => left.id.localeCompare(right.id)).map((node, index) => [node.id, index]))
  const ensureSeedPosition = (nodeId: string, visiting = new Set<string>()): { x: number; y: number } | undefined => {
    const existing = seedPositions.get(nodeId)
    if (existing) return existing
    if (visiting.has(nodeId)) return undefined
    visiting.add(nodeId)
    const anchorId = anchorByNode.get(nodeId)
    const anchor = anchorId ? ensureSeedPosition(anchorId, visiting) : undefined
    const node = snapshotNodeById.get(nodeId)
    if (!node) return anchor
    const index = stableNodeIndex.get(nodeId) ?? 0
    const siblings = anchorId ? (childrenByAnchor.get(anchorId) ?? []) : []
    const siblingIndex = siblings.indexOf(nodeId)
    const ringCapacity = node.type === 'concept' ? 8 : 12
    const ring = siblingIndex >= 0 ? Math.floor(siblingIndex / ringCapacity) : 0
    const ringIndex = siblingIndex >= 0 ? siblingIndex % ringCapacity : index
    const ringSize = siblingIndex >= 0 ? Math.min(ringCapacity, siblings.length - ring * ringCapacity) : 1
    const angleOffset = anchorId ? (stableHash(anchorId) % 6283) / 1000 : (stableHash(node.id) % 6283) / 1000
    const angle = angleOffset + (ringIndex / Math.max(ringSize, 1)) * Math.PI * 2
    const baseRadius = node.type === 'concept' ? 112 : node.type === 'unit' ? 62 : 44
    const radius = baseRadius + ring * (node.type === 'concept' ? 58 : 34)
    const position = { x: (anchor?.x ?? layoutWidth / 2) + Math.cos(angle) * radius, y: (anchor?.y ?? height / 2) + Math.sin(angle) * radius }
    seedPositions.set(nodeId, position)
    return position
  }
  const nodes = snapshot.nodes.map((node, index) => {
    const position = ensureSeedPosition(node.id)
    const copy = { ...node } as GraphNode & d3.SimulationNodeDatum
    if (position) {
      copy.x = position.x
      copy.y = position.y
    } else if (!copy.fixed || copy.x == null || copy.y == null) {
      // D3 默认的随机初始位置会在展开时制造明显的闪跳；确定性散点
      // 只用于新节点，随后交给力导向微调。
      // Seed disclosed children around their stable parent. Falling back to a
      // deterministic spiral avoids D3's random jump for legacy snapshots.
      const anchorId = anchorByNode.get(node.id)
      const anchor = anchorId ? seedPositions.get(anchorId) : undefined
      const angle = (stableHash(node.id) % 6283) / 1000 + (stableNodeIndex.get(node.id) ?? index) * 0.17
      const radius = node.type === 'concept' ? 76 : node.type === 'unit' ? 48 : 34
      copy.x = (anchor?.x ?? layoutWidth / 2) + Math.cos(angle) * radius
      copy.y = (anchor?.y ?? height / 2) + Math.sin(angle) * radius
    }
    if (copy.x != null && copy.y != null) seedPositions.set(node.id, { x: copy.x, y: copy.y })
    return copy
  })
  const largeGraph = nodes.length > 220 || snapshot.edges.length > 420
  viewport.classed('is-large', largeGraph)
  if (!nodes.length && !userMovedViewport) hasFittedData = false
  lastNodeSignature = nodeSignature
  lastVisibleNodeIds = new Set(nodes.map((node) => node.id))
  const shouldFitView = nodes.length > 0 && (viewportInsetChanged || (!userMovedViewport && (!hasFittedData || (topologyChanged && props.fitOnTopologyChange))))
  nodes.forEach((node) => {
    if (node.fixed && node.x != null && node.y != null) {
      node.fx = node.x
      node.fy = node.y
    }
  })
  // During a disclosure render, hold the existing topology in place for the
  // lifetime of this simulation while newly revealed children settle around
  // their parent. Releasing and reheating these nodes on a timer produces a
  // delayed second movement that users perceive as graph flicker.
  const anchoredNodes = (topologyChanged || viewportInsetChanged) && hasPreviousLayout
    ? nodes.filter((node) => knownNodeIds.has(node.id) && !node.fixed && node.x != null && node.y != null)
    : []
  anchoredNodes.forEach((node) => {
    node.fx = node.x
    node.fy = node.y
  })
  // Keep newly disclosed hierarchy children at their deterministic radial
  // seeds for a short settling window. Releasing them immediately lets the
  // charge/center forces fling a first-click expansion toward a corner before
  // the parent-child spring has had a chance to act.
  const newlySeededNodes = topologyChanged && hasPreviousLayout
    ? nodes.filter((node) => !knownNodeIds.has(node.id) && node.x != null && node.y != null && !node.fixed)
    : []
  newlySeededNodes.forEach((node) => {
    node.fx = node.x
    node.fy = node.y
  })
  const linkLayer = viewport.append('g').attr('class', 'graph-links')
  const nodeLayer = viewport.append('g').attr('class', 'graph-nodes')

  const linkSelection = linkLayer
    .selectAll<SVGLineElement, GraphEdge>('line')
    .data(links, (edge) => edge.id)
    .join('line')
    .attr('class', (edge) => {
      const source = typeof edge.source === 'string' ? edge.source : String(edge.source)
      const target = typeof edge.target === 'string' ? edge.target : String(edge.target)
      return `graph-link${source.startsWith('unit:') || target.startsWith('unit:') ? ' graph-link-unit' : ''}`
    })
    .attr('data-edge-id', (edge) => edge.id)
    .attr('data-edge-type', (edge) => edge.type)
    .attr('stroke', edgeColor)
    .attr('stroke-width', edgeWidth)
    .attr('stroke-dasharray', (edge) => (edge.status === 'proposed' || edge.type === 'related' || edge.type === 'conversation' ? '5 5' : null))
    .attr('stroke-linecap', 'round')
    .attr('vector-effect', 'non-scaling-stroke')
    .attr('marker-end', (edge) => (edge.type === 'hierarchy' ? 'url(#graph-arrow)' : null))

  const defs = root.append('defs')
  defs
    .append('marker')
    .attr('id', 'graph-arrow')
    .attr('viewBox', '0 -5 10 10')
    // edgePoints() already clips the line to the target circle. Anchor the
    // arrow tip at that clipped endpoint instead of applying the old
    // center-line offset a second time.
    .attr('refX', 10)
    .attr('refY', 0)
    .attr('markerWidth', 5)
    .attr('markerHeight', 5)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', '#2c6e9e')

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  // Older Worker payloads omitted childCount/descendantCount. Derive the
  // direct hierarchy count from the visible projection so node size remains a
  // useful scope cue even while a stale response is being replaced.
  const hierarchyChildCountByNode = new Map<string, number>()
  links.forEach((edge) => {
    if (edge.type !== 'hierarchy') return
    hierarchyChildCountByNode.set(edge.source, (hierarchyChildCountByNode.get(edge.source) ?? 0) + 1)
  })
  const radiusForNode = (node: GraphNode): number => nodeRadius(node, hierarchyChildCountByNode.get(node.id) ?? 0)
  const edgePoints = (edge: GraphEdge): { x1: number; y1: number; x2: number; y2: number } => {
    const source = (typeof edge.source === 'string' ? nodeById.get(edge.source) : edge.source as unknown as GraphNode & d3.SimulationNodeDatum)
    const target = (typeof edge.target === 'string' ? nodeById.get(edge.target) : edge.target as unknown as GraphNode & d3.SimulationNodeDatum)
    const sx = source?.x ?? 0
    const sy = source?.y ?? 0
    const tx = target?.x ?? 0
    const ty = target?.y ?? 0
    const dx = tx - sx
    const dy = ty - sy
    const distance = Math.hypot(dx, dy) || 1
    const sourceRadius = source ? radiusForNode(source) + 2 : 0
    const targetRadius = target ? radiusForNode(target) + 2 : 0
    return {
      x1: sx + (dx / distance) * sourceRadius,
      y1: sy + (dy / distance) * sourceRadius,
      x2: tx - (dx / distance) * targetRadius,
      y2: ty - (dy / distance) * targetRadius,
    }
  }

  const expanded = expandedConceptSet()
  const hasAuthoritativeExpansionState = props.expandedConceptIds !== undefined
  const isExpanded = (node: GraphNode): boolean => hasAuthoritativeExpansionState
    ? expanded.has(node.refId)
    : node.expanded === true
  const nodeSelection = nodeLayer
    .selectAll<SVGGElement, GraphNode & d3.SimulationNodeDatum>('g')
    .data(nodes, (node) => node.id)
    .join((enter) => {
      const group = enter
        .append('g')
        .attr('class', 'graph-node')
        .attr('tabindex', 0)
        .attr('role', 'button')
      group
        .append('circle')
        .attr('class', 'graph-node-shape')
        .attr('r', radiusForNode)
        .attr('fill', (node) => palette[node.type])
      group
        .append('text')
        .attr('class', (node) => `graph-node-label graph-node-label-${node.type}`)
        .attr('dy', (node) => (node.type === 'concept' ? radiusForNode(node) + 15 : radiusForNode(node) + 17))
        .text((node) => node.label)
      group
        .append('title')
        .text((node) => `${cleanGraphText(node.label) || node.label} · ${cleanGraphText(node.subtitle) || node.type}`)
      return group
    })

  nodeSelection
    .attr('data-node-type', (node) => node.type)
    .attr('data-ref-id', (node) => node.refId)
    .attr('data-depth', (node) => nodeLevel(node) == null ? null : String(nodeLevel(node)))
    .attr('data-expanded', (node) => node.type === 'concept' ? String(isExpanded(node)) : null)
    .attr('aria-expanded', (node) => node.type === 'concept' && conceptHasChildren(node, links) ? String(isExpanded(node)) : null)
    .attr('aria-label', (node) => {
      if (node.type !== 'concept') return `${node.label} · ${node.subtitle ?? node.type}`
      if (!conceptHasChildren(node, links)) return `${node.label} · 打开详情`
      return `${node.label} · ${isExpanded(node) ? '收起子主题' : '展开子主题'}并打开详情`
    })
    .classed('is-expandable', (node) => node.type === 'concept' && conceptHasChildren(node, links))
  nodeSelection.select<SVGCircleElement>('.graph-node-shape')
    .attr('r', radiusForNode)
    .attr('fill', (node) => palette[node.type])
  nodeSelection.select<SVGTextElement>('.graph-node-label')
    .attr('dy', (node) => (node.type === 'concept' ? radiusForNode(node) + 15 : radiusForNode(node) + 17))
    .text((node) => cleanGraphText(node.label) || node.label)
  nodeSelection.classed('is-selected', (node) => node.type === 'unit' && props.selectedUnitIds.includes(node.refId))

  // Topology changes keep their existing coordinates, then gently reveal newly
  // disclosed nodes and links. The force simulation supplies the continuous
  // movement; this opacity transition keeps expand/collapse from flashing.
  if (!props.reducedMotion && topologyChanged) {
    nodeSelection
      .attr('opacity', (node) => knownNodeIds.has(node.id) ? 1 : 0)
      .transition('graph-disclosure')
      .duration(240)
      .attr('opacity', 1)
    linkSelection
      .attr('opacity', (edge) => knownNodeIds.has(String(edge.source)) && knownNodeIds.has(String(edge.target)) ? 1 : 0)
      .transition('graph-disclosure')
      .duration(220)
      .attr('opacity', 1)
  }

  const activateNode = (event: MouseEvent | KeyboardEvent, node: GraphNode): void => {
    if (node.type === 'concept') {
      emit('select-concept', node.refId)
      if (conceptHasChildren(node, links)) emit('toggle-concept', node.refId, !isExpanded(node))
      return
    }
    if (node.type === 'unit') emit('select-unit', node.refId, event.ctrlKey || event.metaKey)
    if (node.type === 'message') emit('select-message', node.refId)
  }
  const adjacency = new Map<string, Set<string>>()
  links.forEach((link) => {
    const source = typeof link.source === 'string' ? link.source : String(link.source)
    const target = typeof link.target === 'string' ? link.target : String(link.target)
    const sourceSet = adjacency.get(source) ?? new Set<string>()
    const targetSet = adjacency.get(target) ?? new Set<string>()
    sourceSet.add(target)
    targetSet.add(source)
    adjacency.set(source, sourceSet)
    adjacency.set(target, targetSet)
  })
  const clearHighlight = (): void => {
    nodeSelection.classed('is-hovered is-neighbor is-dimmed', false)
    linkSelection.classed('is-hovered is-dimmed', false)
  }
  const highlightNode = (nodeId: string): void => {
    const neighbors = adjacency.get(nodeId) ?? new Set<string>()
    nodeSelection
      .classed('is-hovered', (node) => node.id === nodeId)
      .classed('is-neighbor', (node) => neighbors.has(node.id))
      .classed('is-dimmed', (node) => node.id !== nodeId && !neighbors.has(node.id))
    linkSelection
      .classed('is-hovered', (link) => {
        const source = typeof link.source === 'string' ? link.source : (link.source as unknown as GraphNode).id
        const target = typeof link.target === 'string' ? link.target : (link.target as unknown as GraphNode).id
        return source === nodeId || target === nodeId
      })
      .classed('is-dimmed', (link) => {
        const source = typeof link.source === 'string' ? link.source : (link.source as unknown as GraphNode).id
        const target = typeof link.target === 'string' ? link.target : (link.target as unknown as GraphNode).id
        return source !== nodeId && target !== nodeId
      })
  }
  nodeSelection
    .on('mouseenter', (_event, node) => {
      if (draggingNodeId && draggingNodeId !== node.id) return
      highlightNode(node.id)
    })
    .on('mouseleave', () => {
      // Dragging moves the element under a stationary pointer. Ignore the
      // synthetic leave/enter pairs this produces until the drag ends.
      if (!draggingNodeId) clearHighlight()
    })
    .on('click', (event, node) => {
      event.stopPropagation()
      // D3 emits a native click after a drag gesture. A moved node should
      // keep its position without accidentally toggling its disclosure.
      if (suppressClickNodeId === node.id) {
        suppressClickNodeId = null
        if (suppressClickTimer != null) window.clearTimeout(suppressClickTimer)
        suppressClickTimer = null
        return
      }
      activateNode(event, node)
    })
    .on('keydown', (event, node) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      activateNode(event, node)
    })

  const drag = d3
    .drag<SVGGElement, GraphNode & d3.SimulationNodeDatum>()
    .on('start', (event, node) => {
      draggingNodeId = node.id
      dragStartPoint = { x: event.x, y: event.y }
      dragMoved = false
      draggedDescendants = new Map<string, { x: number; y: number }>()
      dragPinnedNodes = new Map<string, { x: number; y: number }>()
      highlightNode(node.id)
      // Reheat the springs while dragging so connected nodes follow the
      // pointer instead of feeling pinned in place. Keep the target finite;
      // an unlimited alpha target makes dense imported graphs oscillate.
      if (!event.active) simulation?.alphaTarget(0.18).restart()
      node.fx = node.x
      node.fy = node.y
      if (node.type === 'concept') {
        const childrenByParent = new Map<string, string[]>()
        links.forEach((link) => {
          if (link.type !== 'hierarchy') return
          const source = typeof link.source === 'string' ? link.source : (link.source as unknown as GraphNode).id
          const target = typeof link.target === 'string' ? link.target : (link.target as unknown as GraphNode).id
          childrenByParent.set(source, [...(childrenByParent.get(source) ?? []), target])
        })
        const queue = [node.id]
        const seen = new Set(queue)
        for (let index = 0; index < queue.length; index += 1) {
          const parentId = queue[index]
          ;(childrenByParent.get(parentId) ?? []).forEach((childId) => {
            if (seen.has(childId)) return
            seen.add(childId)
            queue.push(childId)
            const child = nodeById.get(childId)
            if (child?.x != null && child.y != null) draggedDescendants.set(childId, { x: child.x, y: child.y })
          })
        }
      }
      // The center force acts on every component. Pin nodes outside the
      // dragged component for the duration of the gesture so an unrelated
      // cluster remains visually stationary while this component is moved.
      const componentIds = new Set<string>([node.id])
      const componentQueue = [node.id]
      const componentEdges = new Map<string, string[]>()
      links.forEach((link) => {
        const source = typeof link.source === 'string' ? link.source : (link.source as unknown as GraphNode).id
        const target = typeof link.target === 'string' ? link.target : (link.target as unknown as GraphNode).id
        componentEdges.set(source, [...(componentEdges.get(source) ?? []), target])
        componentEdges.set(target, [...(componentEdges.get(target) ?? []), source])
      })
      for (let index = 0; index < componentQueue.length; index += 1) {
        ;(componentEdges.get(componentQueue[index]) ?? []).forEach((neighbor) => {
          if (componentIds.has(neighbor)) return
          componentIds.add(neighbor)
          componentQueue.push(neighbor)
        })
      }
      nodes.forEach((candidate) => {
        if (componentIds.has(candidate.id) || candidate.fixed || candidate.x == null || candidate.y == null) return
        dragPinnedNodes.set(candidate.id, { x: candidate.x, y: candidate.y })
        candidate.fx = candidate.x
        candidate.fy = candidate.y
      })
    })
    .on('drag', (event, node) => {
      if (dragStartPoint && (Math.abs(event.x - dragStartPoint.x) > 4 || Math.abs(event.y - dragStartPoint.y) > 4)) dragMoved = true
      node.fx = event.x
      node.fy = event.y
      const dx = dragStartPoint ? event.x - dragStartPoint.x : 0
      const dy = dragStartPoint ? event.y - dragStartPoint.y : 0
      draggedDescendants.forEach((position, childId) => {
        const child = nodeById.get(childId)
        if (!child || child.fixed) return
        child.fx = position.x + dx
        child.fy = position.y + dy
        child.x = position.x + dx
        child.y = position.y + dy
      })
    })
    .on('end', (event, node) => {
      if (!event.active) {
        simulation?.alphaTarget(0)
        // Give the revised links one short settling pass after the pointer is
        // released. This makes the elastic response visible without leaving
        // the simulation running indefinitely.
        if (simulation && !props.reducedMotion) simulation.alpha(Math.max(simulation.alpha(), 0.14)).restart()
      }
      node.fx = event.x
      node.fy = event.y
      draggedDescendants.forEach((_position, childId) => {
        const child = nodeById.get(childId)
        if (!child || child.fixed) return
        if (child.x != null && child.y != null) nodePositions.set(child.id, { x: child.x, y: child.y })
        child.fx = null
        child.fy = null
      })
      draggedDescendants.clear()
      dragPinnedNodes.forEach((_position, pinnedId) => {
        const pinned = nodeById.get(pinnedId)
        if (!pinned || pinned.fixed) return
        pinned.fx = null
        pinned.fy = null
      })
      dragPinnedNodes.clear()
      // Keep the in-memory seed in sync with the persisted layout immediately;
      // a disclosure render can happen before the next simulation tick.
      nodePositions.set(node.id, { x: event.x, y: event.y })
      if (dragMoved) {
        suppressClickNodeId = node.id
        if (suppressClickTimer != null) window.clearTimeout(suppressClickTimer)
        suppressClickTimer = window.setTimeout(() => {
          suppressClickNodeId = null
          suppressClickTimer = null
        }, 600)
      }
      dragStartPoint = null
      dragMoved = false
      draggingNodeId = null
      clearHighlight()
      emit('layout-change', { nodeType: node.type, refId: node.refId, x: event.x, y: event.y, fixed: true })
    })
  nodeSelection.call(drag)

  const linkForce = d3
    .forceLink<GraphNode & d3.SimulationNodeDatum, GraphEdge>(links)
    .id((node) => node.id)
    // Keep the semantic hierarchy visibly elastic while giving conversation
    // chains enough room to read as a sequence. These values are deliberately
    // stronger than the previous conservative profile; damping below keeps
    // the result from becoming a runaway spring system.
    .distance((edge) => {
      if (edge.type === 'hierarchy') return 148
      if (edge.type === 'conversation') return 86
      if (edge.type === 'association') return 112
      if (edge.type === 'related') return 176
      if (edge.type === 'co_occurrence') return 166
      return 150
    })
    .strength((edge) => {
      if (edge.type === 'hierarchy') return 0.94
      if (edge.type === 'conversation') return 0.08
      if (edge.type === 'association') return 0.07
      if (edge.type === 'related') return 0.035
      if (edge.type === 'manual') return 0.06
      return Math.min(0.12, 0.035 + edge.weight * 0.012)
    })
    .iterations(largeGraph ? 1 : 2)
  const chargeForce = d3
    .forceManyBody<GraphNode & d3.SimulationNodeDatum>()
    .strength((node) => (node as GraphNode).type === 'concept' ? -340 : -145)
    .distanceMax(Math.max(layoutWidth, height) * (largeGraph ? 1.1 : 1.6))
  simulation = d3
    .forceSimulation(nodes)
    // Explicit springs + repulsion + collision keep related nodes connected
    // without letting dense sessions collapse into one pile.
    .force('link', linkForce)
    .force('charge', chargeForce)
    .force('center', d3.forceCenter(layoutWidth / 2, height / 2))
    .force('x', d3.forceX<GraphNode & d3.SimulationNodeDatum>(layoutWidth / 2).strength(largeGraph ? 0.014 : 0.02))
    .force('y', d3.forceY<GraphNode & d3.SimulationNodeDatum>(height / 2).strength(largeGraph ? 0.014 : 0.02))
    .force('collide', d3.forceCollide<GraphNode & d3.SimulationNodeDatum>().radius((node) => (node as GraphNode).type === 'concept' ? 50 : 28).strength(0.86).iterations(largeGraph ? 1 : 2))
    .velocityDecay(largeGraph ? 0.68 : 0.64)
  if (newlySeededNodes.length && !props.reducedMotion) {
    window.setTimeout(() => {
      if (generation !== renderGeneration) return
      newlySeededNodes.forEach((node) => {
        if (!node.fixed) {
          node.fx = null
          node.fy = null
        }
      })
      simulation?.alpha(Math.max(simulation.alpha(), 0.18)).restart()
    }, 280)
  }
  let paintPending = false
  const paint = (): void => {
      linkSelection
        .attr('x1', (edge) => edgePoints(edge).x1)
        .attr('y1', (edge) => edgePoints(edge).y1)
        .attr('x2', (edge) => edgePoints(edge).x2)
        .attr('y2', (edge) => edgePoints(edge).y2)
      nodeSelection.attr('transform', (node) => `translate(${node.x ?? layoutWidth / 2},${node.y ?? height / 2})`)
  }
  // Paint the seeded positions before the first physics tick. Topology
  // updates can otherwise leave one rendered frame with an empty canvas.
  paint()
  let tickCount = 0
  simulation.on('tick', () => {
    tickCount += 1
    // Layout coordinates only need to be retained at frame cadence. Avoid
    // allocating a map entry on every physics tick for large imported graphs.
    if (tickCount % (largeGraph ? 3 : 1) === 0) nodes.forEach((node) => {
      if (node.x != null && node.y != null) nodePositions.set(node.id, { x: node.x, y: node.y })
    })
    if (paintPending) return
    paintPending = true
    paintFrame = requestAnimationFrame(() => {
      paintFrame = null
      paintPending = false
      if (generation === renderGeneration) paint()
    })
  })
  if (props.reducedMotion) {
    // Reduced motion must not leave an asynchronous force animation running.
    // Settle a small deterministic number of ticks and paint once.
    simulation.stop().alphaDecay(0.5).tick(largeGraph ? 8 : 12)
    nodes.forEach((node) => {
      if (node.x != null && node.y != null) nodePositions.set(node.id, { x: node.x, y: node.y })
    })
    paint()
  } else if (largeGraph) simulation.alphaDecay(0.045).alpha(0.3)
  else if (hasPreviousLayout) simulation.alphaDecay(0.04).alpha(0.24)
  else simulation.alphaDecay(0.05).alpha(0.62)

  // 首次挂载且用户未操作时，等力向布局稳定后只适配一次画布，避免每个 tick 触发 zoom 重排。
  if (shouldFitView) {
    let fitted = false
    const fitView = (freeze = false): void => {
      if (fitted || (!viewportInsetChanged && userMovedViewport) || generation !== renderGeneration) return
      // Opening a detail panel changes the available width, but must not
      // re-run the force fit over an already stable graph. Translate the
      // existing viewport by half of the inset delta and keep every node at
      // its previous coordinate; this avoids a visible jump/flicker.
      if (viewportInsetChanged && hasFittedData && liveTransform) {
        fitted = true
        fittingProgrammatically = true
        root.call(zoom.transform, liveTransform.translate((previousViewportRightInset - viewportRightInset) / 2, 0))
        fittingProgrammatically = false
        return
      }
      const xs = nodes.map((node) => node.x).filter((value) => value != null) as number[]
      const ys = nodes.map((node) => node.y).filter((value) => value != null) as number[]
      if (!xs.length) return
      const minX = Math.min(...xs) - 60
      const maxX = Math.max(...xs) + 60
      const minY = Math.min(...ys) - 60
      const maxY = Math.max(...ys) + 60
      // 大量消息节点的布局跨度可能超过画布，允许缩到 zoom 下限后再由用户放大查看。
      const scale = Math.min(1.4, Math.max(0.1, Math.min(layoutWidth / Math.max(maxX - minX, 1), height / Math.max(maxY - minY, 1))))
      const transform = d3.zoomIdentity.translate(layoutWidth / 2, height / 2).scale(scale).translate(-(minX + maxX) / 2, -(minY + maxY) / 2)
      fitted = true
      hasFittedData = true
      if (freeze) simulation?.stop()
      fittingProgrammatically = true
      root.call(zoom.transform, transform)
      fittingProgrammatically = false
    }
    simulation.on('end.fit', fitView)
    if (props.reducedMotion || viewportInsetChanged) {
      fitView()
    } else {
      // 极大图谱或后台节流时 end 事件可能很晚，给用户一个确定的最终视口。
      fitTimer = window.setTimeout(() => {
        fitTimer = null
        // 超大图谱的力向计算可能被后台节流；此时冻结当前布局并适配，
        // 避免节点在适配后继续漂移到画布外。
        fitView(true)
      }, largeGraph ? 2600 : 6000)
    }
  }

  // 框选多选：Shift+左键拖出选框，松开后把框内阅读片段加入上下文选择。
  let brushOrigin: [number, number] | null = null
  const brushRect = brushLayer
    .append('rect')
    .attr('class', 'graph-brush')
    .attr('visibility', 'hidden')
    .attr('fill', 'rgba(44,110,158,.12)')
    .attr('stroke', '#2c6e9e')
    .attr('stroke-dasharray', '4 3')
  const pointerPoint = (event: PointerEvent): [number, number] => {
    const bounds = element.getBoundingClientRect()
    return [(event.clientX - bounds.left) * (width / Math.max(bounds.width, 1)), (event.clientY - bounds.top) * (height / Math.max(bounds.height, 1))]
  }
  const finishBrush = (event: PointerEvent): void => {
    if (!brushOrigin) return
    const [x0, y0] = brushOrigin
    const [x1, y1] = pointerPoint(event)
    brushOrigin = null
    brushRect.attr('visibility', 'hidden')
    if (Math.abs(x1 - x0) < 6 || Math.abs(y1 - y0) < 6) return
    const transform = d3.zoomTransform(element)
    const topLeft = transform.invert([Math.min(x0, x1), Math.min(y0, y1)])
    const bottomRight = transform.invert([Math.max(x0, x1), Math.max(y0, y1)])
    let selectedCount = 0
    nodes.forEach((node) => {
      if (node.type !== 'unit' || node.x == null || node.y == null) return
      if (node.x >= topLeft[0] && node.x <= bottomRight[0] && node.y >= topLeft[1] && node.y <= bottomRight[1]) {
        selectedCount += 1
        emit('box-select-unit', node.refId)
      }
    })
    brushSelectionCount.value = selectedCount
  }
  root.on('pointerdown.graph-brush', (event: PointerEvent) => {
    if (!event.shiftKey || event.button !== 0) return
    if ((event.target as Element).closest('.graph-node')) return
    event.preventDefault()
    ;(event.currentTarget as SVGSVGElement).setPointerCapture?.(event.pointerId)
    brushOrigin = pointerPoint(event)
    brushRect.attr('x', brushOrigin[0]).attr('y', brushOrigin[1]).attr('width', 0).attr('height', 0).attr('visibility', 'visible')
  })
  root.on('pointermove.graph-brush', (event: PointerEvent) => {
    if (!brushOrigin) return
    event.preventDefault()
    const [x0, y0] = brushOrigin
    const [x1, y1] = pointerPoint(event)
    brushRect.attr('x', Math.min(x0, x1)).attr('y', Math.min(y0, y1)).attr('width', Math.abs(x1 - x0)).attr('height', Math.abs(y1 - y0))
  })
  root.on('pointerup.graph-brush', finishBrush)
  root.on('pointercancel.graph-brush', finishBrush)
}

onMounted(() => {
  render()
  if (host.value) {
    resizeObserver = new ResizeObserver(() => {
      scheduleResizeRender()
    })
    resizeObserver.observe(host.value)
  }
})

// 视口以 liveTransform 为准；展开状态/层级窗口变化也需要更新控件，
// 但不会因为选中状态变化而重建力向布局。
watch(() => {
  const nodes = props.snapshot.nodes
    .map((node) => `${node.id}:${node.label}:${node.subtitle ?? ''}:${node.childCount ?? ''}:${node.descendantCount ?? ''}:${node.hasChildren ? 1 : 0}`)
    .sort()
    .join('|')
  const edges = props.snapshot.edges
    .map((edge) => `${edge.id}:${edge.source}:${edge.target}:${edge.type}:${edge.status ?? ''}:${edge.weight}`)
    .sort()
    .join('|')
  const expanded = (props.expandedConceptIds ?? []).slice().sort().join(',')
  const expandable = (props.expandableConceptIds ?? []).slice().sort().join(',')
  const activeConceptIds = props.activeConceptIds?.slice().sort().join(',') ?? 'unspecified'
  const hierarchy = props.hierarchyRelations?.map((relation) => `${relation.parentConceptId}:${relation.childConceptId}:${relation.relationType}:${relation.status ?? ''}`).sort().join('|') ?? 'unspecified'
  // A graph revision can advance for unrelated store work while the rendered
  // topology and labels remain identical.  Rebuilding D3 in that case causes
  // visible flashing and resets the force simulation, so the revision itself
  // is deliberately omitted from this visual identity.
  return `${nodes}|${edges}|${expanded}|${expandable}|${activeConceptIds}|${hierarchy}|${props.showProposed ? 1 : 0}|${props.reducedMotion ? 1 : 0}|${props.maxVisibleLevel ?? ''}|${props.expandedConceptDepth ?? ''}|${props.visibleNodeDepth ?? ''}|${typeof props.visibleNodeLevels === 'number' ? props.visibleNodeLevels : mapSignature(props.visibleNodeLevels)}|${mapSignature(props.conceptHierarchy)}|${mapSignature(props.conceptChildren)}|${props.fitOnTopologyChange ? 1 : 0}|${props.viewportRightInset}`
}, render)

watch(() => props.selectedUnitIds.slice(), (selectedIds) => {
  if (!svg.value) return
  d3.select(svg.value).selectAll<SVGGElement, GraphNode>('.graph-node').classed('is-selected', (node) => node.type === 'unit' && selectedIds.includes(node.refId))
})

onBeforeUnmount(() => {
  renderGeneration += 1
  if (fitTimer != null) window.clearTimeout(fitTimer)
  if (resizeTimer != null) window.clearTimeout(resizeTimer)
  if (suppressClickTimer != null) window.clearTimeout(suppressClickTimer)
  if (paintFrame != null) cancelAnimationFrame(paintFrame)
  simulation?.stop()
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="host" class="graph-canvas">
    <svg ref="svg" role="group" />
    <div v-if="brushSelectionCount" class="graph-selection-feedback" role="status">已选 {{ brushSelectionCount }} 个阅读片段</div>
    <div class="graph-scale-hint">
      <span class="legend-dot concept-dot" /> 知识主题
      <span class="legend-dot unit-dot" /> 阅读片段
      <span class="legend-dot message-dot" /> 消息
      <span class="graph-hint">滚轮缩放 · 拖拽平移/定位 · Shift+拖动框选阅读片段 · 点击主题逐层展开</span>
    </div>
  </div>
</template>

<style>
</style>
