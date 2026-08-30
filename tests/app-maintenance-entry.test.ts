// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import App from '@/App.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Concept, ConceptRelation, LLMTask } from '@/types/domain'

const mounted: Array<ReturnType<typeof createApp>> = []

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

describe('full-graph maintenance entry', () => {
  it('uses one global entry and closes the panel when changing modules', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    useWorkspaceStore(pinia).init = async () => undefined
    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    const navButton = (label: string) => [...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes(label))

    navButton('知识主题')!.click()
    await nextTick()
    const entry = target.querySelector<HTMLButtonElement>('.topbar .maintenance-entry-button')
    expect(entry?.textContent).toContain('全图维护')

    entry!.click()
    await nextTick()
    expect(target.querySelector('.maintenance-panel')?.textContent).toContain('扫描整个知识图谱')
    expect(target.querySelector('.maintenance-panel')?.textContent).not.toContain('优先关注：')

    navButton('设置')!.click()
    await nextTick()
    expect(target.querySelector('.topbar .maintenance-entry-button')).not.toBeNull()
    expect(target.querySelector('.maintenance-panel')).toBeNull()
  })

  it('confirms every proposed relation in one action while retaining row actions beforehand', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    store.init = async () => undefined
    const now = '2026-08-29T00:00:00.000Z'
    store.concepts = [
      { id: 'root', name: '根主题', normalizedName: '根主题', notes: '', status: 'active', createdAt: now, updatedAt: now },
      { id: 'child', name: '子主题', normalizedName: '子主题', notes: '', status: 'active', createdAt: now, updatedAt: now },
    ] satisfies Concept[]
    store.relations = [
      { id: 'r1', parentConceptId: 'root', childConceptId: 'child', relationType: 'hierarchy', source: 'llm', status: 'proposed', createdAt: now, updatedAt: now },
      { id: 'r2', parentConceptId: 'root', childConceptId: 'child', relationType: 'related', source: 'maintenance', status: 'proposed', createdAt: now, updatedAt: now },
    ] satisfies ConceptRelation[]
    store.confirmRelation = (relationId, status) => {
      const relation = store.relations.find((item) => item.id === relationId)
      if (relation) relation.status = status
    }

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    const tasksNav = [...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes('任务中心'))!
    tasksNav.click()
    await nextTick()

    expect(target.querySelectorAll('.pending-relation-row')).toHaveLength(2)
    expect(target.querySelectorAll('.pending-relation-row .maintenance-relation-actions .text-button')).toHaveLength(4)
    const confirmAll = target.querySelector<HTMLButtonElement>('.confirm-all-relations')!
    expect(confirmAll.textContent).toContain('确认全部 2 条关系')

    confirmAll.click()
    await nextTick()
    expect(store.relations.every((relation) => relation.status === 'confirmed')).toBe(true)
    expect(target.querySelector('.pending-relation-inbox')).toBeNull()
  })

  it('keeps the maintenance panel open after creating a task from the global scope', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    store.init = async () => undefined
    const now = '2026-08-29T00:00:00.000Z'
    store.tasks = [{
      id: 'maintenance-1',
      type: 'maintenance',
      mode: 'prompt_paste',
      promptVersion: 'test',
      inputRevision: 'maintenance:state:focus',
      prompt: '{}',
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    }] satisfies LLMTask[]
    let maintenanceInput: Record<string, unknown> | undefined
    store.createMaintenanceTask = (input) => {
      maintenanceInput = input
      return 'maintenance-1'
    }

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    ;[...target.querySelectorAll<HTMLButtonElement>('.nav-item')].find((button) => button.textContent?.includes('知识主题'))?.click()
    await nextTick()
    target.querySelector<HTMLButtonElement>('.topbar .maintenance-entry-button')!.click()
    await nextTick()
    const instruction = target.querySelector<HTMLTextAreaElement>('#maintenance-instruction-input')!
    instruction.value = '重点检查重复主题并补建阅读片段'
    instruction.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    target.querySelector<HTMLButtonElement>('.maintenance-global-scope .primary-button')!.click()
    await nextTick()

    expect(target.querySelector('.tasks-view')).not.toBeNull()
    expect(target.querySelector('.maintenance-panel')).not.toBeNull()
    expect(maintenanceInput).toMatchObject({ userInstruction: '重点检查重复主题并补建阅读片段' })
  })

  it('does not project the previous disclosure response as the next-round draft', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    store.init = async () => undefined
    const now = '2026-08-29T00:00:00.000Z'
    store.tasks = [{
      id: 'maintenance-disclosure-1',
      type: 'maintenance',
      mode: 'prompt_paste',
      promptVersion: 'test',
      inputRevision: 'maintenance:state:focus',
      prompt: '{"DISCLOSURE_INDEX":{"roots":[]}}',
      status: 'pending',
      retryCount: 0,
      response: JSON.stringify({
        reason: '首轮需要展开根主题后再审计。',
        suggestions: [],
        disclosure_requests: [{ refID: 'root', depth: 1 }],
      }),
      parsedResult: null,
      createdAt: now,
      updatedAt: now,
    }] satisfies LLMTask[]

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    ;[...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes('任务中心'))?.click()
    await nextTick()
    target.querySelector<HTMLButtonElement>('.task-row')!.click()
    await nextTick()

    expect(target.querySelector<HTMLTextAreaElement>('#task-response')?.value).toBe('')
  })

  it('shows the intermediate maintenance reason without presenting it as a completed no-op', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    store.init = async () => undefined
    const now = '2026-08-29T00:00:00.000Z'
    store.tasks = [{
      id: 'maintenance-awaiting-disclosure',
      type: 'maintenance',
      mode: 'api',
      promptVersion: 'test',
      inputRevision: 'maintenance:state:full',
      prompt: '{}',
      status: 'pending',
      phase: 'awaiting_disclosure',
      retryCount: 0,
      response: JSON.stringify({ reason: '首轮需要展开根主题后再审计。', suggestions: [], disclosure_requests: [{ refID: 'root', depth: 1 }] }),
      parsedResult: null,
      createdAt: now,
      updatedAt: now,
    }] satisfies LLMTask[]

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()
    ;[...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes('任务中心'))?.click()
    await nextTick()
    target.querySelector<HTMLButtonElement>('.task-row')!.click()
    await nextTick()

    const results = target.querySelector('.maintenance-task-results')
    expect(results?.textContent).toContain('首轮需要展开根主题后再审计')
    expect(results?.textContent).toContain('等待继续披露')
    expect(results?.textContent).not.toContain('无建议变更')
  })

  it('continues an API maintenance task after a manually corrected disclosure request', async () => {
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    await store.init()
    store.clearAllData()
    const rootId = store.createConcept('页面续轮根主题')
    const childId = store.createConcept('页面续轮子主题')
    store.createRelation(rootId, childId, 'hierarchy')
    store.updateConfig({
      llm: {
        ...store.config.llm,
        mode: 'api',
        defaultProvider: 'maintenance-ui-provider',
        providers: [{ id: 'maintenance-ui-provider', name: 'Maintenance UI', baseUrl: 'https://example.test/v1', model: 'maintenance-model', apiKey: 'test-key' }],
      },
    })
    const responses = [
      JSON.stringify({ reason: '首轮请求未知引用', suggestions: [], disclosure_requests: [{ refID: 'unknown-ref', depth: 1 }] }),
      JSON.stringify({ reason: '已完成根主题审计，未发现需要修改的地方。', suggestions: [], disclosure_requests: [] }),
    ]
    let requestIndex = 0
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: responses[requestIndex++] } }] }),
    } as Response)))

    const taskId = store.createMaintenanceTask()
    await expect(store.executeTask(taskId)).resolves.toEqual({ ok: false, error: expect.stringContaining('不在当前目录') })
    expect(store.tasks.find((task) => task.id === taskId)?.status).toBe('needs_review')

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()
    ;[...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes('任务中心'))?.click()
    await nextTick()
    target.querySelector<HTMLButtonElement>('.task-row')!.click()
    await nextTick()

    const textarea = target.querySelector<HTMLTextAreaElement>('#task-response')!
    textarea.value = JSON.stringify({ reason: '修正后请求根主题展开', suggestions: [], disclosure_requests: [{ refID: rootId, depth: 64 }] })
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const applyButton = [...target.querySelectorAll<HTMLButtonElement>('.response-actions button')]
      .find((button) => button.textContent?.includes('校验并应用'))
    expect(applyButton).not.toBeUndefined()
    applyButton!.click()

    for (let attempt = 0; attempt < 10 && store.tasks.find((task) => task.id === taskId)?.status !== 'success'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
    expect(requestIndex).toBe(2)
    expect(store.tasks.find((task) => task.id === taskId)?.status).toBe('success')
    expect(store.tasks.find((task) => task.id === taskId)?.parsedResult).toContain('未发现需要修改')
    store.clearAllData()
  })

  it.each([
    ['pending', false],
    ['running', false],
    ['needs_review', true],
  ] as const)('only shows apply action for API tasks that need review (%s)', async (status, showsApplyAction) => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    const store = useWorkspaceStore(pinia)
    store.init = async () => undefined
    const now = '2026-08-29T00:00:00.000Z'
    store.tasks = [{
      id: `maintenance-api-${status}`,
      type: 'maintenance',
      mode: 'api',
      promptVersion: 'test',
      inputRevision: 'maintenance:state:full',
      prompt: '{}',
      status,
      retryCount: 0,
      response: status === 'needs_review' ? '{"suggestions":[]}' : undefined,
      parsedResult: null,
      createdAt: now,
      updatedAt: now,
    }] satisfies LLMTask[]

    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    ;[...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes('任务中心'))?.click()
    await nextTick()
    target.querySelector<HTMLButtonElement>('.task-row')!.click()
    await nextTick()

    const applyButtons = [...target.querySelectorAll<HTMLButtonElement>('.response-actions button')]
      .filter((button) => button.textContent?.includes('校验并应用'))
    expect(applyButtons).toHaveLength(showsApplyAction ? 1 : 0)
  })
})
