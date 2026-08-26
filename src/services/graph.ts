import type {
  Concept,
  ConceptRelation,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  KnowledgeUnit,
  ManualGraphEdge,
  Message,
  Session,
  UnitConcept,
} from '@/types/domain'

export interface GraphInput {
  concepts: Concept[]
  units: KnowledgeUnit[]
  messages: Message[]
  sessions?: Session[]
  unitConcepts: UnitConcept[]
  relations: ConceptRelation[]
  manualEdges?: ManualGraphEdge[]
  revision: number
  showUnits?: boolean
  showMessages?: boolean
  showProposed?: boolean
  showRetainedSessions?: boolean
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
  const visibleUnitIds = new Set<string>()
  const ensureUnitNode = (unitId: string, conceptIds: Set<string>): void => {
    if (visibleUnitIds.has(unitId)) return
    const unit = unitById.get(unitId)
    if (!unit) return
    visibleUnitIds.add(unitId)
    const unitNodeId = `unit:${unit.id}`
    nodes.push({
      id: unitNodeId,
      type: 'unit',
      refId: unit.id,
      label: unit.title || '待命名知识单元',
      subtitle: unit.summary || '尚未生成摘要',
      degree: conceptIds.size,
      unitCount: 0,
    })
    conceptIds.forEach((conceptId) => ensureEdge(conceptNode(conceptId), unitNodeId, 'association'))
  }

  for (const [unitId, conceptIds] of conceptsByUnit) {
    const ids = [...conceptIds]
    ids.forEach((conceptId) => {
      const concept = conceptById.get(conceptId)
      if (concept) {
        const node = nodes.find((item) => item.id === conceptNode(concept.id))
        if (node) node.unitCount += 1
      }
    })
    // A single unit can mention many topics without asserting that every pair
    // is related. Only repeated co-occurrence is useful as a quiet background
    // signal; direct semantic relations are stored separately below.
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        ensureEdge(conceptNode(ids[left]), conceptNode(ids[right]), 'co_occurrence')
      }
    }
    if (input.showUnits || ids.some((conceptId) => expandedConceptIds.has(conceptId))) {
      ensureUnitNode(unitId, conceptIds)
    }
  }

  if (input.showMessages || input.showRetainedSessions || expandedConceptIds.size) {
    const sessionsById = new Map((input.sessions ?? []).map((session) => [session.id, session]))
    const expandedUnitIds = new Set<string>()
    conceptsByUnit.forEach((conceptIds, unitId) => {
      if ([...conceptIds].some((conceptId) => expandedConceptIds.has(conceptId))) expandedUnitIds.add(unitId)
    })
    const visibleMessages = input.messages.filter((message) => {
      const session = sessionsById.get(message.sessionId)
      // Imported sessions remain `unknown` until triage completes. Treat them
      // as unarchived here so users can inspect the original conversation
      // chain before choosing an LLM mode or applying a classification.
      const retained = Boolean(
        input.showRetainedSessions
        && session
        && session.knowledgeKind !== 'knowledge'
        && (session.knowledgeKind === 'unknown' || session.knowledgeRetainInGraph),
      )
      return input.showMessages || retained || (message.unitId != null && expandedUnitIds.has(message.unitId))
    })
    visibleMessages.forEach((message) => {
        const messageNodeId = `message:${message.id}`
        nodes.push({
          id: messageNodeId,
          type: 'message',
          refId: message.id,
          label: message.content.slice(0, 34) || '空消息',
          subtitle: message.role,
          degree: 0,
          unitCount: 0,
        })
        if (message.unitId && visibleUnitIds.has(message.unitId)) ensureEdge(`unit:${message.unitId}`, messageNodeId, 'association')
    })
    const messagesBySession = new Map<string, GraphNode[]>()
    visibleMessages.forEach((message) => {
      const list = messagesBySession.get(message.sessionId) ?? []
      list.push(nodes.find((node) => node.id === `message:${message.id}`) as GraphNode)
      messagesBySession.set(message.sessionId, list)
    })
    messagesBySession.forEach((sessionNodes) => {
      sessionNodes.sort((left, right) => {
        const l = visibleMessages.find((message) => message.id === left.refId)?.orderInSession ?? 0
        const r = visibleMessages.find((message) => message.id === right.refId)?.orderInSession ?? 0
        return l - r
      })
      for (let index = 1; index < sessionNodes.length; index += 1) ensureEdge(sessionNodes[index - 1].id, sessionNodes[index].id, 'conversation')
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

  // Co-occurrence is only a weak background hint. A pair mentioned once is
  // not a semantic relationship, and displaying every pair makes dense units
  // unreadable. Keep repeated pairs, capped to the strongest few neighbors per
  // concept; explicit hierarchy/related/manual edges are unaffected.
  const coOccurrence = edges.filter((edge) => edge.type === 'co_occurrence' && edge.weight >= 2)
  const retainedCoOccurrence = new Set<string>()
  conceptById.forEach((_concept, conceptId) => {
    coOccurrence
      .filter((edge) => edge.source === conceptNode(conceptId) || edge.target === conceptNode(conceptId))
      .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
      .slice(0, 4)
      .forEach((edge) => retainedCoOccurrence.add(edge.id))
  })
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const edge = edges[index]
    if (edge.type === 'co_occurrence' && !retainedCoOccurrence.has(edge.id)) edges.splice(index, 1)
  }

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
