import type {
  Concept,
  ConceptRelation,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  GraphViewOptions,
  KnowledgeUnit,
  ManualGraphEdge,
  Message,
  MessageConcept,
  Session,
  SessionConcept,
  UnitConcept,
} from '@/types/domain'

/** Inputs used by the worker and the synchronous graph fallback. */
export interface GraphInput extends GraphViewOptions {
  concepts: Concept[]
  units: KnowledgeUnit[]
  messages: Message[]
  sessions?: Session[]
  unitConcepts: UnitConcept[]
  sessionConcepts?: SessionConcept[]
  messageConcepts?: MessageConcept[]
  relations: ConceptRelation[]
  manualEdges?: ManualGraphEdge[]
  revision: number
}

// Keep the service-level import path available for existing consumers.
export type { GraphViewOptions } from '@/types/domain'

export interface ConceptHierarchyIndex {
  parentsByChild: Map<string, Set<string>>
  childrenByParent: Map<string, Set<string>>
  roots: Set<string>
  depthByConcept: Map<string, number>
  rootIdsByConcept: Map<string, string[]>
}

function relationIsVisible(relation: ConceptRelation, showProposed: boolean): boolean {
  return relation.status === 'confirmed' || (showProposed && relation.status === 'proposed')
}

function hierarchyRelationIsVisible(relation: ConceptRelation, showProposed: boolean): boolean {
  return relation.relationType === 'hierarchy' && relationIsVisible(relation, showProposed)
}

/**
 * Message-level Concept memberships are kept in metadata when a Message has
 * not yet been assigned to a KnowledgeUnit.  Accept both the parsed object
 * used by the store and a JSON string so callers constructing GraphInput
 * directly get the same projection.
 */
function messageConceptIds(message: Message): string[] {
  const metadata = typeof message.metadata === 'string'
    ? (() => {
        try { return JSON.parse(message.metadata as unknown as string) as Record<string, unknown> } catch { return null }
      })()
    : message.metadata
  const ids = metadata && Array.isArray(metadata.concept_ids) ? metadata.concept_ids : []
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))]
}

/**
 * Build a hierarchy index from active concepts.  `related` edges are
 * deliberately excluded: they are undirected context links and must never
 * make a Concept look like a child (or hide it from the root projection).
 */
function indexHierarchy(concepts: Concept[], relations: ConceptRelation[], showProposed: boolean): ConceptHierarchyIndex {
  const activeIds = new Set(concepts.map((concept) => concept.id))
  const parentsByChild = new Map<string, Set<string>>()
  const childrenByParent = new Map<string, Set<string>>()

  relations.forEach((relation) => {
    if (!hierarchyRelationIsVisible(relation, showProposed)) return
    if (!activeIds.has(relation.parentConceptId) || !activeIds.has(relation.childConceptId)) return
    if (relation.parentConceptId === relation.childConceptId) return
    const parents = parentsByChild.get(relation.childConceptId) ?? new Set<string>()
    parents.add(relation.parentConceptId)
    parentsByChild.set(relation.childConceptId, parents)
    const children = childrenByParent.get(relation.parentConceptId) ?? new Set<string>()
    children.add(relation.childConceptId)
    childrenByParent.set(relation.parentConceptId, children)
  })

  // A valid hierarchy is a DAG.  Imported/legacy data can still contain a
  // cycle, so use the no-parent set when possible and fall back to all
  // concepts if a malformed cycle would otherwise produce an empty graph.
  const roots = new Set(concepts.filter((concept) => !parentsByChild.has(concept.id)).map((concept) => concept.id))
  if (!roots.size && concepts.length) concepts.forEach((concept) => roots.add(concept.id))

  const depthByConcept = new Map<string, number>()
  const rootIdsByConcept = new Map<string, Set<string>>()
  const queue: Array<{ id: string; depth: number; rootId: string }> = []
  roots.forEach((rootId) => queue.push({ id: rootId, depth: 0, rootId }))
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]
    const previousDepth = depthByConcept.get(current.id)
    if (previousDepth == null || current.depth < previousDepth) depthByConcept.set(current.id, current.depth)
    const rootIds = rootIdsByConcept.get(current.id) ?? new Set<string>()
    rootIds.add(current.rootId)
    rootIdsByConcept.set(current.id, rootIds)
    ;(childrenByParent.get(current.id) ?? new Set<string>()).forEach((childId) => {
      // Keep traversing alternate DAG paths, but stop a malformed cycle from
      // continuously enqueueing the same root/path pair.
      const childRoots = rootIdsByConcept.get(childId)
      if (childRoots?.has(current.rootId) && (depthByConcept.get(childId) ?? Infinity) <= current.depth + 1) return
      queue.push({ id: childId, depth: current.depth + 1, rootId: current.rootId })
    })
  }

  // Concepts in an isolated cycle were not reached from a root fallback path;
  // expose them as roots so a damaged import remains inspectable.
  concepts.forEach((concept) => {
    if (!depthByConcept.has(concept.id)) {
      roots.add(concept.id)
      depthByConcept.set(concept.id, 0)
      rootIdsByConcept.set(concept.id, new Set([concept.id]))
    }
  })

  return {
    parentsByChild,
    childrenByParent,
    roots,
    depthByConcept,
    rootIdsByConcept: new Map([...rootIdsByConcept].map(([id, ids]) => [id, [...ids]])),
  }
}

