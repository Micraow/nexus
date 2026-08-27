<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as d3 from 'd3'
import type { GraphEdge, GraphNode, GraphSnapshot, GraphViewport } from '@/types/domain'

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
    expandableConceptIds?: string[]
    /** Opt in to fitting after a topology update; disabled by default. */
    fitOnTopologyChange?: boolean
  }>(),
  {
    selectedUnitIds: () => [],
    reducedMotion: false,
    viewport: () => ({ x: 0, y: 0, scale: 1, layoutVersion: 1 }),
    expandedConceptIds: () => [],
    visibleNodeLevels: undefined,
    maxVisibleLevel: undefined,
    expandedConceptDepth: undefined,
    visibleNodeDepth: undefined,
    conceptHierarchy: undefined,
    conceptChildren: undefined,
    expandableConceptIds: () => [],
    fitOnTopologyChange: false,
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
let draggingNodeId: string | null = null
let dragStartPoint: { x: number; y: number } | null = null
let dragMoved = false
let suppressClickNodeId: string | null = null
let suppressClickTimer: number | null = null
let lastNodeSignature = ''

const palette: Record<string, string> = {
  concept: '#2c6e9e',
  unit: '#7b8794',
  message: '#b9c3cc',
}

function edgeColor(edge: GraphEdge): string {
  if (edge.type === 'hierarchy') return '#2c6e9e'
  if (edge.type === 'related') return '#5d7f94'
  if (edge.type === 'conversation') return '#c18d30'
  if (edge.type === 'association') return '#879eae'
  return '#71899a'
}

function edgeWidth(edge: GraphEdge): number {
  if (edge.type === 'co_occurrence') return Math.min(4, 0.8 + Math.log2(edge.weight + 1) * 0.7)
  if (edge.type === 'hierarchy') return 1.35
  if (edge.type === 'manual') return 1.1
  return edge.type === 'related' ? 0.95 : 0.85
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
  if (maxLevel == null) return { nodes: props.snapshot.nodes, edges: props.snapshot.edges }
  const nodes = props.snapshot.nodes.filter((node) => {
    const level = nodeLevel(node)
    return level == null || level <= maxLevel
  })
  const visibleIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: props.snapshot.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
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
  return edges.some((edge) => edge.type === 'hierarchy' && (edge.source === conceptNodeId || edge.source === conceptId))
}

function nodeRadius(node: GraphNode): number {
  return node.type === 'concept'
    ? Math.min(31, 16 + Math.sqrt(node.unitCount) * 4)
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

function render(): void {
  if (!svg.value || !host.value) return
  draggingNodeId = null
  const generation = ++renderGeneration
  if (fitTimer != null) {
    window.clearTimeout(fitTimer)
    fitTimer = null
  }
  const element = svg.value
  const width = Math.max(host.value.clientWidth, 480)
  const height = Math.max(host.value.clientHeight, 460)
  const root = d3.select(element)
  root.selectAll('*').remove()
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

  const snapshot = visibleSnapshot()
  const links = snapshot.edges.map((edge) => ({ ...edge }))
  const anchorByNode = new Map<string, string>()
  links.forEach((edge) => {
    if (edge.type !== 'hierarchy' && edge.type !== 'association') return
    // Only a deterministic seed for newly disclosed nodes; D3 still settles
    // the final position through the force simulation.
    if (!anchorByNode.has(edge.target)) anchorByNode.set(edge.target, edge.source)
  })
  const hasPreviousLayout = nodePositions.size > 0
  const seedPositions = new Map(nodePositions)
  snapshot.nodes.forEach((node) => {
    if (!seedPositions.has(node.id) && node.x != null && node.y != null) {
      seedPositions.set(node.id, { x: node.x, y: node.y })
    }
  })
  const nodes = snapshot.nodes.map((node, index) => {
    const position = nodePositions.get(node.id)
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
      const angle = (stableHash(node.id) % 6283) / 1000 + index * 0.17
      const radius = node.type === 'concept' ? 76 : node.type === 'unit' ? 48 : 34
      copy.x = (anchor?.x ?? width / 2) + Math.cos(angle) * radius
      copy.y = (anchor?.y ?? height / 2) + Math.sin(angle) * radius
    }
    if (copy.x != null && copy.y != null) seedPositions.set(node.id, { x: copy.x, y: copy.y })
    return copy
  })
  const largeGraph = nodes.length > 220 || snapshot.edges.length > 420
  viewport.classed('is-large', largeGraph)
  if (!nodes.length && !userMovedViewport) hasFittedData = false
  const nodeSignature = nodes.map((node) => node.id).join('|')
  const topologyChanged = nodeSignature !== lastNodeSignature
  lastNodeSignature = nodeSignature
  const shouldFitView = !userMovedViewport && nodes.length > 0 && (!hasFittedData || (topologyChanged && props.fitOnTopologyChange))
  nodes.forEach((node) => {
    if (node.fixed && node.x != null && node.y != null) {
      node.fx = node.x
      node.fy = node.y
    }
  })
  const linkLayer = viewport.append('g').attr('class', 'graph-links')
  const nodeLayer = viewport.append('g').attr('class', 'graph-nodes')

  const linkSelection = linkLayer
    .selectAll<SVGLineElement, GraphEdge>('line')
    .data(links, (edge) => edge.id)
    .join('line')
    .attr('class', 'graph-link')
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
    .attr('refX', 21)
    .attr('refY', 0)
    .attr('markerWidth', 5)
    .attr('markerHeight', 5)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', '#2c6e9e')

  const expanded = expandedConceptSet()
  const isExpanded = (node: GraphNode): boolean => expanded.has(node.refId) || node.expanded === true
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
        .attr('r', nodeRadius)
        .attr('fill', (node) => palette[node.type])
      group
        .append('text')
        .attr('class', (node) => `graph-node-label graph-node-label-${node.type}`)
        .attr('dy', (node) => (node.type === 'concept' ? nodeRadius(node) + 15 : nodeRadius(node) + 17))
        .text((node) => node.label)
      group
        .append('title')
        .text((node) => `${node.label} · ${node.subtitle ?? node.type}`)
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
  nodeSelection.classed('is-selected', (node) => node.type === 'unit' && props.selectedUnitIds.includes(node.refId))

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
      highlightNode(node.id)
      // Reheat the springs while dragging so connected nodes follow the
      // pointer instead of feeling pinned in place. Keep the target finite;
      // an unlimited alpha target makes dense imported graphs oscillate.
      if (!event.active) simulation?.alphaTarget(0.18).restart()
      node.fx = node.x
      node.fy = node.y
    })
    .on('drag', (event, node) => {
      if (dragStartPoint && (Math.abs(event.x - dragStartPoint.x) > 4 || Math.abs(event.y - dragStartPoint.y) > 4)) dragMoved = true
      node.fx = event.x
      node.fy = event.y
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

  simulation?.stop()
  const linkForce = d3
    .forceLink<GraphNode & d3.SimulationNodeDatum, GraphEdge>(links)
    .id((node) => node.id)
    // Keep the semantic hierarchy visibly elastic while giving conversation
    // chains enough room to read as a sequence. These values are deliberately
    // stronger than the previous conservative profile; damping below keeps
    // the result from becoming a runaway spring system.
    .distance((edge) => {
      if (edge.type === 'hierarchy') return 148
      if (edge.type === 'conversation') return 72
      if (edge.type === 'association') return 96
      if (edge.type === 'related') return 112
      if (edge.type === 'co_occurrence') return 104
      return 112
    })
    .strength((edge) => {
      if (edge.type === 'hierarchy') return 0.92
      if (edge.type === 'conversation') return 0.62
      if (edge.type === 'association') return 0.52
      if (edge.type === 'related') return 0.5
      if (edge.type === 'manual') return 0.58
      return Math.min(0.78, 0.34 + edge.weight * 0.08)
    })
    .iterations(largeGraph ? 1 : 2)
  const chargeForce = d3
    .forceManyBody<GraphNode & d3.SimulationNodeDatum>()
    .strength((node) => (node as GraphNode).type === 'concept' ? -390 : -165)
    .distanceMax(Math.max(width, height) * (largeGraph ? 1.1 : 1.6))
  simulation = d3
    .forceSimulation(nodes)
    // Explicit springs + repulsion + collision keep related nodes connected
    // without letting dense sessions collapse into one pile.
    .force('link', linkForce)
    .force('charge', chargeForce)
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('x', d3.forceX<GraphNode & d3.SimulationNodeDatum>(width / 2).strength(largeGraph ? 0.014 : 0.02))
    .force('y', d3.forceY<GraphNode & d3.SimulationNodeDatum>(height / 2).strength(largeGraph ? 0.014 : 0.02))
    .force('collide', d3.forceCollide<GraphNode & d3.SimulationNodeDatum>().radius((node) => (node as GraphNode).type === 'concept' ? 50 : 28).strength(0.86).iterations(largeGraph ? 1 : 2))
    .velocityDecay(largeGraph ? 0.68 : 0.64)
  let paintPending = false
  const paint = (): void => {
      linkSelection
        .attr('x1', (edge) => (edge.source as unknown as GraphNode).x ?? 0)
        .attr('y1', (edge) => (edge.source as unknown as GraphNode).y ?? 0)
        .attr('x2', (edge) => (edge.target as unknown as GraphNode).x ?? 0)
        .attr('y2', (edge) => (edge.target as unknown as GraphNode).y ?? 0)
      nodeSelection.attr('transform', (node) => `translate(${node.x ?? width / 2},${node.y ?? height / 2})`)
  }
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
    requestAnimationFrame(() => {
      paintPending = false
      if (generation === renderGeneration) paint()
    })
  })
  if (props.reducedMotion) simulation.alphaDecay(0.5)
  else if (largeGraph) simulation.alphaDecay(0.045).alpha(0.3)
  else if (hasPreviousLayout) simulation.alphaDecay(0.04).alpha(0.24)
  else simulation.alphaDecay(0.05).alpha(0.62)

  // 首次挂载且用户未操作时，等力向布局稳定后只适配一次画布，避免每个 tick 触发 zoom 重排。
  if (shouldFitView) {
    let fitted = false
    const fitView = (freeze = false): void => {
      if (fitted || userMovedViewport || generation !== renderGeneration) return
      const xs = nodes.map((node) => node.x).filter((value) => value != null) as number[]
      const ys = nodes.map((node) => node.y).filter((value) => value != null) as number[]
      if (!xs.length) return
      const minX = Math.min(...xs) - 60
      const maxX = Math.max(...xs) + 60
      const minY = Math.min(...ys) - 60
      const maxY = Math.max(...ys) + 60
      // 大量消息节点的布局跨度可能超过画布，允许缩到 zoom 下限后再由用户放大查看。
      const scale = Math.min(1.4, Math.max(0.1, Math.min(width / Math.max(maxX - minX, 1), height / Math.max(maxY - minY, 1))))
      const transform = d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-(minX + maxX) / 2, -(minY + maxY) / 2)
      fitted = true
      hasFittedData = true
      if (freeze) simulation?.stop()
      fittingProgrammatically = true
      root.call(zoom.transform, transform)
      fittingProgrammatically = false
    }
    simulation.on('end.fit', fitView)
    // 极大图谱或后台节流时 end 事件可能很晚，给用户一个确定的最终视口。
    fitTimer = window.setTimeout(() => {
      fitTimer = null
      // 超大图谱的力向计算可能被后台节流；此时冻结当前布局并适配，
      // 避免节点在适配后继续漂移到画布外。
      fitView(true)
    }, largeGraph ? 2600 : 6000)
  }

  // 框选多选：Shift+左键拖出选框，松开后把框内知识单元加入上下文选择。
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
      if (resizeTimer != null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null
        render()
      }, 120)
    })
    resizeObserver.observe(host.value)
  }
})

