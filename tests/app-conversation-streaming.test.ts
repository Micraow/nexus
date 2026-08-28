// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import App from '@/App.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { LLMTask, Message, NavTreeNode, Session } from '@/types/domain'

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

describe('conversation answer preview', () => {
  it('keeps a needs-review answer inside the current branch card', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    store.init = async () => undefined
    store.sessions = [{
      id: 'session-1',
      source: 'in_app',
      platform: 'local',
      title: '流式对话',
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      unitCount: 0,
      knowledgeKind: 'unknown',
      knowledgeRetainInGraph: false,
      revision: 1,
      localOnly: false,
    }] satisfies Session[]
    store.navNodes = [{ id: 'root-1', sessionId: 'session-1', parentId: null, label: '根问题', depth: 0, createdAt: now }] satisfies NavTreeNode[]
    store.messages = [{
      id: 'question-1',
      sessionId: 'session-1',
      role: 'user',
      content: '为什么需要检查？',
      orderInSession: 0,
      timestamp: now,
      metadata: { mode: 'new', parentNodeId: 'root-1', taskId: 'task-1' },
    }] satisfies Message[]
    store.tasks = [{
      id: 'task-1',
      type: 'conversation',
      mode: 'api',
      promptVersion: 'test',
      inputRevision: 'session-1:1',
      prompt: '{}',
      response: JSON.stringify({ answer: '这是已保留的待检查回答。' }),
      status: 'needs_review',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    }] satisfies LLMTask[]

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    target.querySelector<HTMLButtonElement>('.recent-row')!.click()
    await nextTick()

    const card = target.querySelector<HTMLElement>('.conversation-branch-card.current')!
    const retainedAnswer = card.querySelector<HTMLElement>('.streaming-message.needs-review-answer')
    expect(retainedAnswer?.textContent).toContain('待检查回答')
    expect(retainedAnswer?.textContent).toContain('这是已保留的待检查回答。')
    expect(target.querySelector('.conversation-scroll > .streaming-message')).toBeNull()
  })
})
