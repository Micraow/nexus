import katex from 'katex'
import 'katex/dist/katex.min.css'
import hljs from 'highlight.js/lib/common'

export interface MarkdownConcept {
  id: string
  name: string
  /** Alternate spellings that resolve to the same local topic. */
  aliases?: string[]
  /** Concepts created by the current answer remain exploratory until confirmed. */
  kind?: 'existing' | 'suggested'
}

export interface RenderMarkdownOptions {
  /** Existing knowledge topics rendered as clickable mentions inside answers. */
  concepts?: MarkdownConcept[]
  /** Control implicit plain-text linking; explicit Nexus markers always parse. */
  autoLinkConcepts?: boolean | 'suggested'
}

type AutoLinkMode = 'all' | 'suggested' | 'none'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface InlineToken {
  type: 'code' | 'anchor' | 'mention' | 'math' | 'strong' | 'text'
  value: string
}

function renderMath(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source.trim(), {
      displayMode,
      output: 'htmlAndMathml',
      throwOnError: false,
      strict: false,
      trust: false,
    })
  } catch {
    return `<code class="math-source">${escapeHtml(source.trim())}</code>`
  }
}

interface ConceptMatcher {
  pattern: RegExp
  /** Maps a matched, unescaped name back to the concept id and presentation kind. */
  entries: Map<string, { id: string; kind: 'existing' | 'suggested' }>
}

function conceptKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/[\s\u3000]+/g, ' ').toLocaleUpperCase()
}

function buildConceptMatcher(concepts: MarkdownConcept[]): ConceptMatcher | null {
  const usable = concepts.filter((concept) => concept.name.trim())
  if (!usable.length) return null
  const entries = new Map<string, { id: string; kind: 'existing' | 'suggested' }>()
  const sources: string[] = []
  usable.forEach((concept) => {
    const kind = concept.kind ?? 'existing'
    const labels = [concept.name, ...(concept.aliases ?? [])]
    labels.forEach((rawLabel) => {
      const label = rawLabel.trim()
      if (!label) return
      // Keep the first owner for an ambiguous alias. Names are inserted before
      // aliases, so a canonical topic always wins over a stale alias collision.
      const key = conceptKey(label)
      if (!entries.has(key)) entries.set(key, { id: concept.id, kind })
      sources.push(escapeRegExp(label))
    })
  })
  // Longest-first prevents a short acronym from stealing a longer technical
  // phrase (for example RDMA from “RDMA congestion control”).
  sources.sort((left, right) => right.length - left.length)
  return { pattern: new RegExp(sources.join('|'), 'iu'), entries }
}

function anchorHtml(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
}

function highlightedCode(code: string, language: string): string {
  const normalized = language.trim().toLowerCase()
  try {
    if (normalized && hljs.getLanguage(normalized)) {
      return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value
    }
    if (!normalized && code.trim()) return hljs.highlightAuto(code).value
  } catch {
    // Unknown grammars and malformed snippets remain safely escaped below.
  }
  return escapeHtml(code)
}

function fencedCodeHtml(language: string, code: string): string {
  const normalized = language.trim().toLowerCase()
  const className = normalized ? ` class="hljs language-${escapeHtml(normalized)}"` : ' class="hljs"'
  return `<pre><code${className}>${highlightedCode(code, normalized)}</code></pre>`
}

function conceptMentionHtml(label: string, id: string, kind: 'existing' | 'suggested', name = label): string {
  const escapedLabel = escapeHtml(label)
  if (kind === 'suggested') {
    const escapedName = escapeHtml(name)
    return `<span class="md-concept md-concept-suggested" role="link" tabindex="0" data-suggested-concept="${escapedName}" aria-label="继续探索 ${escapedName}" title="继续探索">${escapedLabel}</span>`
  }
  // An explicit "existing" marker is only interactive/blue when it resolves
  // to an active local Concept. Unknown names must remain ordinary answer text
  // so the UI never implies a link to a non-existent topic.
  if (!id) return escapedLabel
  return `<span class="md-concept md-concept-existing"${id ? ` role="link" tabindex="0" data-concept-id="${escapeHtml(id)}"` : ''}>${escapedLabel}</span>`
}

