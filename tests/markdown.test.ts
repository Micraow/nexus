import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@/services/markdown'

describe('renderMarkdown', () => {
  it('escapes raw HTML and never emits executable markup', () => {
    const html = renderMarkdown('<script>alert(1)</script> & <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('renders headings, lists, emphasis, code and blockquotes', () => {
    const html = renderMarkdown('# 标题\n\n- 第一项\n- 第二项\n\n1. 有序\n\n**加粗** 与 `code`\n> 引用行')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<ul><li>第一项</li><li>第二项</li></ul>')
    expect(html).toContain('<ol><li>有序</li></ol>')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<blockquote>')
  })

  it('renders pipe tables and keeps cell markdown interactive', () => {
    const html = renderMarkdown('| 项目 | 说明 |\n| --- | :---: |\n| `code` | [文档](https://example.com) |')
    expect(html).toContain('<table>')
    expect(html).toContain('<thead>')
    expect(html).toContain('<th>项目</th>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('href="https://example.com"')
  })

  it('renders fenced code blocks with escaped content', () => {
    const html = renderMarkdown('```js\nconst a = "<b>";\n```')
    expect(html).toContain('<pre><code')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
    expect(html).toContain('language-js')
    expect(html).toContain('hljs-keyword')
  })

  it('keeps Chinese bold text intact when it contains punctuation or concepts', () => {
    const html = renderMarkdown('因为 **B.com 的解析权不在你这台自建服务器上**，所以可以继续。', {
      concepts: [{ id: 'bcom', name: 'B.com' }],
    })
    expect(html).toContain('<strong>')
    expect(html).toContain('B.com')
    expect(html).toContain('解析权不在你这台自建服务器上</strong>')
    expect(html).not.toContain('**')
  })

  it('only linkifies http(s) links and rejects other schemes', () => {
    const html = renderMarkdown('[官网](https://example.com) 和 [坏](javascript:alert(1))')
    expect(html).toContain('<a href="https://example.com"')
    expect(html).not.toContain('href="javascript:')
    const bare = renderMarkdown('访问 https://example.com/docs 获取说明')
    expect(bare).toContain('<a href="https://example.com/docs"')
  })

  it('wraps known concept mentions with clickable spans carrying ids', () => {
    const html = renderMarkdown('讨论 RDMA 的拥塞控制，也单独涉及 RDMA 与 ECN。', {
      concepts: [
        { id: 'concept_1', name: 'RDMA' },
        { id: 'concept_2', name: 'RDMA 的拥塞控制' },
      ],
    })
    expect(html).toContain('data-concept-id="concept_2"')
    expect(html.indexOf('concept_2')).toBeLessThan(html.indexOf('concept_1'))
    expect((html.match(/data-concept-id/g) ?? []).length).toBe(2)
  })

  it('renders existing topic markers blue and suggested markers yellow', () => {
    const html = renderMarkdown('已知 [[nexus:existing:RDMA]]RDMA[[/nexus]]，建议 [[nexus:suggested:量子纠错]]量子纠错[[/nexus]]。', {
      concepts: [{ id: 'c1', name: 'RDMA' }],
    })
    expect(html).toContain('md-concept-existing')
    expect(html).toContain('data-concept-id="c1"')
    expect(html).toContain('md-concept-suggested')
    expect(html).toContain('data-suggested-concept="量子纠错"')
    expect(html).toContain('tabindex="0"')
    expect(html).not.toContain('nexus:existing')
    expect(html).not.toContain('nexus:suggested')
  })

  it('renders markers embedded in a paragraph without leaking delimiters', () => {
    const html = renderMarkdown('前缀 [[nexus:suggested:量子纠错]]量子纠错[[/nexus]] 后缀。')
    expect(html).toContain('<p>前缀 <span class="md-concept md-concept-suggested"')
    expect(html).toContain('>量子纠错</span> 后缀。</p>')
    expect(html).not.toContain('[[nexus:')
  })

  it('falls back to the marker name for legacy placeholder bodies', () => {
    const html = renderMarkdown('建议 [[nexus:suggested:量子纠错]]原文[[/nexus]]，旧格式 [[nexus:existing:RDMA]]主题名称[[/nexus]]。', {
      concepts: [{ id: 'c1', name: 'RDMA' }],
    })
    expect(html).toContain('data-suggested-concept="量子纠错"')
    expect(html).toContain('>量子纠错</span>')
    expect(html).toContain('data-concept-id="c1"')
    expect(html).toContain('>RDMA</span>')
    expect(html).not.toContain('>原文</span>')
    expect(html).not.toContain('>主题名称</span>')
  })

  it('escapes marker text and attributes against HTML injection', () => {
    const html = renderMarkdown('[[nexus:suggested:<img src=x onerror="alert(1)">]]<img src=x onerror="alert(1)">[[/nexus]]')
    expect(html).toContain('data-suggested-concept="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror="')
  })

  it('does not linkify concept names inside inline code', () => {
    const html = renderMarkdown('保持 `RDMA` 原样', { concepts: [{ id: 'c1', name: 'RDMA' }] })
    expect(html).toContain('<code>RDMA</code>')
    expect(html).not.toContain('data-concept-id')
  })

  it('renders inline and display mathematical expressions with KaTeX', () => {
    const html = renderMarkdown('能量关系 $E=mc^2$。\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$')
    expect(html).toContain('katex')
    expect(html).toContain('math-block')
    expect(html).not.toContain('$E=mc^2$')
  })

  it('keeps mathematical-looking text inside fenced code untouched', () => {
    const html = renderMarkdown('```tex\n$E=mc^2$\n```')
    expect(html).toContain('$E=mc^2$')
    expect(html).not.toContain('katex')
  })
})
