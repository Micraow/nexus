import katex from 'katex'
import 'katex/dist/katex.min.css'
import hljs from 'highlight.js/lib/common'

export interface MarkdownConcept {
  id: string
  name: string
}

export interface RenderMarkdownOptions {
  /** Existing knowledge topics rendered as clickable mentions inside answers. */
  concepts?: MarkdownConcept[]
}

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
  /** Maps the escaped, matched name back to the concept id. */
  ids: Map<string, string>
}

function buildConceptMatcher(concepts: MarkdownConcept[]): ConceptMatcher | null {
  const usable = concepts.filter((concept) => concept.name.trim())
  if (!usable.length) return null
  const ordered = usable.slice().sort((left, right) => right.name.length - left.name.length)
  const ids = new Map<string, string>()
  const sources = ordered.map((concept) => {
    const escapedName = escapeHtml(concept.name.trim())
    ids.set(escapedName, concept.id)
    return escapeRegExp(escapedName)
  })
  return { pattern: new RegExp(sources.join('|')), ids }
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
  if (kind === 'suggested') {
    return `<span class="md-concept md-concept-suggested" role="link" tabindex="0" data-suggested-concept="${name}" aria-label="继续探索 ${name}" title="继续探索">${label}</span>`
  }
  return `<span class="md-concept md-concept-existing"${id ? ` role="link" tabindex="0" data-concept-id="${escapeHtml(id)}"` : ''}>${label}</span>`
}

function linkifyConcepts(raw: string, matcher: ConceptMatcher | null): InlineToken[] {
  if (!matcher) return raw ? [{ type: 'text', value: raw }] : []
  const tokens: InlineToken[] = []
  let rest = raw
  for (;;) {
    const found = matcher.pattern.exec(rest)
    if (!found || found[0].length === 0) break
    if (found.index > 0) tokens.push({ type: 'text', value: rest.slice(0, found.index) })
    const id = matcher.ids.get(found[0]) ?? ''
    tokens.push({ type: 'mention', value: conceptMentionHtml(found[0], id, 'existing') })
    rest = rest.slice(found.index + found[0].length)
  }
  if (rest) tokens.push({ type: 'text', value: rest })
  return tokens
}

/**
 * Conversation answers may explicitly distinguish known topics from ideas
 * worth exploring. The delimiters are presentation-only and are removed from
 * the rendered output; unknown suggested names remain non-interactive.
 */
function linkifyMarkedConcepts(raw: string, matcher: ConceptMatcher | null): InlineToken[] {
  const pattern = /\[\[nexus:(existing|suggested):([^\]]+)\]\]([\s\S]*?)\[\[\/nexus\]\]/gi
  const tokens: InlineToken[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw))) {
    if (match.index > cursor) tokens.push(...linkifyConcepts(raw.slice(cursor, match.index), matcher))
    const kind = match[1].toLowerCase() as 'existing' | 'suggested'
    const label = match[3] || match[2]
    const id = matcher?.ids.get(match[2].trim()) ?? matcher?.ids.get(label.trim()) ?? ''
    tokens.push({ type: 'mention', value: conceptMentionHtml(label, id, kind, match[2].trim()) })
    cursor = match.index + match[0].length
  }
  if (cursor < raw.length) tokens.push(...linkifyConcepts(raw.slice(cursor), matcher))
  return tokens
}

/** Split raw Markdown text into protected spans and plain text. */
function tokenizeInline(line: string, matcher: ConceptMatcher | null): InlineToken[] {
  const tokens: InlineToken[] = []
  const pushText = (value: string): void => {
    tokens.push(...linkifyMarkedConcepts(escapeHtml(value), matcher))
  }
  // Protect strong spans before concept linkification so `**bold Concept**`
  // keeps both markers in one token.
  const pattern = /`([^`]+)`|\*\*([\s\S]+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)|\$\$([\s\S]+?)\$\$|\\\(([^\n]+?)\\\)|\\\[([\s\S]+?)\\\]|(?<!\$)\$([^$\n]+?)\$(?!\$)/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line))) {
    if (match.index > cursor) pushText(line.slice(cursor, match.index))
    if (match[1] != null) tokens.push({ type: 'code', value: `<code>${escapeHtml(match[1])}</code>` })
    else if (match[2] != null) tokens.push({ type: 'strong', value: `<strong>${renderInline(tokenizeInline(match[2], matcher))}</strong>` })
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
  const normalized = source.replace(/\r\n?/g, '\n')
  const fence = /```([A-Za-z0-9_+#.-]*)[ \t]*\n([\s\S]*?)```/g
  let cursor = 0
  let output = ''
  let match: RegExpExecArray | null
  while ((match = fence.exec(normalized))) {
    output += renderBlocks(normalized.slice(cursor, match.index), matcher)
    output += fencedCodeHtml(match[1], match[2].replace(/\n$/, ''))
    cursor = match.index + match[0].length
  }
  output += renderBlocks(normalized.slice(cursor), matcher)
  return output
}

function renderBlocks(text: string, matcher: ConceptMatcher | null): string {
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
      const inline = renderInline(tokenizeInline(paragraph.join('\n'), matcher)).replace(/\n/g, '<br />')
      blocks.push(`<p>${inline}</p>`)
      paragraph = []
    }
  }
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul'
      blocks.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(tokenizeInline(item, matcher))}</li>`).join('')}</${tag}>`)
      list = null
    }
  }
  const flushQuote = () => {
    if (quote.length) {
      blocks.push(`<blockquote><p>${renderInline(tokenizeInline(quote.join('\n'), matcher)).replace(/\n/g, '<br />')}</p></blockquote>`)
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
      const headerHtml = headers.map((cell) => `<th>${renderInline(tokenizeInline(cell, matcher))}</th>`).join('')
      const rowHtml = rows.map((row) => {
        const cells = headers.map((_, index) => row[index] ?? '')
        return `<tr>${cells.map((cell) => `<td>${renderInline(tokenizeInline(cell, matcher))}</td>`).join('')}</tr>`
      }).join('')
      blocks.push(`<table><thead><tr>${headerHtml}</tr></thead><tbody>${rowHtml}</tbody></table>`)
      skippedTableLines = nextIndex - lineIndex - 1
      return
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushAll()
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInline(tokenizeInline(heading[2], matcher))}</h${level}>`)
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
