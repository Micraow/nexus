// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import App from '@/App.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Concept, LLMTask, Message, NavTreeNode, Session } from '@/types/domain'

const mounted: Array<ReturnType<typeof createApp>> = []
const now = '2026-08-29T00:00:00.000Z'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
  HTMLElement.prototype.scrollIntoView = () => undefined
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
    store.concepts = [{
      id: 'known-topic',
      name: 'RoCE',
      normalizedName: 'ROCE',
      summary: '',
      notes: '',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }] satisfies Concept[]
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
      response: JSON.stringify({ answer: '已知 [[nexus:existing:RoCE]]RoCE[[/nexus]]，未知 [[nexus:existing:幽灵主题]]幽灵主题[[/nexus]]，建议 [[nexus:suggested:ECN]]ECN[[/nexus]]。' }),
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
    expect(retainedAnswer?.querySelector('[data-concept-id="known-topic"]')?.textContent).toBe('RoCE')
    expect(retainedAnswer?.querySelector('[data-suggested-concept="ECN"]')?.textContent).toBe('ECN')
    expect(retainedAnswer?.textContent).toContain('幽灵主题')
    expect(retainedAnswer?.querySelector('[data-concept-id="幽灵主题"]')).toBeNull()
    expect(target.querySelector('.conversation-scroll > .streaming-message')).toBeNull()
  })

  it('keeps a suggested-topic follow-up on its new branch card after applying the answer', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    await store.init()
    store.updateConfig({ llm: { ...store.config.llm, mode: 'prompt_paste' } })

    const sessionId = store.createConversationTask({ question: '首轮问题' })
    const openingTask = store.tasks.find((task) => task.type === 'conversation' && task.inputRevision.startsWith(`${sessionId}:`))!
    const openingQuestion = store.messages.find((message) => message.metadata?.taskId === openingTask.id)!
    const openingAnswerId = openingQuestion.metadata?.answerMessageId as string
    const openingResult = store.applyTaskResult(openingTask.id, JSON.stringify({
      // The provider incorrectly calls its response-local Concept existing.
      // The UI must keep it yellow/explorable instead of immediately blue.
      answer: '可以继续研究 [[nexus:existing:调度器]]调度器[[/nexus]]，调度器还有更多细节。',
      concepts: [{ client_ref: 'new:1', name: '调度器', summary: '组织系统中的任务更新。', aliases: [] }],
      units: [{ title: '首轮片段', summary: '首轮回答证据。', concept_ids: [], concepts: [] }],
      memberships: [{ target_type: 'message', target_id: openingAnswerId, concept_ids: ['new:1'] }],
      relations: [],
      disclosure_requests: [],
    }))
    expect(openingResult.ok, openingResult.errors.join('; ')).toBe(true)

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    ;[...target.querySelectorAll<HTMLButtonElement>('.nav-item')].find((button) => button.textContent?.includes('会话'))?.click()
    await nextTick()
    target.querySelector<HTMLButtonElement>('.session-row')!.click()
    await nextTick()

    const suggested = target.querySelector<HTMLElement>('[data-suggested-concept="调度器"]')
    expect(suggested).not.toBeNull()
    suggested!.click()
    await nextTick()
    expect(target.querySelector('.conversation-branch-card.current strong')?.textContent).toBe('调度器')

    const composer = target.querySelector<HTMLTextAreaElement>('[aria-label="继续当前对话"]')!
    composer.value = '请解释调度器'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    target.querySelector<HTMLButtonElement>('[aria-label="发送追问"]')!.click()
    await nextTick()

    // The temporary recommendation branch owns the in-flight task. Selecting
    // its parent while the Prompt/API result is pending must not move the
    // stream back onto the root card.
    const rootNode = target.querySelector<SVGGElement>('[data-node-id^="nav_"]')
    rootNode?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(target.querySelector('.conversation-branch-card.current strong')?.textContent).toBe('调度器')

    const followUpTask = store.tasks
      .filter((task) => task.type === 'conversation' && task.inputRevision.startsWith(`${sessionId}:`))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    expect(followUpTask).toBeDefined()
    const taskResponse = JSON.stringify({
      answer: '调度器负责组织更新。',
      units: [{ unit_id: store.units.find((unit) => unit.sessionId === sessionId)?.id }],
      memberships: [],
      disclosure_requests: [],
    })
    const responseInput = target.querySelector<HTMLTextAreaElement>('.prompt-workflow-response textarea')!
    responseInput.value = taskResponse
    responseInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    target.querySelector<HTMLButtonElement>('.prompt-workflow-footer .primary-button')!.click()
    await nextTick()

    const branchNodes = store.navNodes.filter((node) => node.sessionId === sessionId)
    expect(branchNodes).toHaveLength(2)
    const answer = store.messages.find((message) => message.role === 'assistant' && message.metadata?.taskId === followUpTask.id)
    expect(answer).toBeDefined()
    expect(target.querySelector('.conversation-tree-node.is-current')?.getAttribute('data-node-id')).toBe(answer?.metadata?.navNodeId)
    expect(target.querySelector('.branch-card-close')).toBeNull()
  })
})
