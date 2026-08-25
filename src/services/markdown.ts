export interface MarkdownConcept {
  id: string
  name: string
}

export interface RenderMarkdownOptions {
  /** Existing knowledge topics rendered as clickable mentions inside answers. */
  concepts?: MarkdownConcept[]
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface InlineToken {
  type: 'code' | 'anchor' | 'mention' | 'text'
  value: string
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
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
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
    tokens.push({ type: 'mention', value: `<span class="md-concept" role="link" tabindex="0" data-concept-id="${id}">${found[0]}</span>` })
    rest = rest.slice(found.index + found[0].length)
  }
  if (rest) tokens.push({ type: 'text', value: rest })
  return tokens
}

/** Split one line of already-escaped text into protected spans and plain text. */
function tokenizeInline(line: string, matcher: ConceptMatcher | null): InlineToken[] {
  const tokens: InlineToken[] = []
  const pushText = (value: string): void => {
    tokens.push(...linkifyConcepts(value, matcher))
  }
  const pattern = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line))) {
    if (match.index > cursor) pushText(line.slice(cursor, match.index))
    if (match[1] != null) tokens.push({ type: 'code', value: `<code>${match[1]}</code>` })
    else if (match[2] != null && match[3]) tokens.push({ type: 'anchor', value: anchorHtml(match[3], match[2]) })
    else if (match[4]) tokens.push({ type: 'anchor', value: anchorHtml(match[4], match[4]) })
    cursor = match.index + match[0].length
  }
  if (cursor < line.length) pushText(line.slice(cursor))
  return tokens
}

function applyEmphasis(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(（【，、])\*([^*\n]+)\*(?=[\s)）】，、。；：!?]|$)/g, '$1<em>$2</em>')
}

function renderInline(tokens: InlineToken[]): string {
  return tokens.map((token) => token.type === 'text' ? applyEmphasis(token.value) : token.value).join('')
}

/**
 * Render untrusted conversation content as presentation-only Markdown.
 * Every character is escaped before any markup is produced, so content can
 * never inject HTML, scripts or event handlers.
 */
export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): string {
  const matcher = buildConceptMatcher(options.concepts ?? [])
  const segments = source.replace(/\r\n?/g, '\n').split('```')
  return segments.map((segment, index) => {
    // Odd segments are the inside of fenced code blocks.
    if (index % 2 === 1) return `<pre><code>${escapeHtml(segment.replace(/\n$/, ''))}</code></pre>`
    return renderBlocks(segment, matcher)
  }).join('')
}

function renderBlocks(text: string, matcher: ConceptMatcher | null): string {
  const lines = text.split('\n')
  const blocks: string[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let quote: string[] = []

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
      blocks.push(`<blockquote><p>${renderInline(tokenizeInline(quote.join('<br />'), matcher))}</p></blockquote>`)
      quote = []
    }
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  lines.forEach((rawLine) => {
    const line = escapeHtml(rawLine)
    const trimmed = line.trim()
    if (!trimmed) {
      flushAll()
      return
    }
    if (/^(?:---+|\*\*\*+|___+)\s*$/.test(trimmed)) {
      flushAll()
      blocks.push('<hr />')
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
      quote.push(escapeHtml(quoteMatch[1]))
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
