<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as d3 from 'd3'
import type { GraphEdge, GraphNode, GraphSnapshot, GraphViewport } from '@/types/domain'

const props = withDefaults(
  defineProps<{
    snapshot: GraphSnapshot
    selectedUnitIds?: string[]
    reducedMotion?: boolean
    viewport?: GraphViewport
  }>(),
  { selectedUnitIds: () => [], reducedMotion: false, viewport: () => ({ x: 0, y: 0, scale: 1, layoutVersion: 1 }) },
)

const emit = defineEmits<{
  (event: 'select-concept', id: string): void
  (event: 'select-unit', id: string, additive: boolean): void
  (event: 'select-message', id: string): void
  (event: 'layout-change', entry: { nodeType: GraphNode['type']; refId: string; x: number; y: number; fixed: boolean }): void
  (event: 'viewport-change', viewport: { x: number; y: number; scale: number }): void
}>()

const host = ref<HTMLElement | null>(null)
const svg = ref<SVGSVGElement | null>(null)
let simulation: d3.Simulation<GraphNode & d3.SimulationNodeDatum, undefined> | null = null
let resizeObserver: ResizeObserver | null = null

const palette: Record<string, string> = {
  concept: '#2c6e9e',
  unit: '#7b8794',
  message: '#b9c3cc',
}

function edgeColor(edge: GraphEdge): string {
  if (edge.type === 'hierarchy') return '#2c6e9e'
  if (edge.type === 'related') return '#6c8e9e'
  if (edge.type === 'association') return '#b4c1cb'
  return '#93a4b2'
}