function linkifyConcepts(raw: string, matcher: ConceptMatcher | null, mode: AutoLinkMode = 'all'): InlineToken[] {
  if (!matcher || mode === 'none') return raw ? [{ type: 'text', value: escapeHtml(raw) }] : []
  const tokens: InlineToken[] = []
  let rest = raw
  for (;;) {
    const found = matcher.pattern.exec(rest)
    if (!found || found[0].length === 0) break
    if (found.index > 0) tokens.push({ type: 'text', value: escapeHtml(rest.slice(0, found.index)) })
    const entry = matcher.entries.get(conceptKey(found[0]))
    const id = entry?.id ?? ''
    if (mode === 'suggested' && entry?.kind !== 'suggested') tokens.push({ type: 'text', value: escapeHtml(found[0]) })
    else tokens.push({ type: 'mention', value: conceptMentionHtml(found[0], id, entry?.kind ?? 'existing', found[0]) })
    rest = rest.slice(found.index + found[0].length)
  }
  if (rest) tokens.push({ type: 'text', value: escapeHtml(rest) })
  return tokens
}

const LEGACY_MARKER_PLACEHOLDERS = new Set([
  '原文',
  '正文',
  '显示文本',
  '主题名称',
  '主题名',
  'label',
  'text',
])

function markerLabel(name: string, label: string): string {
  const normalized = label.trim()
  return !normalized || LEGACY_MARKER_PLACEHOLDERS.has(normalized.toLowerCase()) ? name : label
}

