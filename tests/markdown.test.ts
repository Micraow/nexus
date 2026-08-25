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

  it('renders fenced code blocks with escaped content', () => {
    const html = renderMarkdown('```js\nconst a = "<b>";\n```')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
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

  it('does not linkify concept names inside inline code', () => {
    const html = renderMarkdown('保持 `RDMA` 原样', { concepts: [{ id: 'c1', name: 'RDMA' }] })
    expect(html).toContain('<code>RDMA</code>')
    expect(html).not.toContain('data-concept-id')
  })
})
