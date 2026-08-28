// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import App from '@/App.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Concept, KnowledgeUnit, Message, Session } from '@/types/domain'

const mounted: Array<ReturnType<typeof createApp>> = []
const now = '2026-08-29T00:00:00.000Z'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => undefined })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })
})

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount())
  document.body.innerHTML = ''
})

describe('reading excerpt Concept navigation', () => {
  it('opens the matching active topic in the knowledge topic catalog', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    store.init = async () => undefined
    store.sessions = [{
      id: 'session-1', source: 'local', platform: 'local', title: '来源会话', createdAt: now, updatedAt: now,
      messageCount: 1, unitCount: 1, knowledgeKind: 'knowledge', knowledgeRetainInGraph: true, revision: 1, localOnly: false,
    }] satisfies Session[]
    store.units = [{
      id: 'unit-1', sessionId: 'session-1', title: '网络片段', summary: '本地知识证据', orderInSession: 0,
      status: 'ready', revision: 1, createdAt: now, updatedAt: now,
    }] satisfies KnowledgeUnit[]
    store.messages = [{
      id: 'message-1', sessionId: 'session-1', unitId: 'unit-1', role: 'assistant',
      content: '进一步查看 [[nexus:existing:RoCE]]RoCE[[/nexus]]。', orderInSession: 0,
    }] satisfies Message[]
    store.concepts = [{
      id: 'concept-roce', name: 'RoCE', normalizedName: 'ROCE', summary: '远程直接内存访问网络', notes: '',
      status: 'active', createdAt: now, updatedAt: now,
    }] satisfies Concept[]

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    const unitsNav = [...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes('阅读片段'))!
    unitsNav.click()
    await nextTick()
    target.querySelector<HTMLButtonElement>('.unit-list-row')!.click()
    await nextTick()
    target.querySelector<HTMLElement>('[data-concept-id="concept-roce"]')!.click()
    await nextTick()

    expect(target.querySelector('.concepts-view')).not.toBeNull()
    expect(target.querySelector('.concept-detail h3')?.textContent).toBe('RoCE')
    expect(target.querySelector('.graph-view')).toBeNull()
  })
})