function finiteDepth(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return Math.max(0, Math.floor(value))
}

/**
 * Add all hierarchy ancestors required to make an explicitly expanded child
 * reachable.  The returned set is only a visibility aid; callers should keep
 * the original set around when deciding which units/messages to reveal.
 */
export function normalizeExpandedConceptIds(
  expandedConceptIds: Iterable<string> | undefined,
  hierarchy: Pick<ConceptHierarchyIndex, 'parentsByChild'>,
  activeIds: Set<string>,
): Set<string> {
  const expanded = new Set<string>()
  const explicit = [...(expandedConceptIds ?? [])].filter((id) => activeIds.has(id))
  explicit.forEach((id) => expanded.add(id))
  explicit.forEach((id) => {
    const queue = [id]
    const visited = new Set<string>()
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const current = queue[queueIndex]
      if (visited.has(current)) continue
      visited.add(current)
      ;(hierarchy.parentsByChild.get(current) ?? new Set<string>()).forEach((parentId) => {
        if (!activeIds.has(parentId)) return
        expanded.add(parentId)
        queue.push(parentId)
      })
    }
  })
  return expanded
}

/** Toggle one disclosure branch and forget every expanded descendant on collapse. */
export function toggleExpandedConceptIds(
  currentIds: Iterable<string>,
  conceptId: string,
  relations: ConceptRelation[],
  expanded?: boolean,
  showProposed = false,
): string[] {
  const current = new Set(currentIds)
  const shouldExpand = expanded ?? !current.has(conceptId)
  if (shouldExpand) {
    current.add(conceptId)
    return [...current]
  }

  const childrenByParent = new Map<string, Set<string>>()
  relations.forEach((relation) => {
    if (!hierarchyRelationIsVisible(relation, showProposed)) return
    const children = childrenByParent.get(relation.parentConceptId) ?? new Set<string>()
    children.add(relation.childConceptId)
    childrenByParent.set(relation.parentConceptId, children)
  })
  const queue = [conceptId]
  const visited = new Set<string>()
  for (let index = 0; index < queue.length; index += 1) {
    const currentId = queue[index]
    if (visited.has(currentId)) continue
    visited.add(currentId)
    current.delete(currentId)
    ;(childrenByParent.get(currentId) ?? new Set<string>()).forEach((childId) => queue.push(childId))
  }
  return [...current]
}

/**
 * Resolve the Concept nodes visible in a progressive projection.
 *
 * Roots are always visible.  A parent reveals its direct children when it is
 * expanded; `expandedConceptDepth` provides an optional global depth cap.  An
 * explicitly expanded descendant implicitly reveals its ancestor path, while
 * preserving the explicit set for local unit/message disclosure decisions.
 */
