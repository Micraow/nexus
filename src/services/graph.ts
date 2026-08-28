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

function hierarchyRelationIsActive(relation: ConceptRelation): boolean {
  return relation.relationType === 'hierarchy' && relation.status !== 'rejected'
}

function hierarchyRelationIsVisible(relation: ConceptRelation, showProposed: boolean): boolean {
  return hierarchyRelationIsActive(relation) && relationIsVisible(relation, showProposed)
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

export interface DerivedRelatedPair {
  leftConceptId: string
  rightConceptId: string
  /** Number of distinct Sessions containing both Concepts. */
  sessionCount: number
  /** Number of Messages explicitly containing both Concepts. */
  messageCount: number
}

/**
 * Derive weak Concept relationships from persisted evidence instead of model
 * assertions. A pair is related when it occurs in one Session, and the
 * optional messageCount keeps the detail view explainable without changing
 * the graph's Session-level weight semantics.
 */
export function deriveConceptRelatedPairs(input: Pick<GraphInput, 'concepts' | 'units' | 'messages' | 'unitConcepts' | 'sessionConcepts' | 'messageConcepts' | 'sessions'>): DerivedRelatedPair[] {
  const activeIds = new Set(input.concepts.filter((concept) => concept.status === 'active').map((concept) => concept.id))
  const activeSessionIds = input.sessions ? new Set(input.sessions.map((session) => session.id)) : null
  const unitById = new Map(input.units.map((unit) => [unit.id, unit]))
  const messagesBySession = new Map<string, Message[]>()
  input.messages.forEach((message) => {
    if (activeSessionIds && !activeSessionIds.has(message.sessionId)) return
    const list = messagesBySession.get(message.sessionId) ?? []
    list.push(message)
    messagesBySession.set(message.sessionId, list)
  })
  const conceptsByMessage = new Map<string, Set<string>>()
  const conceptsBySession = new Map<string, Set<string>>()
  const addToSet = (map: Map<string, Set<string>>, key: string, ids: Iterable<string>): void => {
    const set = map.get(key) ?? new Set<string>()
    for (const id of ids) if (activeIds.has(id)) set.add(id)
    if (set.size) map.set(key, set)
  }
  const addMessageConcept = (messageId: string, conceptId: string): void => {
    const message = input.messages.find((item) => item.id === messageId)
    if (!message || (activeSessionIds && !activeSessionIds.has(message.sessionId))) return
    addToSet(conceptsByMessage, messageId, [conceptId])
    addToSet(conceptsBySession, message.sessionId, [conceptId])
  }

  ;(input.messageConcepts ?? []).forEach((link) => addMessageConcept(link.messageId, link.conceptId))
  input.messages.forEach((message) => messageConceptIds(message).forEach((conceptId) => addMessageConcept(message.id, conceptId)))
  const conceptsByUnit = new Map<string, Set<string>>()
  input.unitConcepts.forEach((link) => {
    if (!activeIds.has(link.conceptId) || !unitById.has(link.unitId)) return
    addToSet(conceptsByUnit, link.unitId, [link.conceptId])
    const unit = unitById.get(link.unitId) as KnowledgeUnit
    addToSet(conceptsBySession, unit.sessionId, [link.conceptId])
  })
  input.messages.forEach((message) => {
    if (!message.unitId) return
    const unitConcepts = conceptsByUnit.get(message.unitId)
    if (!unitConcepts) return
    unitConcepts.forEach((conceptId) => addMessageConcept(message.id, conceptId))
  })
  ;(input.sessionConcepts ?? []).forEach((link) => {
    if (activeSessionIds && !activeSessionIds.has(link.sessionId)) return
    if (!activeIds.has(link.conceptId)) return
    addToSet(conceptsBySession, link.sessionId, [link.conceptId])
    ;(messagesBySession.get(link.sessionId) ?? []).forEach((message) => addMessageConcept(message.id, link.conceptId))
  })

  const pairCounts = new Map<string, DerivedRelatedPair>()
  const countPairs = (ids: Set<string>, field: 'sessionCount' | 'messageCount'): void => {
    const ordered = [...ids].sort()
    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = left + 1; right < ordered.length; right += 1) {
        const key = `${ordered[left]}|${ordered[right]}`
        const current = pairCounts.get(key) ?? { leftConceptId: ordered[left], rightConceptId: ordered[right], sessionCount: 0, messageCount: 0 }
        current[field] += 1
        pairCounts.set(key, current)
      }
    }
  }
  conceptsBySession.forEach((ids) => countPairs(ids, 'sessionCount'))
  conceptsByMessage.forEach((ids) => countPairs(ids, 'messageCount'))
  return [...pairCounts.values()].sort((left, right) => `${left.leftConceptId}|${left.rightConceptId}`.localeCompare(`${right.leftConceptId}|${right.rightConceptId}`))
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
    // A non-rejected hierarchy relation still defines structural ancestry even
    // while its proposed edge is hidden. This prevents a child with a pending
    // parent suggestion from being promoted to a root in the default view.
    if (!hierarchyRelationIsActive(relation)) return
    if (!activeIds.has(relation.parentConceptId) || !activeIds.has(relation.childConceptId)) return
    if (relation.parentConceptId === relation.childConceptId) return
    const parents = parentsByChild.get(relation.childConceptId) ?? new Set<string>()
    parents.add(relation.parentConceptId)
    parentsByChild.set(relation.childConceptId, parents)
    if (!hierarchyRelationIsVisible(relation, showProposed)) return
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
    if (!depthByConcept.has(concept.id) && !parentsByChild.has(concept.id)) {
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
 * A pending Worker query may temporarily reuse a cached graph only when the
 * cached topology cannot disclose more than the requested view. In
 * particular, an expanded snapshot must never flash back after its ancestor
 * was collapsed, and snapshots from different display/proposal filters must
 * never cross-contaminate each other.
 */
export function graphViewFallbackIsCompatible(
  candidate: GraphViewOptions,
  requested: GraphViewOptions,
): boolean {
  if (Boolean(candidate.showUnits) !== Boolean(requested.showUnits)) return false
  if (Boolean(candidate.showMessages) !== Boolean(requested.showMessages)) return false
  if (Boolean(candidate.showProposed) !== Boolean(requested.showProposed)) return false
  if (Boolean(candidate.showRetainedSessions) !== Boolean(requested.showRetainedSessions)) return false
  if (finiteDepth(candidate.expandedConceptDepth) !== finiteDepth(requested.expandedConceptDepth)) return false

  const requestedExpanded = new Set(requested.expandedConceptIds ?? [])
  return (candidate.expandedConceptIds ?? []).every((id) => requestedExpanded.has(id))
}

/**
 * Guard a cached/worker snapshot against accidental over-disclosure.  The
 * option comparison above only knows which ids were requested; this check
 * verifies that every Concept node in the candidate is reachable through an
 * explicitly expanded parent.  It is deliberately conservative for legacy
 * snapshots without `depth`: those snapshots are never safe as a progressive
 * fallback and the caller should keep the current view or show an empty load
 * state until the worker returns.
 */
export function graphSnapshotIsProgressiveCompatible(snapshot: GraphSnapshot, options: GraphViewOptions): boolean {
  const conceptNodes = snapshot.nodes.filter((node) => node.type === 'concept')
  if (!conceptNodes.length) return true
  if (conceptNodes.some((node) => node.depth == null || !Number.isFinite(node.depth))) return false

  const byId = new Map(conceptNodes.map((node) => [node.refId, node]))
  const parentsByConcept = new Map<string, Set<string>>()
  conceptNodes.forEach((node) => {
    const parentIds = (node.parentIds ?? (node.parentId ? [node.parentId] : []))
      .map((id) => id.startsWith('concept:') ? id.slice('concept:'.length) : id)
      .filter((id) => byId.has(id) && id !== node.refId)
    if (parentIds.length) parentsByConcept.set(node.refId, new Set(parentIds))
  })
  snapshot.edges.forEach((edge) => {
    if (edge.type !== 'hierarchy') return
    const source = edge.source.startsWith('concept:') ? edge.source.slice('concept:'.length) : edge.source
    const target = edge.target.startsWith('concept:') ? edge.target.slice('concept:'.length) : edge.target
    if (!byId.has(source) || !byId.has(target) || source === target) return
    const parents = parentsByConcept.get(target) ?? new Set<string>()
    parents.add(source)
    parentsByConcept.set(target, parents)
  })
  const visible = new Set(conceptNodes
    .filter((node) => !(parentsByConcept.get(node.refId)?.size))
    .map((node) => node.refId))
  const expanded = new Set(options.expandedConceptIds ?? [])
  // An explicitly expanded descendant implicitly opens the ancestor path in
  // the real resolver, so mirror that normalization before checking a
  // candidate snapshot.
  const parentIdsByConcept = new Map([...parentsByConcept].map(([id, parentIds]) => [id, [...parentIds]]))
  ;[...(options.expandedConceptIds ?? [])].forEach((id) => {
    const pending = [id]
    const seen = new Set<string>()
    for (let index = 0; index < pending.length; index += 1) {
      const current = pending[index]
      if (seen.has(current)) continue
      seen.add(current)
      ;(parentIdsByConcept.get(current) ?? new Set<string>()).forEach((parentId) => {
        expanded.add(parentId)
        pending.push(parentId)
      })
    }
  })
  const queue = [...visible]
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index]
    if (!expanded.has(parentId)) continue
    const parent = byId.get(parentId)
    if (!parent) continue
    conceptNodes.forEach((child) => {
      // Parent references are authoritative. Cached depth metadata can be
      // stale after imports or hierarchy edits, so do not reject a directly
      // referenced child solely because its numeric depth is wrong.
      if (!parentIdsByConcept.get(child.refId)?.includes(parentId) || visible.has(child.refId)) return
      visible.add(child.refId)
      queue.push(child.refId)
    })
  }
  return conceptNodes.every((node) => visible.has(node.refId))
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
    // Clear descendants even when proposed edges are currently hidden. If the
    // proposal view is enabled later, a branch the user collapsed must not
    // reappear because stale expansion ids survived the toggle.
    if (!hierarchyRelationIsActive(relation)) return
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
  return { visibleIds, expandedIds, explicitExpandedIds, hierarchy }
}

