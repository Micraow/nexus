import type { EvidenceChunk, Message, SessionWorkingMemory } from '@/types/domain'
import { buildEvidenceChunks } from '@/utils/chunks'
import { stableHash } from '@/utils/id'

export interface EvidenceCard {
  refID: string
  entityType: 'chunk' | 'message'
  title: string
  excerpt: string
  sourceMessageId: string
  sourceSessionId: string
  charStart: number
  charEnd: number
  tokenCount: number
  score: number
}

export interface EvidenceSearchOptions {
  query?: string
  sessionIds?: string[]
  messageIds?: string[]
  maxResults?: number
  maxTokens?: number
}

export function indexEvidence(messages: Message[], maxTokens = 420): EvidenceChunk[] {
  return buildEvidenceChunks(messages, maxTokens)
}

function terms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1))]
}

function scoreChunk(chunk: EvidenceChunk, queryTerms: string[]): number {
  if (!queryTerms.length) return 1
  const haystack = chunk.content.toLocaleLowerCase()
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 + Math.min(2, haystack.split(term).length - 1) : 0), 0)
}

export function searchEvidence(chunks: EvidenceChunk[], options: EvidenceSearchOptions = {}): EvidenceCard[] {
  const allowedSessions = options.sessionIds?.length ? new Set(options.sessionIds) : null
  const allowedMessages = options.messageIds?.length ? new Set(options.messageIds) : null
  const queryTerms = terms(options.query ?? '')
  const maxResults = Math.max(1, options.maxResults ?? 8)
  const maxTokens = Math.max(1, options.maxTokens ?? 1800)
  let usedTokens = 0
  const cards = chunks
    .filter((chunk) => (!allowedSessions || allowedSessions.has(chunk.sessionId)) && (!allowedMessages || allowedMessages.has(chunk.messageId)))
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTerms) }))
    .filter(({ score }) => !queryTerms.length || score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.chunkIndex - right.chunk.chunkIndex)
    .filter(({ chunk }) => {
      if (usedTokens + chunk.tokenCount > maxTokens && usedTokens > 0) return false
      usedTokens += chunk.tokenCount
      return true
    })
    .slice(0, maxResults)
  return cards.map(({ chunk, score }) => ({
    refID: chunk.id,
    entityType: 'chunk',
    title: `证据片段：${chunk.messageId} #${chunk.chunkIndex + 1}`,
    excerpt: chunk.content,
    sourceMessageId: chunk.messageId,
    sourceSessionId: chunk.sessionId,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    tokenCount: chunk.tokenCount,
    score,
  }))
}

export function formatEvidenceCards(cards: EvidenceCard[]): string {
  return JSON.stringify(cards.map((card) => ({
    refID: card.refID,
    entity_type: card.entityType,
    title: card.title,
    excerpt: card.excerpt,
    source_message_id: card.sourceMessageId,
    source_session_id: card.sourceSessionId,
    char_range: [card.charStart, card.charEnd],
    token_count: card.tokenCount,
  })))
}

export function buildWorkingMemory(input: { sessionId: string; summary?: string; messages: Message[]; previous?: SessionWorkingMemory | null; maxRecent?: number }): SessionWorkingMemory {
  const recent = input.messages.slice(-(input.maxRecent ?? 6)).map((message) => `${message.role}: ${message.content}`).join('\n')
  const summary = (input.previous?.summary || input.summary || recent).replace(/\s+/gu, ' ').trim().slice(0, 1600)
  const unresolvedQuestions = input.previous?.unresolvedQuestions ?? []
  return {
    sessionId: input.sessionId,
    summary,
    decisions: input.previous?.decisions ?? [],
    unresolvedQuestions,
    updatedAt: new Date().toISOString(),
    revision: (input.previous?.revision ?? 0) + 1,
  }
}

export function workingMemoryHash(memory: SessionWorkingMemory): string {
  return stableHash(JSON.stringify(memory))
}