// 视口以 liveTransform 为准；展开状态/层级窗口变化也需要更新控件，
// 但不会因为选中状态变化而重建力向布局。
watch(() => {
  const nodes = props.snapshot.nodes.map((node) => `${node.id}:${node.label}:${node.subtitle ?? ''}`).join('|')
  const edges = props.snapshot.edges.map((edge) => `${edge.id}:${edge.source}:${edge.target}:${edge.type}:${edge.status ?? ''}`).join('|')
  const expanded = (props.expandedConceptIds ?? []).slice().sort().join(',')
  const expandable = (props.expandableConceptIds ?? []).slice().sort().join(',')
  return `${props.snapshot.revision}|${nodes}|${edges}|${expanded}|${expandable}|${props.maxVisibleLevel ?? ''}|${props.expandedConceptDepth ?? ''}|${props.visibleNodeDepth ?? ''}|${typeof props.visibleNodeLevels === 'number' ? props.visibleNodeLevels : mapSignature(props.visibleNodeLevels)}|${mapSignature(props.conceptHierarchy)}|${mapSignature(props.conceptChildren)}|${props.fitOnTopologyChange ? 1 : 0}`
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
  simulation?.stop()
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="host" class="graph-canvas">
    <svg ref="svg" role="group" />
    <div v-if="brushSelectionCount" class="graph-selection-feedback" role="status">已选 {{ brushSelectionCount }} 个知识单元</div>
    <div class="graph-scale-hint">
      <span class="legend-dot concept-dot" /> 知识主题
      <span class="legend-dot unit-dot" /> 知识单元
      <span class="legend-dot message-dot" /> 消息
      <span class="graph-hint">滚轮缩放 · 拖拽平移/定位 · Shift+拖动框选知识单元 · 点击主题逐层展开</span>
    </div>
  </div>
</template>

<style>
</style>
