// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import ReadingUnitsView from '@/components/ReadingUnitsView.vue'
import type { KnowledgeUnit, Message, Session } from '@/types/domain'

const session = (id: string, title: string): Session => ({
  id,
  source: 'local',
  platform: 'local',
  title,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  messageCount: 2,
  unitCount: 1,
  knowledgeKind: 'knowledge',
  knowledgeRetainInGraph: true,
  revision: 1,
  localOnly: false,
})

const unit = (id: string, sessionId: string, title: string, createdAt: string, updatedAt: string): KnowledgeUnit => ({
  id,
  sessionId,
  title,
  summary: `**${title}摘要**`,
  orderInSession: 0,
  status: 'ready',
  revision: 1,
  createdAt,
  updatedAt,
})

const sessions = [session('s1', '## [[nexus:existing:会话甲]]会话甲[[/nexus]]')]
const units = [
  unit('older', 's1', '## 旧片段', '2026-08-26T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
  unit('newer', 's1', '[[nexus:suggested:新片段]]新片段[[/nexus]]', '2026-08-28T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
]
const messages: Message[] = [{ id: 'm1', sessionId: 's1', unitId: 'newer', role: 'assistant', content: '**完整回答**', orderInSession: 1 }]
const mounted: Array<ReturnType<typeof createApp>> = []

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount())
  document.body.innerHTML = ''
})

async function mountView(selectedUnitId: string | null = 'newer'): Promise<HTMLElement> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = createApp(ReadingUnitsView, { units, sessions, messages, selectedUnitId })
  mounted.push(app)
  app.mount(target)
  await nextTick()
  return target
}

describe('ReadingUnitsView', () => {
  it('starts with the most recently updated excerpt and renders the complete selected transcript', async () => {
    const target = await mountView()
    expect([...target.querySelectorAll('.unit-list-row strong')].map((item) => item.textContent)).toEqual(['新片段', '旧片段'])
    expect(target.querySelector('.unit-detail h3')?.textContent).toBe('新片段')
    expect(target.querySelector('.unit-detail .md-body')?.innerHTML).toContain('<strong>完整回答</strong>')
    expect(target.textContent).not.toContain('[[nexus:')
    expect(target.textContent).not.toContain('**新片段摘要**')
  })

  it('supports chronological and title sorting plus cleaned-text search', async () => {
    const target = await mountView(null)
    const sort = target.querySelector<HTMLSelectElement>('[aria-label="阅读片段排序方式"]')!
    sort.value = 'updated_asc'
    sort.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect([...target.querySelectorAll('.unit-list-row strong')].map((item) => item.textContent)).toEqual(['旧片段', '新片段'])

    sort.value = 'title'
    sort.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect([...target.querySelectorAll('.unit-list-row strong')].map((item) => item.textContent)).toEqual(['旧片段', '新片段'])

    const search = target.querySelector<HTMLInputElement>('[aria-label="搜索阅读片段"]')!
    search.value = '会话甲'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(target.querySelectorAll('.unit-list-row')).toHaveLength(2)
    search.value = '新片段'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect([...target.querySelectorAll('.unit-list-row strong')].map((item) => item.textContent)).toEqual(['新片段'])
  })
})
