import { parseMetadata } from '@/utils/metadata'
import type { KnowledgeUnit, Message, MessageConcept, Session, SessionConcept, UnitConcept } from '@/types/domain'

export interface ConceptEvidenceInput {
  conceptId: string
  sessions: Session[]
  messages: Message[]
  units: KnowledgeUnit[]
  sessionConcepts: SessionConcept[]
  messageConcepts: MessageConcept[]
  unitConcepts: UnitConcept[]
}

export interface ConceptEvidence {
  sessions: Session[]
  messages: Message[]
  units: KnowledgeUnit[]
}

/**
 * Resolve all active evidence for one Concept without broadening local facts.
 * SessionConcept covers a full conversation, while MessageConcept and
 * UnitConcept only expose their own message or optional reading excerpt.
 */
export function resolveConceptEvidence(input: ConceptEvidenceInput): ConceptEvidence {
  const activeSessions = input.sessions.filter((session) => !session.deletedAt)
  const activeSessionIds = new Set(activeSessions.map((session) => session.id))
  const directSessionIds = new Set(input.sessionConcepts
    .filter((link) => link.conceptId === input.conceptId && activeSessionIds.has(link.sessionId))
    .map((link) => link.sessionId))
  const directMessageIds = new Set(input.messageConcepts
    .filter((link) => link.conceptId === input.conceptId)
    .map((link) => link.messageId))

  input.messages.forEach((message) => {
    if (!activeSessionIds.has(message.sessionId)) return
    const declared = parseMetadata(message.metadata).concept_ids
    if (Array.isArray(declared) && declared.includes(input.conceptId)) directMessageIds.add(message.id)
  })

  const directUnitIds = new Set(input.unitConcepts
    .filter((link) => link.conceptId === input.conceptId)
    .map((link) => link.unitId))
  const activeUnits = input.units.filter((unit) => activeSessionIds.has(unit.sessionId))
  const evidenceUnits = activeUnits.filter((unit) => {
    if (directSessionIds.has(unit.sessionId) || directUnitIds.has(unit.id)) return true
    return input.messages.some((message) => message.unitId === unit.id && directMessageIds.has(message.id))
  })
  const evidenceUnitIds = new Set(evidenceUnits.map((unit) => unit.id))

  const evidenceMessages = input.messages.filter((message) => {
    if (!activeSessionIds.has(message.sessionId)) return false
    return directSessionIds.has(message.sessionId)
      || directMessageIds.has(message.id)
      || Boolean(message.unitId && evidenceUnitIds.has(message.unitId))
  })

  const evidenceSessionIds = new Set(directSessionIds)
  evidenceUnits.forEach((unit) => evidenceSessionIds.add(unit.sessionId))
  evidenceMessages.forEach((message) => evidenceSessionIds.add(message.sessionId))
  const evidenceSessions = activeSessions
    .filter((session) => evidenceSessionIds.has(session.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  const sessionOrder = new Map(evidenceSessions.map((session, index) => [session.id, index]))

  evidenceMessages.sort((left, right) => {
    const leftSession = sessionOrder.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER
    const rightSession = sessionOrder.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER
    return leftSession - rightSession || left.orderInSession - right.orderInSession || left.id.localeCompare(right.id)
  })

  return { sessions: evidenceSessions, messages: evidenceMessages, units: evidenceUnits }
}