function render(): void {
  if (!svg.value || !host.value) return
  const element = svg.value
  const width = Math.max(host.value.clientWidth, 480)
  const height = Math.max(host.value.clientHeight, 460)
  const root = d3.select(element)
  root.selectAll('*').remove()
  root.attr('viewBox', `0 0 ${width} ${height}`).attr('aria-label', '知识主题图谱')

  const viewport = root.append('g').attr('class', 'graph-viewport')
  let restoringViewport = true
  const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.35, 3.2]).on('zoom', (event) => {
    viewport.attr('transform', event.transform)
    if (!restoringViewport) emit('viewport-change', { x: event.transform.x, y: event.transform.y, scale: event.transform.k })
  })
  root.call(zoom)
  const initialViewport = props.viewport ?? { x: 0, y: 0, scale: 1 }
  root.call(zoom.transform, d3.zoomIdentity.translate(initialViewport.x, initialViewport.y).scale(initialViewport.scale))
  restoringViewport = false

  const nodes = props.snapshot.nodes.map((node) => ({ ...node })) as (GraphNode & d3.SimulationNodeDatum)[]
  nodes.forEach((node) => {
    if (node.fixed && node.x != null && node.y != null) {
      node.fx = node.x
      node.fy = node.y
    }
  })
  const links = props.snapshot.edges.map((edge) => ({ ...edge }))
  const linkLayer = viewport.append('g').attr('class', 'graph-links')
  const nodeLayer = viewport.append('g').attr('class', 'graph-nodes')

  const linkSelection = linkLayer
    .selectAll<SVGLineElement, GraphEdge>('line')
    .data(links, (edge) => edge.id)
    .join('line')
    .attr('class', 'graph-link')
    .attr('stroke', edgeColor)
    .attr('stroke-width', (edge) => Math.min(6, 1 + Math.log2(edge.weight + 1)))
    .attr('stroke-dasharray', (edge) => (edge.status === 'proposed' || edge.type === 'related' ? '5 5' : null))
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

  const nodeSelection = nodeLayer
    .selectAll<SVGGElement, GraphNode & d3.SimulationNodeDatum>('g')
    .data(nodes, (node) => node.id)
    .join((enter) => {
      const group = enter.append('g').attr('class', 'graph-node').attr('tabindex', 0)
      group
        .append('circle')
        .attr('class', 'graph-node-shape')
        .attr('r', (node) => (node.type === 'concept' ? Math.min(31, 16 + Math.sqrt(node.unitCount) * 4) : node.type === 'unit' ? 11 : 7))
        .attr('fill', (node) => palette[node.type])
      group
        .append('text')
        .attr('class', 'graph-node-label')
        .attr('dy', (node) => (node.type === 'concept' ? 45 : 28))
        .text((node) => node.label)
      group
        .append('title')
        .text((node) => `${node.label} · ${node.subtitle ?? node.type}`)
      return group
    })

  nodeSelection.classed('is-selected', (node) => props.selectedUnitIds.includes(node.refId))
  nodeSelection
    .on('click', (event, node) => {
      event.stopPropagation()
      if (node.type === 'concept') emit('select-concept', node.refId)
      if (node.type === 'unit') emit('select-unit', node.refId, event.ctrlKey || event.metaKey)
      if (node.type === 'message') emit('select-message', node.refId)
    })
    .on('keydown', (event, node) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      if (node.type === 'concept') emit('select-concept', node.refId)
      if (node.type === 'unit') emit('select-unit', node.refId, event.ctrlKey || event.metaKey)
    })

  const drag = d3
    .drag<SVGGElement, GraphNode & d3.SimulationNodeDatum>()
    .on('start', (event, node) => {
      if (!event.active) simulation?.alphaTarget(0.25).restart()
      node.fx = node.x
      node.fy = node.y
    })
    .on('drag', (event, node) => {
      node.fx = event.x
      node.fy = event.y
    })
    .on('end', (event, node) => {
      if (!event.active) simulation?.alphaTarget(0)
      node.fx = event.x
      node.fy = event.y
      emit('layout-change', { nodeType: node.type, refId: node.refId, x: event.x, y: event.y, fixed: true })
    })
  nodeSelection.call(drag)

  simulation?.stop()
  simulation = d3
    .forceSimulation(nodes)
    .force('link', d3.forceLink<GraphNode & d3.SimulationNodeDatum, GraphEdge>(links).id((node) => node.id).distance((edge) => edge.type === 'hierarchy' ? 130 : edge.type === 'association' ? 82 : 105).strength((edge) => edge.type === 'hierarchy' ? 0.75 : Math.min(0.65, 0.25 + edge.weight * 0.06)))
    .force('charge', d3.forceManyBody<GraphNode & d3.SimulationNodeDatum>().strength((node) => (node as GraphNode).type === 'concept' ? -330 : -125))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide<GraphNode & d3.SimulationNodeDatum>().radius((node) => (node as GraphNode).type === 'concept' ? 50 : 28))
    .on('tick', () => {
      linkSelection
        .attr('x1', (edge) => (edge.source as unknown as GraphNode).x ?? 0)
        .attr('y1', (edge) => (edge.source as unknown as GraphNode).y ?? 0)
        .attr('x2', (edge) => (edge.target as unknown as GraphNode).x ?? 0)
        .attr('y2', (edge) => (edge.target as unknown as GraphNode).y ?? 0)
      nodeSelection.attr('transform', (node) => `translate(${node.x ?? width / 2},${node.y ?? height / 2})`)
    })
  if (props.reducedMotion) simulation.alphaDecay(0.4)
}

onMounted(() => {
  render()
  if (host.value) {
    resizeObserver = new ResizeObserver(() => render())
    resizeObserver.observe(host.value)
  }
})

watch(() => [props.snapshot, props.selectedUnitIds, props.viewport], render, { deep: true })

onBeforeUnmount(() => {
  simulation?.stop()
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="host" class="graph-canvas">
    <svg ref="svg" role="img" />
    <div class="graph-scale-hint">
      <span class="legend-dot concept-dot" /> 知识主题
      <span class="legend-dot unit-dot" /> 知识单元
      <span class="legend-dot message-dot" /> 消息
      <span class="graph-hint">滚轮缩放 · 拖拽平移/定位 · 点击知识主题展开单元</span>
    </div>
  </div>
</template>