/** Return the first currently visible ancestor on every hierarchy branch. */
function visibleRepresentatives(
  conceptId: string,
  visibleIds: Set<string>,
  parentsByChild: Map<string, Set<string>>,
): string[] {
  if (visibleIds.has(conceptId)) return [conceptId]
  const queue = [conceptId]
  const visited = new Set<string>()
  const representatives = new Set<string>()
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]
    if (visited.has(current)) continue
    visited.add(current)
    ;(parentsByChild.get(current) ?? new Set<string>()).forEach((parentId) => {
      if (visibleIds.has(parentId)) {
        representatives.add(parentId)
      } else if (!visited.has(parentId)) {
        queue.push(parentId)
      }
    })
  }
  return [...representatives]
}

export function buildGraph(input: GraphInput): GraphSnapshot {
  const activeConcepts = input.concepts.filter((concept) => concept.status === 'active')
  const conceptById = new Map(activeConcepts.map((concept) => [concept.id, concept]))
  const unitById = new Map(input.units.map((unit) => [unit.id, unit]))
  // Store callers pass only non-archived Sessions. Keep direct Session
  // memberships aligned with that scope; standalone service consumers may
  // omit sessions, in which case their supplied facts remain usable.
  const activeSessionIds = input.sessions ? new Set(input.sessions.map((session) => session.id)) : null
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
    if (activeSessionIds && !activeSessionIds.has(link.sessionId)) return
    if (!conceptById.has(link.conceptId)) return
    const sessionUnits = unitsBySession.get(link.sessionId) ?? []
    sessionUnits.forEach((unit) => {
      const set = conceptsByUnit.get(unit.id) ?? new Set<string>()
      set.add(link.conceptId)
      conceptsByUnit.set(unit.id, set)
    })
    // A direct Session membership describes the whole conversation. Keep the
    // Concept edge on Message nodes even when KnowledgeUnit nodes are hidden;
    // otherwise toggling showUnits would make the same fact disappear.
    ;(messagesBySessionId.get(link.sessionId) ?? []).forEach((message) => {
      const set = conceptsByMessage.get(message.id) ?? new Set<string>()
      set.add(link.conceptId)
      conceptsByMessage.set(message.id, set)
    })
  })
  input.messages.forEach((message) => {
    if (!message.unitId) return
    const unitConceptIds = conceptsByUnit.get(message.unitId)
    if (!unitConceptIds?.size) return
    const set = conceptsByMessage.get(message.id) ?? new Set<string>()
    unitConceptIds.forEach((conceptId) => set.add(conceptId))
    conceptsByMessage.set(message.id, set)
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
  ;(input.sessionConcepts ?? []).forEach((link) => {
    if (activeSessionIds && !activeSessionIds.has(link.sessionId)) return
    addSessionConcepts(link.sessionId, [link.conceptId])
  })

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
      label: unit.title || '待命名阅读片段',
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

  // Project every distinct Concept pair in a Session to the first visible
  // ancestor on each hierarchy branch. Pair-first projection matters for a
  // multi-parent Concept: one Concept must not create a root-to-root edge by
  // itself, while a real pair still contributes to every root branch it
  // belongs to. Each visible pair is deduplicated once per Session.
  conceptsBySession.forEach((conceptIds) => {
    const ids = [...conceptIds]
    const projectedPairs = new Map<string, [string, string]>()
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        representativesFor(ids[left]).forEach((leftId) => representativesFor(ids[right]).forEach((rightId) => {
          if (leftId === rightId) return
          const pair = [leftId, rightId].sort() as [string, string]
          projectedPairs.set(JSON.stringify(pair), pair)
        }))
      }
    }
    projectedPairs.forEach(([leftId, rightId]) => ensureEdge(conceptNode(leftId), conceptNode(rightId), 'co_occurrence'))
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
    // LLM-authored related edges are intentionally ignored. Weak relations
    // are derived from shared Session/Message evidence; only explicit manual
    // or maintenance edits may add a persisted related relation.
    .filter((relation) => relation.relationType === 'related' && relation.source !== 'llm' && relationIsVisible(relation, Boolean(input.showProposed)))
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
