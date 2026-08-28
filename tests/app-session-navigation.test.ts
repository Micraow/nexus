// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import App from '@/App.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Message, NavTreeNode, Session } from '@/types/domain'

const mounted: Array<ReturnType<typeof createApp>> = []
const now = '2026-08-29T00:00:00.000Z'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
})

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount())
  document.body.innerHTML = ''
})

describe('session archive navigation', () => {
  it('keeps the archive compact and restores the exploration tree in the conversation view', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    store.init = async () => undefined
    store.sessions = [{
      id: 'session-1',
      source: 'in_app',
      platform: 'local',
      title: '可继续的会话',
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      unitCount: 0,
      knowledgeKind: 'unknown',
      knowledgeRetainInGraph: false,
      revision: 1,
      localOnly: false,
    }] satisfies Session[]
    store.navNodes = [{ id: 'root-1', sessionId: 'session-1', parentId: null, label: '原探索起点', depth: 0, createdAt: now }] satisfies NavTreeNode[]
    store.messages = [{ id: 'message-1', sessionId: 'session-1', role: 'user', content: '继续之前的问题', orderInSession: 0, timestamp: now, metadata: { parentNodeId: 'root-1' } }] satisfies Message[]

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    const sessionsNav = [...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes('会话'))!
    sessionsNav.click()
    await nextTick()

    target.querySelector<HTMLButtonElement>('[aria-label="展开会话摘要"]')!.click()
    await nextTick()
    expect(target.querySelector('.session-expanded')).not.toBeNull()
    expect(target.querySelector('.session-tree-overview')).toBeNull()

    target.querySelector<HTMLButtonElement>('.session-row')!.click()
    await nextTick()
    expect(target.querySelector('.new-chat-panel.conversation-mode')?.textContent).toContain('可继续的会话')
    expect(target.querySelector('.conversation-tree-map [data-node-id="root-1"]')).not.toBeNull()
    expect(target.querySelector<HTMLTextAreaElement>('[aria-label="继续当前对话"]')).not.toBeNull()
  })
})
