// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '@/stores/workspace'

const baseMessage = (role: 'user' | 'assistant', content: string, index: number) => ({
  role,
  content,
  timestamp: `2026-08-27T00:00:0${index}.000Z`,
})

function payload(messageCount = 2) {
  return {
    schema_version: 1,
    platform: 'deepseek',
    conversations: [{
      session_id: `direct-session-${messageCount}`,
      title: 'Direct Concept Extraction',
      messages: Array.from({ length: messageCount }, (_, index) => baseMessage(index % 2 ? 'assistant' : 'user', `message ${index} ${'context '.repeat(180)}`, index)),
    }],
  }
}

describe('direct concept extraction import pipeline', () => {
  let store: ReturnType<typeof useWorkspaceStore>

  beforeEach(async () => {
    setActivePinia(createPinia())
    store = useWorkspaceStore()
    await store.init()
    store.clearAllData()
  })

  afterEach(() => {
    store.clearAllData()
    vi.unstubAllGlobals()
  })

  it('creates triage and origin tasks without segmentation or KnowledgeUnits', () => {
    const report = store.importJsonText(JSON.stringify(payload()))
    const created = store.tasks.filter((task) => report.taskIds.includes(task.id))

    expect(created.map((task) => task.type).sort()).toEqual(['origin_concepts', 'session_triage'])
    expect(created.some((task) => task.type === 'segmentation')).toBe(false)
    expect(store.units).toHaveLength(0)
    expect(created.find((task) => task.type === 'origin_concepts')?.prompt).toContain('禁止返回 unit membership')
  })

  it('uses chunk message IDs as targets and keeps chunk concepts out of session/unit links', () => {
    store.updateConfig({ llm: { ...store.config.llm, tokenBudget: 1000 } })
    const report = store.importJsonText(JSON.stringify(payload(8)))
    const originTasks = store.tasks.filter((task) => report.taskIds.includes(task.id) && task.type === 'origin_concepts')
    expect(originTasks.length).toBeGreaterThan(1)

    const task = originTasks.find((item) => item.inputRevision.includes(':chunk:'))!
    const [, , , startText] = task.inputRevision.split(':')
    const targetMessage = store.messages.find((message) => message.orderInSession === Number(startText))!
    const invalid = store.applyTaskResult(task.id, JSON.stringify({
      concepts: [{ client_ref: 'new:1', name: '窗口概念', summary: '只由窗口内消息明确支撑。', aliases: [] }],
      memberships: [{ target_type: 'session', target_id: store.sessions[0].id, concept_ids: ['new:1'] }],
      relations: [],
    }))
    expect(invalid.ok).toBe(false)
    expect(invalid.errors.some((error) => error.includes('target_id'))).toBe(true)
    store.retryTask(task.id)
    store.refreshFromDb()
    const result = store.applyTaskResult(task.id, JSON.stringify({
      concepts: [{ client_ref: 'new:1', name: '窗口概念', summary: '只由窗口内消息明确支撑。', aliases: [] }],
      memberships: [{ target_type: 'message', target_id: targetMessage.id, concept_ids: ['new:1'] }],
      relations: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    const concept = store.concepts.find((item) => item.name === '窗口概念')!
    expect(store.messageConcepts).toContainEqual(expect.objectContaining({ messageId: targetMessage.id, conceptId: concept.id }))
    expect(store.sessionConcepts).not.toContainEqual(expect.objectContaining({ sessionId: store.sessions[0].id, conceptId: concept.id }))
    expect(store.units).toHaveLength(0)
  })

  it('retires legacy segmentation work instead of presenting it as pending', () => {
    const report = store.importJsonText(JSON.stringify(payload()))
    const session = store.sessions[0]
    const pendingBefore = store.pendingTaskCount
    const taskId = store.createTask({
      type: 'segmentation',
      mode: 'prompt_paste',
      providerId: null,
      model: null,
      promptVersion: 'legacy-test',
      inputRevision: `${session.id}:${session.revision}`,
      prompt: 'legacy segmentation',
      status: 'pending',
      scopeLabel: 'legacy segmentation',
    })
    store.refreshFromDb()
    expect(store.tasks.find((task) => task.id === taskId)).toMatchObject({ status: 'cancelled', errorMessage: expect.stringContaining('已停用') })
    expect(store.pendingTaskCount).toBe(pendingBefore)
    const result = store.applyTaskResult(taskId, JSON.stringify({
      units: [{ message_indices: [0, 1], title_hint: '旧知识单元' }],
      unassigned_message_indices: [],
    }))

    expect(report.taskIds).toHaveLength(2)
    expect(result.ok).toBe(false)
    expect(store.units).toHaveLength(0)
    store.retryTask(taskId)
    expect(store.tasks.find((task) => task.id === taskId)?.status).toBe('cancelled')

    const backup = JSON.parse(store.exportKnowledgeBase())
    backup.tasks.find((task: { id: string }) => task.id === taskId).status = 'pending'
    store.importKnowledgeBase(JSON.stringify(backup))
    expect(store.tasks.find((task) => task.id === taskId)?.status).toBe('cancelled')
  })

  it('records the selected topic on a new conversation before an answer exists', () => {
    const conceptId = store.createConcept('预选主题')
    const sessionId = store.createConversationTask({ question: '围绕这个主题继续探索', topicId: conceptId })
    const openingMessage = store.messages.find((message) => message.sessionId === sessionId)

    expect(openingMessage).toBeDefined()
    expect(store.sessionConcepts).toContainEqual(expect.objectContaining({ sessionId, conceptId }))
    expect(store.messageConcepts).toContainEqual(expect.objectContaining({ messageId: openingMessage!.id, conceptId }))
  })

  it('accepts a conversation answer without creating a KnowledgeUnit', () => {
    const sessionId = store.createConversationTask({ question: '只回答一个即时问题，不沉淀知识片段' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    store.refreshFromDb()

    const result = store.applyTaskResult(task.id, JSON.stringify({
      answer: '这是一次即时回答。',
      session_title: '即时问题讨论',
      session_summary: '本会话回答一个无需沉淀为知识单元的即时问题。',
      units: [],
      memberships: [],
      disclosure_requests: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    expect(store.units).toHaveLength(0)
    expect(store.sessions.find((session) => session.id === sessionId)).toMatchObject({ title: '即时问题讨论', summary: '本会话回答一个无需沉淀为知识单元的即时问题。' })
    const conversationMessages = store.messages.filter((message) => message.sessionId === sessionId)
    expect(conversationMessages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(conversationMessages[1].metadata).toMatchObject({ navNodeId: expect.any(String) })
  })

  it('treats an applied optional reading excerpt without a summary as ready', () => {
    const sessionId = store.createConversationTask({ question: '保留一段可复用的阅读证据' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    const result = store.applyTaskResult(task.id, JSON.stringify({
      answer: '回答正文',
      units: [{ title: '可选阅读片段', concept_ids: [], concepts: [] }],
      memberships: [],
      disclosure_requests: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    expect(store.units).toContainEqual(expect.objectContaining({ title: '可选阅读片段', summary: null, status: 'ready' }))
    expect(store.tasks.some((item) => item.type === 'unit_metadata' && item.status === 'pending')).toBe(false)
  })

  it('creates and reuses direct Message/Session Concepts without a KnowledgeUnit', () => {
    const existingConceptId = store.createConcept('已有网络主题')
    const sessionId = store.createConversationTask({ question: '解释一种新的网络拓扑' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    const question = store.messages.find((message) => message.sessionId === sessionId && message.role === 'user')!
    const answerMessageId = String(question.metadata?.answerMessageId)

    const result = store.applyTaskResult(task.id, JSON.stringify({
      answer: '这种拓扑复用了已有网络主题，并形成一个更具体的新主题。',
      session_title: '网络拓扑探索',
      session_summary: '讨论已有网络主题和一种新的具体拓扑。',
      concepts: [{ client_ref: 'new:1', name: '新型叶脊拓扑', summary: '一种更具体的网络拓扑主题。', aliases: ['叶脊拓扑'] }],
      memberships: [
        { target_type: 'message', target_id: answerMessageId, concept_ids: ['new:1', existingConceptId] },
        { target_type: 'session', target_id: sessionId, concept_ids: ['new:1', existingConceptId] },
      ],
      units: [],
      disclosure_requests: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    const created = store.concepts.find((concept) => concept.name === '新型叶脊拓扑')!
    const answer = store.messages.find((message) => message.id === answerMessageId)
    expect(answer?.role).toBe('assistant')
    expect(store.units).toHaveLength(0)
    expect(store.messageConcepts).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: answerMessageId, conceptId: created.id }),
      expect.objectContaining({ messageId: answerMessageId, conceptId: existingConceptId }),
    ]))
    expect(store.sessionConcepts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId, conceptId: created.id }),
      expect.objectContaining({ sessionId, conceptId: existingConceptId }),
    ]))
    expect(store.viewGraph().nodes.map((node) => node.refId)).toEqual(expect.arrayContaining([created.id, existingConceptId]))
  })

  it('persists conversation hierarchy and related proposals without cycles or duplicates', () => {
    const existingParentId = store.createConcept('网络协议')
    const sessionId = store.createConversationTask({ question: '解释 TCP 拥塞控制的层级关系' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    const question = store.messages.find((message) => message.sessionId === sessionId && message.role === 'user')!
    const answerMessageId = String(question.metadata?.answerMessageId)

    const result = store.applyTaskResult(task.id, JSON.stringify({
      answer: 'TCP 拥塞控制是传输控制协议下的具体主题，并与网络协议相关。',
      concepts: [
        { client_ref: 'new:1', name: '传输控制协议', summary: '传输层协议的控制机制。', aliases: [] },
        { client_ref: 'new:2', name: 'TCP 拥塞控制', summary: 'TCP 中调节发送速率的机制。', aliases: [] },
      ],
      memberships: [{ target_type: 'message', target_id: answerMessageId, concept_ids: ['new:1', 'new:2', existingParentId] }],
      relations: [
        { source: existingParentId, target: 'new:1', type: 'hierarchy', status: 'proposed' },
        { source: 'new:1', target: 'new:2', type: 'hierarchy' },
        { source: 'new:2', target: 'new:1', type: 'hierarchy' },
        { source: 'new:2', target: existingParentId, type: 'related' },
        { source: existingParentId, target: 'new:2', type: 'related' },
      ],
      units: [],
      disclosure_requests: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    const transport = store.concepts.find((concept) => concept.name === '传输控制协议')!
    const tcp = store.concepts.find((concept) => concept.name === 'TCP 拥塞控制')!
    expect(store.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentConceptId: existingParentId, childConceptId: transport.id, relationType: 'hierarchy', source: 'llm', status: 'proposed' }),
      expect.objectContaining({ parentConceptId: transport.id, childConceptId: tcp.id, relationType: 'hierarchy', source: 'llm', status: 'proposed' }),
      expect.objectContaining({ relationType: 'related', source: 'llm', status: 'proposed' }),
    ]))
    expect(store.relations.filter((relation) => relation.relationType === 'hierarchy' && relation.parentConceptId === tcp.id && relation.childConceptId === transport.id)).toHaveLength(0)
    expect(store.relations.filter((relation) => relation.relationType === 'related')).toHaveLength(1)
    expect(store.conceptParentIds(tcp.id, true)).toContain(transport.id)
  })

  it('does not replace an existing confirmed relation with a conversation proposal', () => {
    const parentId = store.createConcept('网络')
    const childId = store.createConcept('路由协议')
    const sessionId = store.createConversationTask({ question: '复用已有路由协议主题' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    const question = store.messages.find((message) => message.sessionId === sessionId && message.role === 'user')!
    const answerMessageId = String(question.metadata?.answerMessageId)
    // Both concepts were disclosed while they were roots. Add the confirmed
    // edge afterwards so the task still exercises the non-replacement guard.
    store.createRelation(parentId, childId, 'hierarchy')
    const result = store.applyTaskResult(task.id, JSON.stringify({
      answer: '路由协议属于网络主题。',
      concepts: [],
      memberships: [{ target_type: 'message', target_id: answerMessageId, concept_ids: [childId] }],
      relations: [{ source: parentId, target: childId, type: 'hierarchy', status: 'proposed' }],
      units: [],
      disclosure_requests: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    expect(store.relations.filter((relation) => relation.parentConceptId === parentId && relation.childConceptId === childId && relation.relationType === 'hierarchy')).toEqual([
      expect.objectContaining({ source: 'manual', status: 'confirmed' }),
    ])
  })

  it('rejects a new conversation Concept without direct Message evidence', () => {
    const sessionId = store.createConversationTask({ question: '测试无证据主题' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    const result = store.applyTaskResult(task.id, JSON.stringify({
      answer: '回答',
      concepts: [{ client_ref: 'new:1', name: '无消息证据主题', summary: '', aliases: [] }],
      memberships: [{ target_type: 'session', target_id: sessionId, concept_ids: ['new:1'] }],
      units: [],
      disclosure_requests: [],
    }))

    expect(result.ok).toBe(false)
    expect(result.errors.some((error) => error.includes('至少归属于一条 Message'))).toBe(true)
    expect(store.concepts.some((concept) => concept.name === '无消息证据主题')).toBe(false)
  })

  it('rejects unknown top-level conversation Concept IDs without writing an answer', () => {
    store.createConcept('已有主题')
    const sessionId = store.createConversationTask({ question: '验证归属' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    const result = store.applyTaskResult(task.id, JSON.stringify({ answer: '回答', units: [], concept_ids: ['missing'], memberships: [], disclosure_requests: [] }))

    expect(result.ok).toBe(false)
    expect(result.errors.some((error) => error.includes('Concept ID 不在当前目录中'))).toBe(true)
    expect(store.tasks.find((item) => item.id === task.id)?.status).toBe('needs_review')
    expect(store.messages.filter((message) => message.sessionId === sessionId)).toHaveLength(1)
  })

  it('keeps follow-up context and accurate message counts, and blocks duplicate application', () => {
    const sessionId = store.createConversationTask({ question: '第一轮问题' })
    const firstTask = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    expect(store.applyTaskResult(firstTask.id, JSON.stringify({ answer: '第一轮回答', units: [], memberships: [], disclosure_requests: [] })).ok).toBe(true)
    const sessionAfterFirst = store.sessions.find((session) => session.id === sessionId)!
    expect(sessionAfterFirst.messageCount).toBe(2)
    const root = store.navNodes.find((node) => node.sessionId === sessionId && !node.parentId)!
    const followUpTaskId = store.createFollowUpTask({ sessionId, parentNodeId: root.id, question: '第二轮问题' })
    const followUpTask = store.tasks.find((item) => item.id === followUpTaskId)!
    expect(followUpTask.prompt).toContain('第一轮回答')
    expect(followUpTask.prompt).toContain(root.label)
    expect(store.applyTaskResult(followUpTaskId, JSON.stringify({ answer: '第二轮回答', units: [], memberships: [], disclosure_requests: [] })).ok).toBe(true)
    expect(store.sessions.find((session) => session.id === sessionId)?.messageCount).toBe(4)
    const messageCount = store.messages.filter((message) => message.sessionId === sessionId).length
    const duplicate = store.applyTaskResult(followUpTaskId, JSON.stringify({ answer: '重复回答', units: [], memberships: [], disclosure_requests: [] }))
    expect(duplicate.ok).toBe(false)
    expect(store.messages.filter((message) => message.sessionId === sessionId)).toHaveLength(messageCount)
  })

  it('allows only one unfinished follow-up per Session', () => {
    const sessionId = store.createConversationTask({ question: '第一轮问题' })
    const initialTask = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    expect(store.applyTaskResult(initialTask.id, JSON.stringify({ answer: '第一轮回答', units: [], memberships: [], disclosure_requests: [] })).ok).toBe(true)
    const root = store.navNodes.find((node) => node.sessionId === sessionId && !node.parentId)!
    store.createFollowUpTask({ sessionId, parentNodeId: root.id, question: '第一次追问' })
    expect(() => store.createFollowUpTask({ sessionId, parentNodeId: root.id, question: '重复追问' })).toThrow('待完成')
  })

  it('does not issue duplicate API requests when queue and detail start the same task', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    store.updateConfig({
      llm: {
        ...store.config.llm,
        mode: 'api',
        defaultProvider: 'test-provider',
        providers: [{ id: 'test-provider', name: 'Test', baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: 'test-key' }],
      },
    })
    const sessionId = store.createConversationTask({ question: '测试重复 API 执行' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!

    const first = store.executeTask(task.id)
    await Promise.resolve()
    expect(store.tasks.find((item) => item.id === task.id)?.status).toBe('running')
    await expect(store.executeTask(task.id)).resolves.toEqual({ ok: false, error: '任务正在处理中' })

    resolveFetch?.({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: '唯一回答', units: [], disclosure_requests: [] }) } }] }),
    } as Response)
    await expect(first).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