function cleanMarkerName(value: string): string {
  return value
    .replace(/\[\[\/?nexus(?::(?:existing|suggested):)?/gi, '')
    .replace(/\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function markerCloseIndex(raw: string, from: number): { index: number; length: number } | null {
  const close = /\[\[\/nexus\s*\]\]/gi
  close.lastIndex = from
  const match = close.exec(raw)
  return match ? { index: match.index, length: match[0].length } : null
}

/** Find the closing `]]` for a marker header, skipping nested marker headers. */
function markerHeaderEnd(raw: string, start: number): number {
  for (let index = start; index < raw.length - 1; index += 1) {
    if (raw.slice(index).match(/^\[\[nexus:(?:existing|suggested):/i)) {
      const nestedPrefix = raw.slice(index).match(/^\[\[nexus:(?:existing|suggested):/i)?.[0] ?? ''
      const nestedEnd = markerHeaderEnd(raw, index + nestedPrefix.length)
      if (nestedEnd < 0) return -1
      index = nestedEnd + 1
      continue
    }
    if (raw.startsWith(']]', index)) {
      return index
    }
  }
  return -1
}

/**
 * Conversation answers may explicitly distinguish known topics from ideas
 * worth exploring. The delimiters are presentation-only and are removed from
 * the rendered output; unknown suggested names remain non-interactive.
 */
function linkifyMarkedConcepts(raw: string, matcher: ConceptMatcher | null, autoLinkMode: AutoLinkMode = 'all'): InlineToken[] {
  const tokens: InlineToken[] = []
  let cursor = 0
  const pushPlain = (value: string): void => {
    // A response may contain a stray closing marker after a malformed opener.
    // It is presentation syntax, so never expose it as answer text.
    const plain = value.replace(/\[\[\/nexus\s*\]\]/gi, '')
    tokens.push(...linkifyConcepts(plain, matcher, autoLinkMode))
  }
  const findOpening = (from: number): { index: number; kind: 'existing' | 'suggested'; name: string; headerEnd: number } | null => {
    const opening = /\[\[nexus:(existing|suggested):/gi
    opening.lastIndex = from
    const match = opening.exec(raw)
    if (!match) return null
    const headerEnd = markerHeaderEnd(raw, match.index + match[0].length)
    if (headerEnd < 0) return null
    return {
      index: match.index,
      kind: match[1].toLowerCase() as 'existing' | 'suggested',
      name: cleanMarkerName(raw.slice(match.index + match[0].length, headerEnd)),
      headerEnd,
    }
  }
  for (;;) {
    const match = findOpening(cursor)
    if (!match) {
      if (cursor < raw.length) pushPlain(raw.slice(cursor))
      break
    }
    if (match.index > cursor) pushPlain(raw.slice(cursor, match.index))
    const kind = match.kind
    const headerEnd = match.headerEnd
    const name = match.name
    const bodyStart = headerEnd + 2
    const close = markerCloseIndex(raw, bodyStart)
    const nextOpening = findOpening(bodyStart)
    // A missing close must not swallow a later marker. Treat the malformed
    // opening as an empty marker and resume scanning at its body text.
    const hasValidClose = Boolean(close && close.index >= bodyStart && (!nextOpening || close.index < nextOpening.index))
    const body = hasValidClose && close ? raw.slice(bodyStart, close.index) : ''
    // Older prompts used literal placeholders such as “原文” for the body.
    // Keep those responses readable by displaying the marker's topic name.
    const label = markerLabel(name, cleanMarkerName(body))
    const entry = matcher?.entries.get(conceptKey(name)) ?? matcher?.entries.get(conceptKey(label.trim()))
    const id = entry?.id ?? ''
    // A marker explicitly labelled existing can still refer to a Concept
    // created by this answer. Keep it exploratory until the user confirms it,
    // rather than showing a misleading blue link to a just-created topic.
    const presentationKind = entry?.kind === 'suggested' ? 'suggested' : kind
    tokens.push({ type: 'mention', value: conceptMentionHtml(label, id, presentationKind, name) })
    cursor = hasValidClose && close ? close.index + close.length : bodyStart
  }
  return tokens
}

/** Split raw Markdown text into protected spans and plain text. */
function tokenizeInline(line: string, matcher: ConceptMatcher | null, autoLinkMode: AutoLinkMode = 'all'): InlineToken[] {
  const tokens: InlineToken[] = []
  const pushText = (value: string): void => {
    tokens.push(...linkifyMarkedConcepts(value, matcher, autoLinkMode))
  }
  // Protect strong spans before concept linkification so `**bold Concept**`
  // keeps both markers in one token.
  const pattern = /`([^`]+)`|\*\*([\s\S]+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)|\$\$([\s\S]+?)\$\$|\\\(([^\n]+?)\\\)|\\\[([\s\S]+?)\\\]|(?<!\$)\$([^$\n]+?)\$(?!\$)/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line))) {
    if (match.index > cursor) pushText(line.slice(cursor, match.index))
    if (match[1] != null) tokens.push({ type: 'code', value: `<code>${escapeHtml(match[1])}</code>` })
    else if (match[2] != null) tokens.push({ type: 'strong', value: `<strong>${renderInline(tokenizeInline(match[2], matcher, autoLinkMode))}</strong>` })
    else if (match[3] != null && match[4]) tokens.push({ type: 'anchor', value: anchorHtml(match[4], match[3]) })
    else if (match[5]) tokens.push({ type: 'anchor', value: anchorHtml(match[5], match[5]) })
    else if (match[6] != null) tokens.push({ type: 'math', value: renderMath(match[6], true) })
    else if (match[7] != null) tokens.push({ type: 'math', value: renderMath(match[7], false) })
    else if (match[8] != null) tokens.push({ type: 'math', value: renderMath(match[8], true) })
    else if (match[9] != null) tokens.push({ type: 'math', value: renderMath(match[9], false) })
    cursor = match.index + match[0].length
  }
  if (cursor < line.length) pushText(line.slice(cursor))
  return tokens
}

function renderInline(tokens: InlineToken[]): string {
  return tokens.map((token) => token.type === 'text'
    ? token.value.replace(/(^|[\s(（【，、])\*([^*\n]+)\*(?=[\s)）】，、。；：!?]|$)/g, '$1<em>$2</em>')
    : token.value).join('')
}

function tableCells(line: string): string[] {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1)
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const character of value) {
    if (character === '|' && !escaped) {
      cells.push(current.trim())
      current = ''
      continue
    }
    if (character === '\\' && !escaped) {
      escaped = true
      current += character
      continue
    }
    escaped = false
    current += character
  }
  cells.push(current.trim())
  return cells.map((cell) => cell.replace(/\\\|/g, '|'))
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

/**
 * Render untrusted conversation content as presentation-only Markdown.
 * Every character is escaped before any markup is produced, so content can
 * never inject HTML, scripts or event handlers.
 */
export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): string {
  const matcher = buildConceptMatcher(options.concepts ?? [])
  const autoLinkMode: AutoLinkMode = options.autoLinkConcepts === false
    ? 'none'
    : options.autoLinkConcepts === 'suggested' ? 'suggested' : 'all'
  const normalized = source.replace(/\r\n?/g, '\n')
  const fence = /```([A-Za-z0-9_+#.-]*)[ \t]*\n([\s\S]*?)```/g
  let cursor = 0
  let output = ''
  let match: RegExpExecArray | null
  while ((match = fence.exec(normalized))) {
    output += renderBlocks(normalized.slice(cursor, match.index), matcher, autoLinkMode)
    output += fencedCodeHtml(match[1], match[2].replace(/\n$/, ''))
    cursor = match.index + match[0].length
  }
  output += renderBlocks(normalized.slice(cursor), matcher, autoLinkMode)
  return output
}

function renderBlocks(text: string, matcher: ConceptMatcher | null, autoLinkMode: AutoLinkMode = 'all'): string {
  const displayMath: Array<{ placeholder: string; html: string }> = []
  const withDisplayPlaceholders = text.replace(/(^|\n)[ \t]*(\$\$|\\\[)([\s\S]*?)(\$\$|\\\])[ \t]*(?=\n|$)/g, (match, prefix: string, opening: string, body: string, closing: string) => {
    if ((opening === '$$' && closing !== '$$') || (opening === '\\[' && closing !== '\\]')) return match
    const placeholder = `NEXUS_MATH_BLOCK_${displayMath.length}`
    displayMath.push({ placeholder, html: `<div class="math-block">${renderMath(body, true)}</div>` })
    return `${prefix}${placeholder}`
  })
  const lines = withDisplayPlaceholders.split('\n')
  const blocks: string[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let quote: string[] = []
  let skippedTableLines = 0

  const flushParagraph = () => {
    if (paragraph.length) {
      const inline = renderInline(tokenizeInline(paragraph.join('\n'), matcher, autoLinkMode)).replace(/\n/g, '<br />')
      blocks.push(`<p>${inline}</p>`)
      paragraph = []
    }
  }
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul'
      blocks.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(tokenizeInline(item, matcher, autoLinkMode))}</li>`).join('')}</${tag}>`)
      list = null
    }
  }
  const flushQuote = () => {
    if (quote.length) {
      blocks.push(`<blockquote><p>${renderInline(tokenizeInline(quote.join('\n'), matcher, autoLinkMode)).replace(/\n/g, '<br />')}</p></blockquote>`)
      quote = []
    }
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  lines.forEach((rawLine, lineIndex) => {
    if (skippedTableLines > 0) {
      skippedTableLines -= 1
      return
    }
    const trimmed = rawLine.trim()
    if (!trimmed) {
      flushAll()
      return
    }
    if (/^(?:---+|\*\*\*+|___+)\s*$/.test(trimmed)) {
      flushAll()
      blocks.push('<hr />')
      return
    }
    const displayPlaceholder = displayMath.find((item) => item.placeholder === trimmed)
    if (displayPlaceholder) {
      flushAll()
      blocks.push(displayPlaceholder.html)
      return
    }
    const separator = lines[lineIndex + 1]?.trim() ?? ''
    if (tableCells(trimmed).length > 1 && isTableSeparator(separator)) {
      flushAll()
      const headers = tableCells(trimmed)
      const rows: string[][] = []
      let nextIndex = lineIndex + 2
      while (nextIndex < lines.length) {
        const candidate = lines[nextIndex].trim()
        if (!candidate || tableCells(candidate).length < 1 || !candidate.includes('|')) break
        rows.push(tableCells(candidate))
        nextIndex += 1
      }
      const headerHtml = headers.map((cell) => `<th>${renderInline(tokenizeInline(cell, matcher, autoLinkMode))}</th>`).join('')
      const rowHtml = rows.map((row) => {
        const cells = headers.map((_, index) => row[index] ?? '')
        return `<tr>${cells.map((cell) => `<td>${renderInline(tokenizeInline(cell, matcher, autoLinkMode))}</td>`).join('')}</tr>`
      }).join('')
      blocks.push(`<table><thead><tr>${headerHtml}</tr></thead><tbody>${rowHtml}</tbody></table>`)
      skippedTableLines = nextIndex - lineIndex - 1
      return
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushAll()
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInline(tokenizeInline(heading[2], matcher, autoLinkMode))}</h${level}>`)
      return
    }
    const quoteMatch = rawLine.match(/^\s{0,3}>\s?(.*)$/)
    if (quoteMatch) {
      flushParagraph()
      flushList()
      quote.push(quoteMatch[1])
      return
    }
    const bullet = rawLine.match(/^\s*[-*+]\s+(.*)$/)
    const numbered = rawLine.match(/^\s*\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      flushParagraph()
      flushQuote()
      const ordered = Boolean(numbered)
      const item = (numbered ? numbered[1] : bullet![1]).trim()
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push(item)
      return
    }
    flushList()
    flushQuote()
    paragraph.push(trimmed)
  })
  flushAll()
  return blocks.join('')
}