export function resolveVisibleConceptIds(
  concepts: Concept[],
  relations: ConceptRelation[],
  options: Pick<GraphViewOptions, 'expandedConceptIds' | 'expandedConceptDepth' | 'showProposed'> = {},
): { visibleIds: Set<string>; expandedIds: Set<string>; explicitExpandedIds: Set<string>; hierarchy: ConceptHierarchyIndex } {
  const activeConcepts = concepts.filter((concept) => concept.status === 'active')
  const activeIds = new Set(activeConcepts.map((concept) => concept.id))
  const hierarchy = indexHierarchy(activeConcepts, relations, Boolean(options.showProposed))
  const explicitExpandedIds = new Set([...(options.expandedConceptIds ?? [])].filter((id) => activeIds.has(id)))
  const expandedIds = normalizeExpandedConceptIds(explicitExpandedIds, hierarchy, activeIds)
  const depthLimit = finiteDepth(options.expandedConceptDepth)
  const visibleIds = new Set<string>(hierarchy.roots)
  const queue = [...hierarchy.roots]
  const visited = new Set<string>()
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const parentId = queue[queueIndex]
    if (visited.has(parentId)) continue
    visited.add(parentId)
    const parentDepth = hierarchy.depthByConcept.get(parentId) ?? 0
    const revealChildren = expandedIds.has(parentId) || (depthLimit != null && parentDepth < depthLimit)
    if (!revealChildren) continue
    ;(hierarchy.childrenByParent.get(parentId) ?? new Set<string>()).forEach((childId) => {
      if (!activeIds.has(childId)) return
      visibleIds.add(childId)
      queue.push(childId)
    })
  }
  // If a malformed cycle or a non-root expansion escaped the normal traversal,
  // include its ancestor path and the requested node rather than dropping it.
  expandedIds.forEach((id) => {
    if (!activeIds.has(id)) return
    visibleIds.add(id)
    let current = id
    const seen = new Set<string>()
    while (!seen.has(current)) {
      seen.add(current)
      const parentId = [...(hierarchy.parentsByChild.get(current) ?? [])][0]
      if (!parentId || !activeIds.has(parentId)) break
      visibleIds.add(parentId)
      current = parentId
    }
  })
  return { visibleIds, expandedIds, explicitExpandedIds, hierarchy }
}

/** Return the nearest currently visible ancestor(s) for a Concept. */
function visibleRepresentatives(
  conceptId: string,
  visibleIds: Set<string>,
  parentsByChild: Map<string, Set<string>>,
): string[] {
  if (visibleIds.has(conceptId)) return [conceptId]
  const queue: Array<{ id: string; distance: number }> = [{ id: conceptId, distance: 0 }]
  const visited = new Set<string>()
  let nearest = Infinity
  const representatives = new Set<string>()
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]
    if (visited.has(current.id) || current.distance > nearest) continue
    visited.add(current.id)
    ;(parentsByChild.get(current.id) ?? new Set<string>()).forEach((parentId) => {
      const distance = current.distance + 1
      if (visibleIds.has(parentId)) {
        if (distance < nearest) {
          nearest = distance
          representatives.clear()
        }
        if (distance === nearest) representatives.add(parentId)
      } else if (distance < nearest) {
        queue.push({ id: parentId, distance })
      }
    })
  }
  return [...representatives]
}

