import type {
  Concept,
  ConceptRelation,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  KnowledgeUnit,
  ManualGraphEdge,
  Message,
  UnitConcept,
} from '@/types/domain'

interface GraphInput {
  concepts: Concept[]
  units: KnowledgeUnit[]
  messages: Message[]
  unitConcepts: UnitConcept[]
  relations: ConceptRelation[]
  manualEdges?: ManualGraphEdge[]
  revision: number
  showUnits?: boolean
  showMessages?: boolean
  showProposed?: boolean
  expandedConceptIds?: string[]
}

export function buildGraph(input: GraphInput): GraphSnapshot {
  const activeConcepts = input.concepts.filter((concept) => concept.status === 'active')
  const conceptById = new Map(activeConcepts.map((concept) => [concept.id, concept]))
  const unitById = new Map(input.units.map((unit) => [unit.id, unit]))
  const expandedConceptIds = new Set(input.expandedConceptIds ?? [])
  const conceptsByUnit = new Map<string, Set<string>>()
  input.unitConcepts.forEach((link) => {
    if (!conceptById.has(link.conceptId) || !unitById.has(link.unitId)) return
    const set = conceptsByUnit.get(link.unitId) ?? new Set<string>()
    set.add(link.conceptId)
    conceptsByUnit.set(link.unitId, set)
  })

  const nodes: GraphNode[] = activeConcepts.map((concept) => ({
    id: `concept:${concept.id}`,
    type: 'concept',
    refId: concept.id,
    label: concept.name,
    subtitle: 'Concept',
    degree: 0,
    unitCount: 0,
  }))
  const edges: GraphEdge[] = []
  const edgeMap = new Map<string, GraphEdge>()
  const ensureEdge = (source: string, target: string, type: GraphEdge['type'], weight = 1, status?: GraphEdge['status']) => {
    const ordered = type === 'hierarchy' ? `${source}|${target}` : [source, target].sort().join('|')
    const key = `${type}:${ordered}`
    const existing = edgeMap.get(key)
    if (existing) {
      existing.weight += weight
      return existing
    }
    const edge: GraphEdge = { id: `edge:${key}`, source, target, type, weight, status }
    edgeMap.set(key, edge)
    edges.push(edge)
    return edge
  }

  const conceptNode = (id: string) => `concept:${id}`
  for (const [unitId, conceptIds] of conceptsByUnit) {
    const ids = [...conceptIds]
    ids.forEach((conceptId) => {
      const concept = conceptById.get(conceptId)
      if (concept) {
        const node = nodes.find((item) => item.id === conceptNode(concept.id))
        if (node) node.unitCount += 1
      }
    })
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        ensureEdge(conceptNode(ids[left]), conceptNode(ids[right]), 'co_occurrence')
      }
    }
    if (input.showUnits || ids.some((conceptId) => expandedConceptIds.has(conceptId))) {
      const unit = unitById.get(unitId)
      if (!unit) continue
      const unitNodeId = `unit:${unit.id}`
      nodes.push({
        id: unitNodeId,
        type: 'unit',
        refId: unit.id,
        label: unit.title || '待命名知识单元',
        subtitle: unit.summary || '尚未生成摘要',
        degree: ids.length,
        unitCount: 0,
      })
      ids.forEach((conceptId) => ensureEdge(conceptNode(conceptId), unitNodeId, 'association'))
    }
  }

  if (input.showMessages) {
    input.messages
      .filter((message) => !message.unitId || input.showUnits)
      .forEach((message) => {
        const messageNodeId = `message:${message.id}`
        nodes.push({
          id: messageNodeId,
          type: 'message',
          refId: message.id,
          label: message.content.slice(0, 34) || '空消息',
          subtitle: message.role,
          degree: message.unitId ? 1 : 0,
          unitCount: 0,
        })
        if (message.unitId && input.showUnits) ensureEdge(`unit:${message.unitId}`, messageNodeId, 'association')
      })
  }

  input.relations
    .filter((relation) => relation.status === 'confirmed' || input.showProposed)
    .forEach((relation) => {
      if (!conceptById.has(relation.parentConceptId) || !conceptById.has(relation.childConceptId)) return
      ensureEdge(
        conceptNode(relation.parentConceptId),
        conceptNode(relation.childConceptId),
        relation.relationType,
        1,
        relation.status,
      )
    })

  input.manualEdges?.forEach((edge) => {
    const source = `${edge.sourceType}:${edge.sourceRefId}`
    const target = `${edge.targetType}:${edge.targetRefId}`
    if (!nodes.some((node) => node.id === source) || !nodes.some((node) => node.id === target)) return
    ensureEdge(source, target, 'manual', 1)
  })

  nodes.forEach((node) => {
    node.degree = edges.filter((edge) => edge.source === node.id || edge.target === node.id).length
  })
  return { nodes, edges, revision: input.revision }
}

export function graphStats(snapshot: GraphSnapshot): { concepts: number; units: number; messages: number; edges: number } {
  return {
    concepts: snapshot.nodes.filter((node) => node.type === 'concept').length,
    units: snapshot.nodes.filter((node) => node.type === 'unit').length,
    messages: snapshot.nodes.filter((node) => node.type === 'message').length,
    edges: snapshot.edges.length,
  }
}
