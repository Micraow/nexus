import type { Concept, ConceptAlias, KnowledgeUnit, Message } from '@/types/domain'
import { normalizeText } from '@/utils/id'

export type SearchKind = 'concept' | 'unit' | 'message'
export type SearchField = 'name' | 'alias' | 'title' | 'summary' | 'content'

export interface SearchDocument {
  id: string
  kind: SearchKind
  refId: string
  fields: Partial<Record<SearchField, string>>
  updatedAt: string
}

export interface RankedSearchResult {
  kind: SearchKind
  refId: string
  field: SearchField
  relevance: number
}

export interface SearchMatches {
  concepts: Array<{ item: Concept; field: Extract<SearchField, 'name' | 'alias'>; relevance: number }>
  units: Array<{ item: KnowledgeUnit; field: Extract<SearchField, 'title' | 'summary'>; relevance: number }>
  messages: Array<{ item: Message; field: 'content'; relevance: number }>
}

interface SearchInput {
  concepts: Concept[]
  aliases: ConceptAlias[]
  units: KnowledgeUnit[]
  messages: Message[]
}

const fieldPriority: Record<SearchField, number> = {
  name: 5000,
  alias: 4500,
  title: 3500,
  summary: 2500,
  content: 1500,
}

function normalizedNgrams(value: string): string[] {
  const source = normalizeText(value).replace(/[\s,.:;!?()[\]{}"']/g, '')
  if (!source) return []
  if (source.length === 1) return [source]
  const grams = new Set<string>()
  for (let index = 0; index < source.length - 1; index += 1) grams.add(source.slice(index, index + 2))
  return [...grams]
}

function matchStrength(query: string, value: string): number | null {
  const normalizedQuery = normalizeText(query)
  const normalizedValue = normalizeText(value)
  if (!normalizedQuery || !normalizedValue) return null
  if (normalizedValue === normalizedQuery) return 1000
  const directIndex = normalizedValue.indexOf(normalizedQuery)
  if (directIndex >= 0) {
    const coverage = Math.min(180, Math.round((normalizedQuery.length / normalizedValue.length) * 180))
    return 760 + coverage - Math.min(120, directIndex)
  }
  const grams = normalizedNgrams(normalizedQuery)
  if (grams.length < 2) return null
  const matched = grams.filter((gram) => normalizedValue.includes(gram)).length
  const coverage = matched / grams.length
  if (coverage < 0.72) return null
  return Math.round(coverage * 520)
}

function dateScore(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 0
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000)
  return Math.max(0, 40 - Math.min(40, ageDays / 30))
}

function ftsScore(document: SearchDocument, ftsRanks: ReadonlyMap<string, number>): number {
  const rank = ftsRanks.get(document.id)
  if (rank == null || !Number.isFinite(rank)) return 0
  // SQLite bm25 uses lower values for better matches. It is only a tie-breaker
  // because the built-in tokenizer does not segment every Chinese phrase.
  return Math.max(0, 60 - Math.min(60, Math.abs(rank)))
}

export function buildSearchDocuments(input: SearchInput): SearchDocument[] {
  const aliasesByConcept = new Map<string, string[]>()
  input.aliases.forEach((alias) => {
    const current = aliasesByConcept.get(alias.conceptId) ?? []
    current.push(alias.alias)
    aliasesByConcept.set(alias.conceptId, current)
  })
  return [
    ...input.concepts.filter((concept) => concept.status === 'active').map((concept) => ({
      id: `concept:${concept.id}`,
      kind: 'concept' as const,
      refId: concept.id,
      fields: { name: concept.name, alias: (aliasesByConcept.get(concept.id) ?? []).join('\n') },
      updatedAt: concept.updatedAt,
    })),
    ...input.units.map((unit) => ({
      id: `unit:${unit.id}`,
      kind: 'unit' as const,
      refId: unit.id,
      fields: { title: unit.title ?? '', summary: unit.summary ?? '' },
      updatedAt: unit.updatedAt,
    })),
    ...input.messages.map((message) => ({
      id: `message:${message.id}`,
      kind: 'message' as const,
      refId: message.id,
      fields: { content: message.content },
      updatedAt: message.timestamp ?? '',
    })),
  ]
}

export function rankSearchDocuments(query: string, documents: SearchDocument[], ftsRanks: ReadonlyMap<string, number> = new Map()): RankedSearchResult[] {
  const results: Array<RankedSearchResult & { updatedAt: string }> = []
  documents.forEach((document) => {
    let best: { field: SearchField; relevance: number } | null = null
    for (const [field, value] of Object.entries(document.fields) as Array<[SearchField, string]>) {
      const strength = matchStrength(query, value)
      if (strength == null) continue
      const relevance = fieldPriority[field] + strength + dateScore(document.updatedAt) + ftsScore(document, ftsRanks)
      if (!best || relevance > best.relevance) best = { field, relevance }
    }
    if (best) results.push({ kind: document.kind, refId: document.refId, field: best.field, relevance: best.relevance, updatedAt: document.updatedAt })
  })
  return results
    .sort((left, right) => right.relevance - left.relevance || right.updatedAt.localeCompare(left.updatedAt) || left.refId.localeCompare(right.refId))
    .map(({ updatedAt: _updatedAt, ...result }) => result)
}

export function searchKnowledge(query: string, input: SearchInput, ftsRanks: ReadonlyMap<string, number> = new Map()): SearchMatches {
  const documents = buildSearchDocuments(input)
  const byId = new Map(documents.map((document) => [document.id, document]))
  const conceptsById = new Map(input.concepts.map((concept) => [concept.id, concept]))
  const unitsById = new Map(input.units.map((unit) => [unit.id, unit]))
  const messagesById = new Map(input.messages.map((message) => [message.id, message]))
  const output: SearchMatches = { concepts: [], units: [], messages: [] }
  rankSearchDocuments(query, documents, ftsRanks).forEach((result) => {
    const document = byId.get(`${result.kind}:${result.refId}`)
    if (!document) return
    if (result.kind === 'concept') {
      const item = conceptsById.get(result.refId)
      if (item && (result.field === 'name' || result.field === 'alias')) output.concepts.push({ item, field: result.field, relevance: result.relevance })
    } else if (result.kind === 'unit') {
      const item = unitsById.get(result.refId)
      if (item && (result.field === 'title' || result.field === 'summary')) output.units.push({ item, field: result.field, relevance: result.relevance })
    } else {
      const item = messagesById.get(result.refId)
      if (item) output.messages.push({ item, field: 'content', relevance: result.relevance })
    }
  })
  return output
}