export function buildGraph(input: GraphInput): GraphSnapshot {
  const activeConcepts = input.concepts.filter((concept) => concept.status === 'active')
  const conceptById = new Map(activeConcepts.map((concept) => [concept.id, concept]))
  const unitById = new Map(input.units.map((unit) => [unit.id, unit]))
  const { visibleIds, expandedIds, hierarchy } = resolveVisibleConceptIds(activeConcepts, input.relations, input)
  const visibleConcepts = activeConcepts.filter((concept) => visibleIds.has(concept.id))
  const visibleRepresentativesCache = new Map<string, string[]>()
  const representativesFor = (conceptId: string): string[] => {
    const cached = visibleRepresentativesCache.get(conceptId)
    if (cached) return cached
    const representatives = visibleRepresentatives(conceptId, visibleIds, hierarchy.parentsByChild)
    visibleRepresentativesCache.set(conceptId, representatives)
    return representatives
  }

  const nodes: GraphNode[] = visibleConcepts.map((concept) => {
    const parentIds = [...(hierarchy.parentsByChild.get(concept.id) ?? [])].filter((id) => conceptById.has(id))
    return {
      id: `concept:${concept.id}`,
      type: 'concept',
      refId: concept.id,
      label: concept.name,
      subtitle: 'Concept',
      degree: 0,
      unitCount: 0,
      depth: hierarchy.depthByConcept.get(concept.id) ?? 0,
      parentIds,
      parentId: parentIds[0],
      rootIds: hierarchy.rootIdsByConcept.get(concept.id) ?? [concept.id],
      hasChildren: (hierarchy.childrenByParent.get(concept.id)?.size ?? 0) > 0,
      expanded: expandedIds.has(concept.id),
    }
  })
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const edges: GraphEdge[] = []
  const edgeMap = new Map<string, GraphEdge>()
  const ensureEdge = (source: string, target: string, type: GraphEdge['type'], weight = 1, status?: GraphEdge['status']) => {
    const ordered = type === 'hierarchy' ? `${source}|${target}` : [source, target].sort().join('|')
    const key = `${type}:${ordered}`
    const existing = edgeMap.get(key)
    if (existing) {
      existing.weight += weight
      // Preserve a confirmed status when a projected duplicate has mixed
      // statuses; this keeps the edge styling conservative.
      if (existing.status === 'proposed' && status === 'confirmed') existing.status = status
      return existing
    }
    const edge: GraphEdge = { id: `edge:${key}`, source, target, type, weight, status }
    edgeMap.set(key, edge)
    edges.push(edge)
    return edge
  }

  const conceptNode = (id: string) => `concept:${id}`
  const conceptsByUnit = new Map<string, Set<string>>()
  input.unitConcepts.forEach((link) => {
    if (!conceptById.has(link.conceptId) || !unitById.has(link.unitId)) return
    const set = conceptsByUnit.get(link.unitId) ?? new Set<string>()
    set.add(link.conceptId)
    conceptsByUnit.set(link.unitId, set)
  })

  // Keep direct Message memberships at Message level. Legacy metadata is read
  // alongside the v4 join table so existing databases keep their assignments.
  const conceptsByMessage = new Map<string, Set<string>>()
  const directConceptIdsByMessage = new Map<string, Set<string>>()
  ;(input.messageConcepts ?? []).forEach((link) => {
    if (!conceptById.has(link.conceptId)) return
    const ids = directConceptIdsByMessage.get(link.messageId) ?? new Set<string>()
    ids.add(link.conceptId)
    directConceptIdsByMessage.set(link.messageId, ids)
  })
  input.messages.forEach((message) => {
    const ids = [
      ...messageConceptIds(message),
      ...(directConceptIdsByMessage.get(message.id) ?? []),
    ].filter((id) => conceptById.has(id))
    if (!ids.length) return
    conceptsByMessage.set(message.id, new Set(ids))
    if (message.unitId && unitById.has(message.unitId)) {
      const set = conceptsByUnit.get(message.unitId) ?? new Set<string>()
      ids.forEach((id) => set.add(id))
      conceptsByUnit.set(message.unitId, set)
    }
  })

  // The graph currently has no decorative Session node. Project an exact
  // Session membership onto its units for layout and onto unassigned messages
  // when the session has not been segmented yet; persistence remains exact in
  // session_concepts and the maintenance UI exposes the Session itself.
  const unitsBySession = new Map<string, KnowledgeUnit[]>()
  input.units.forEach((unit) => {
    const sessionUnits = unitsBySession.get(unit.sessionId) ?? []
    sessionUnits.push(unit)
    unitsBySession.set(unit.sessionId, sessionUnits)
  })
  const messagesBySessionId = new Map<string, Message[]>()
  input.messages.forEach((message) => {
    const sessionMessages = messagesBySessionId.get(message.sessionId) ?? []
    sessionMessages.push(message)
    messagesBySessionId.set(message.sessionId, sessionMessages)
  })
  ;(input.sessionConcepts ?? []).forEach((link) => {
    if (!conceptById.has(link.conceptId)) return
    const sessionUnits = unitsBySession.get(link.sessionId) ?? []
    sessionUnits.forEach((unit) => {
      const set = conceptsByUnit.get(unit.id) ?? new Set<string>()
      set.add(link.conceptId)
      conceptsByUnit.set(unit.id, set)
    })
    if (sessionUnits.length) return
    ;(messagesBySessionId.get(link.sessionId) ?? []).forEach((message) => {
      const set = conceptsByMessage.get(message.id) ?? new Set<string>()
      set.add(link.conceptId)
      conceptsByMessage.set(message.id, set)
    })
  })

  // Co-occurrence is a Session-level fact: a pair contributes once when both
  // Concepts occur anywhere in the same conversation. This keeps long
  // sessions with many KnowledgeUnits from artificially inflating weights.
  const conceptsBySession = new Map<string, Set<string>>()
  const addSessionConcepts = (sessionId: string, conceptIds: Iterable<string>): void => {
    const set = conceptsBySession.get(sessionId) ?? new Set<string>()
    for (const conceptId of conceptIds) if (conceptById.has(conceptId)) set.add(conceptId)
    if (set.size) conceptsBySession.set(sessionId, set)
  }
  conceptsByUnit.forEach((conceptIds, unitId) => {
    const unit = unitById.get(unitId)
    if (unit) addSessionConcepts(unit.sessionId, conceptIds)
  })
  conceptsByMessage.forEach((conceptIds, messageId) => {
    const message = input.messages.find((item) => item.id === messageId)
    if (message) addSessionConcepts(message.sessionId, conceptIds)
  })
  ;(input.sessionConcepts ?? []).forEach((link) => addSessionConcepts(link.sessionId, [link.conceptId]))

  // Map each hidden descendant to its nearest visible ancestor.  This lets a
  // collapsed root retain an accurate aggregate unit count and co-occurrence
  // weight without exposing every leaf in the initial projection.
  const unitIdsByVisibleConcept = new Map<string, Set<string>>()
  conceptsByUnit.forEach((conceptIds, unitId) => {
    conceptIds.forEach((conceptId) => {
      representativesFor(conceptId).forEach((representativeId) => {
        const units = unitIdsByVisibleConcept.get(representativeId) ?? new Set<string>()
        units.add(unitId)
        unitIdsByVisibleConcept.set(representativeId, units)
      })
    })
  })
  nodes.forEach((node) => { node.unitCount = unitIdsByVisibleConcept.get(node.refId)?.size ?? 0 })

  const visibleUnitIds = new Set<string>()
  const ensureUnitNode = (unitId: string, conceptIds: Set<string>): void => {
    if (visibleUnitIds.has(unitId)) return
    const unit = unitById.get(unitId)
    if (!unit) return
    visibleUnitIds.add(unitId)
    const unitNodeId = `unit:${unit.id}`
    const unitNode: GraphNode = {
      id: unitNodeId,
      type: 'unit',
      refId: unit.id,
      label: unit.title || '待命名知识单元',
      subtitle: unit.summary || '尚未生成摘要',
      degree: 0,
      unitCount: 0,
    }
    nodes.push(unitNode)
    nodeById.set(unitNodeId, unitNode)
    const attached = new Set<string>()
    conceptIds.forEach((conceptId) => representativesFor(conceptId).forEach((representativeId) => attached.add(representativeId)))
    attached.forEach((conceptId) => ensureEdge(conceptNode(conceptId), unitNodeId, 'association'))
  }

  for (const [unitId, conceptIds] of conceptsByUnit) {
    if (input.showUnits) ensureUnitNode(unitId, conceptIds)
  }

  // Project each Session's Concept set to visible ancestors and add one edge
  // per pair. The edge weight therefore equals the number of Sessions in
  // which the pair co-occurs, independent of unit/message multiplicity.
  conceptsBySession.forEach((conceptIds) => {
    const projectedIds = new Set<string>()
    conceptIds.forEach((conceptId) => representativesFor(conceptId).forEach((representativeId) => projectedIds.add(representativeId)))
    const ids = [...projectedIds]
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        ensureEdge(conceptNode(ids[left]), conceptNode(ids[right]), 'co_occurrence')
      }
    }
  })

  if (input.showMessages || input.showRetainedSessions) {
    const sessionsById = new Map((input.sessions ?? []).map((session) => [session.id, session]))
    const visibleMessages = input.messages.filter((message) => {
      const session = sessionsById.get(message.sessionId)
      const retained = Boolean(
        input.showRetainedSessions
        && session
        && session.knowledgeKind !== 'knowledge'
        && (session.knowledgeKind === 'unknown' || session.knowledgeRetainInGraph),
      )
      return input.showMessages || retained
    })
    visibleMessages.forEach((message) => {
      const messageNodeId = `message:${message.id}`
      const messageNode: GraphNode = {
        id: messageNodeId,
        type: 'message',
        refId: message.id,
        label: message.content.slice(0, 34) || '空消息',
        subtitle: message.role,
        degree: 0,
        unitCount: 0,
      }
      nodes.push(messageNode)
      nodeById.set(messageNodeId, messageNode)
      if (message.unitId && visibleUnitIds.has(message.unitId)) ensureEdge(`unit:${message.unitId}`, messageNodeId, 'association')
      ;(conceptsByMessage.get(message.id) ?? new Set<string>()).forEach((conceptId) => {
        representativesFor(conceptId).forEach((representativeId) => ensureEdge(conceptNode(representativeId), messageNodeId, 'association'))
      })
    })
    const messagesBySession = new Map<string, GraphNode[]>()
    visibleMessages.forEach((message) => {
      const list = messagesBySession.get(message.sessionId) ?? []
      const node = nodeById.get(`message:${message.id}`)
      if (node) list.push(node)
      messagesBySession.set(message.sessionId, list)
    })
    const messageOrder = new Map(visibleMessages.map((message) => [message.id, message.orderInSession]))
    messagesBySession.forEach((sessionNodes) => {
      sessionNodes.sort((left, right) => (messageOrder.get(left.refId) ?? 0) - (messageOrder.get(right.refId) ?? 0))
      for (let index = 1; index < sessionNodes.length; index += 1) ensureEdge(sessionNodes[index - 1].id, sessionNodes[index].id, 'conversation')
    })
  }

  // Hierarchy edges are only emitted when both endpoints are currently
  // visible.  In particular, a collapsed child is represented by its visible
  // ancestor rather than by a misleading parent→hidden-leaf edge.
  input.relations
    .filter((relation) => hierarchyRelationIsVisible(relation, Boolean(input.showProposed)))
    .forEach((relation) => {
      if (!visibleIds.has(relation.parentConceptId) || !visibleIds.has(relation.childConceptId)) return
      ensureEdge(conceptNode(relation.parentConceptId), conceptNode(relation.childConceptId), 'hierarchy', 1, relation.status)
    })

  // Related edges remain undirected and never participate in hierarchy root
  // detection.  If a related endpoint is collapsed, project it to its nearest
  // visible ancestor so the root overview still retains that weak signal.
  input.relations
    .filter((relation) => relation.relationType === 'related' && relationIsVisible(relation, Boolean(input.showProposed)))
    .forEach((relation) => {
      const leftRepresentatives = representativesFor(relation.parentConceptId)
      const rightRepresentatives = representativesFor(relation.childConceptId)
      leftRepresentatives.forEach((leftId) => rightRepresentatives.forEach((rightId) => {
        if (leftId === rightId) return
        ensureEdge(conceptNode(leftId), conceptNode(rightId), 'related', 1, relation.status)
      }))
    })

  input.manualEdges?.forEach((edge) => {
    const source = `${edge.sourceType}:${edge.sourceRefId}`
    const target = `${edge.targetType}:${edge.targetRefId}`
    if (!nodeById.has(source) || !nodeById.has(target)) return
    ensureEdge(source, target, 'manual', 1)
  })

  const degreeByNode = new Map<string, number>()
  edges.forEach((edge) => {
    degreeByNode.set(edge.source, (degreeByNode.get(edge.source) ?? 0) + 1)
    degreeByNode.set(edge.target, (degreeByNode.get(edge.target) ?? 0) + 1)
  })
  nodes.forEach((node) => { node.degree = degreeByNode.get(node.id) ?? 0 })
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
