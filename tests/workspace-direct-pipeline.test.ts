// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '@/stores/workspace'
import type { GraphSnapshot } from '@/types/domain'

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

  it('creates triage first and defers origin tasks until the session is classified as knowledge', () => {
    const report = store.importJsonText(JSON.stringify(payload()))
    const created = store.tasks.filter((task) => report.taskIds.includes(task.id))

    expect(created.map((task) => task.type).sort()).toEqual(['session_triage'])
    expect(created.some((task) => task.type === 'segmentation')).toBe(false)
    expect(store.units).toHaveLength(0)

    const triage = created[0]
    const result = store.applyTaskResult(triage.id, JSON.stringify({
      kind: 'knowledge',
      confidence: 0.95,
      reason: '包含可沉淀的技术知识。',
      retain_in_graph: true,
    }))
    expect(result.ok, result.errors.join('; ')).toBe(true)
    const originTasks = store.tasks.filter((task) => task.type === 'origin_concepts' && task.inputRevision.startsWith(`${report.importedSessionIds[0]}:`))
    expect(originTasks).toHaveLength(1)
    expect(originTasks[0].prompt).toContain('禁止返回 unit membership')
  })

  it('does not create origin tasks for imported sessions classified as non-knowledge', () => {
    const report = store.importJsonText(JSON.stringify(payload()))
    const triage = store.tasks.find((task) => report.taskIds.includes(task.id) && task.type === 'session_triage')!
    const result = store.applyTaskResult(triage.id, JSON.stringify({
      kind: 'discussion',
      confidence: 0.9,
      reason: '这是缺少可复用结论的讨论。',
      retain_in_graph: false,
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    expect(store.tasks.some((task) => task.type === 'origin_concepts' && task.inputRevision.startsWith(`${report.importedSessionIds[0]}:`))).toBe(false)
  })

  it('keeps imported root-card messages in context when the session is continued', () => {
    const report = store.importJsonText(JSON.stringify(payload()))
    const session = store.sessions.find((item) => report.importedSessionIds.includes(item.id))!
    const root = store.navNodes.find((node) => node.sessionId === session.id && !node.parentId)!
    const taskId = store.createFollowUpTask({
      sessionId: session.id,
      parentNodeId: root.id,
      question: '请在导入内容基础上继续说明',
    })
    const task = store.tasks.find((item) => item.id === taskId)!

    expect(task.prompt).toContain('message 0')
    expect(task.prompt).toContain('message 1')
    expect(task.prompt).toContain('请在导入内容基础上继续说明')
  })

  it('uses chunk message IDs as targets and keeps chunk concepts out of session/unit links', () => {
    store.updateConfig({ llm: { ...store.config.llm, tokenBudget: 1000 } })
    const report = store.importJsonText(JSON.stringify(payload(8)))
    const triage = store.tasks.find((task) => report.taskIds.includes(task.id) && task.type === 'session_triage')!
    const triageResult = store.applyTaskResult(triage.id, JSON.stringify({ kind: 'knowledge', confidence: 1, reason: '知识密集型会话。', retain_in_graph: true }))
    expect(triageResult.ok, triageResult.errors.join('; ')).toBe(true)
    const originTasks = store.tasks.filter((task) => task.type === 'origin_concepts' && task.inputRevision.startsWith(`${report.importedSessionIds[0]}:`))
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

    expect(report.taskIds).toHaveLength(1)
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

  it('keeps the store graph roots-only until each hierarchy level is opened', () => {
    const rootId = store.createConcept('图谱根主题')
    const childId = store.createConcept('图谱子主题')
    const grandchildId = store.createConcept('图谱孙主题')
    store.createRelation(rootId, childId, 'hierarchy')
    store.createRelation(childId, grandchildId, 'hierarchy')

    const rootsOnly = store.viewGraph()
    expect(rootsOnly.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual([rootId])

    const firstLevel = store.viewGraph({ expandedConceptIds: [rootId] })
    expect(firstLevel.nodes.filter((node) => node.type === 'concept').map((node) => node.refId).sort()).toEqual([childId, rootId].sort())
    expect(firstLevel.nodes.some((node) => node.refId === grandchildId)).toBe(false)

    const secondLevel = store.viewGraph({ expandedConceptIds: [rootId, childId] })
    expect(secondLevel.nodes.filter((node) => node.type === 'concept').map((node) => node.refId).sort()).toEqual([childId, grandchildId, rootId].sort())
  })

  it('sanitizes an over-disclosed Worker snapshot before the initial graph render', () => {
    const rootId = store.createConcept('Worker 根主题')
    const childId = store.createConcept('Worker 越级子主题')
    store.createRelation(rootId, childId, 'hierarchy')

    class LeakingWorker {
      onmessage: ((event: MessageEvent<{ key: string; snapshot: GraphSnapshot }>) => void) | null = null

      postMessage(request: { key: string; revision: number }): void {
        const leaked: GraphSnapshot = {
          nodes: [
            { id: `concept:${rootId}`, type: 'concept', refId: rootId, label: 'Worker 根主题', subtitle: 'Concept', degree: 1, unitCount: 0, depth: 0, parentIds: [], rootIds: [rootId], hasChildren: true, expanded: false },
            { id: `concept:${childId}`, type: 'concept', refId: childId, label: 'Worker 越级子主题', subtitle: 'Concept', degree: 1, unitCount: 0, depth: 1, parentIds: [rootId], rootIds: [rootId], hasChildren: false, expanded: false },
          ],
          edges: [{ id: 'edge:hierarchy:leak', source: `concept:${rootId}`, target: `concept:${childId}`, type: 'hierarchy', weight: 1, status: 'confirmed' }],
          revision: request.revision,
        }
        this.onmessage?.({ data: { key: request.key, snapshot: leaked } } as MessageEvent<{ key: string; snapshot: GraphSnapshot }>)
      }
    }
    vi.stubGlobal('Worker', LeakingWorker)

    const initial = store.viewGraph()
    expect(initial.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual([rootId])
  })

  it('rejects a Worker snapshot that mislabels a non-root as an isolated depth-zero node', () => {
    const rootId = store.createConcept('规范根主题')
    const childId = store.createConcept('错误深度子主题')
    store.createRelation(rootId, childId, 'hierarchy')

    class IsolatedChildWorker {
      onmessage: ((event: MessageEvent<{ key: string; snapshot: GraphSnapshot }>) => void) | null = null

      postMessage(request: { key: string; revision: number }): void {
        const leaked: GraphSnapshot = {
          nodes: [{ id: `concept:${childId}`, type: 'concept', refId: childId, label: '错误深度子主题', subtitle: 'Concept', degree: 0, unitCount: 0, depth: 0, parentIds: [], rootIds: [childId], hasChildren: false, expanded: false }],
          edges: [],
          revision: request.revision,
        }
        this.onmessage?.({ data: { key: request.key, snapshot: leaked } } as MessageEvent<{ key: string; snapshot: GraphSnapshot }>)
      }
    }
    vi.stubGlobal('Worker', IsolatedChildWorker)

    const initial = store.viewGraph()
    expect(initial.nodes.filter((node) => node.type === 'concept').map((node) => node.refId)).toEqual([rootId])
  })

  it('requires the first conversation answer to create a KnowledgeUnit', () => {
    const sessionId = store.createConversationTask({ question: '只回答一个即时问题，不沉淀知识片段' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    store.refreshFromDb()

    const result = store.applyTaskResult(task.id, JSON.stringify({
      answer: '这是一次即时回答。',
      session_title: '即时问题讨论',
      session_summary: '本会话回答一个无需沉淀为知识单元的即时问题。',
      units: [{ title: '即时问题片段', summary: '本轮即时回答的可复用证据。', concept_ids: [], concepts: [] }],
      memberships: [],
      disclosure_requests: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    expect(store.units).toHaveLength(1)
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
      units: [{ title: '网络拓扑片段', summary: '讨论网络拓扑和主题归属。', concept_ids: [], concepts: [] }],
      disclosure_requests: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    const created = store.concepts.find((concept) => concept.name === '新型叶脊拓扑')!
    const answer = store.messages.find((message) => message.id === answerMessageId)
    expect(answer?.role).toBe('assistant')
    expect(store.units).toHaveLength(1)
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

  it('persists conversation hierarchy and rejects model-authored related proposals', () => {
    const existingParentId = store.createConcept('网络协议')
    const sessionId = store.createConversationTask({ question: '解释 TCP 拥塞控制的层级关系' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    const question = store.messages.find((message) => message.sessionId === sessionId && message.role === 'user')!
    const answerMessageId = String(question.metadata?.answerMessageId)

    const invalid = store.applyTaskResult(task.id, JSON.stringify({
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
      units: [{ title: '传输控制片段', summary: '记录传输控制协议层级关系。', concept_ids: [], concepts: [] }],
      disclosure_requests: [],
    }))

    expect(invalid.ok).toBe(false)
    expect(invalid.errors.join('; ')).toContain('related 由共享 Session/Message 自动计算')
    store.retryTask(task.id)
    const result = store.applyTaskResult(task.id, JSON.stringify({
      answer: 'TCP 拥塞控制是传输控制协议下的具体主题。',
      concepts: [
        { client_ref: 'new:1', name: '传输控制协议', summary: '传输层协议的控制机制。', aliases: [] },
        { client_ref: 'new:2', name: 'TCP 拥塞控制', summary: 'TCP 中调节发送速率的机制。', aliases: [] },
      ],
      memberships: [{ target_type: 'message', target_id: answerMessageId, concept_ids: ['new:1', 'new:2', existingParentId] }],
      relations: [
        { source: existingParentId, target: 'new:1', type: 'hierarchy', status: 'proposed' },
        { source: 'new:1', target: 'new:2', type: 'hierarchy' },
      ],
      units: [{ title: '路由协议片段', summary: '记录路由协议主题。', concept_ids: [], concepts: [] }],
      disclosure_requests: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    const transport = store.concepts.find((concept) => concept.name === '传输控制协议')!
    const tcp = store.concepts.find((concept) => concept.name === 'TCP 拥塞控制')!
    expect(store.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentConceptId: existingParentId, childConceptId: transport.id, relationType: 'hierarchy', source: 'llm', status: 'proposed' }),
      expect.objectContaining({ parentConceptId: transport.id, childConceptId: tcp.id, relationType: 'hierarchy', source: 'llm', status: 'proposed' }),
    ]))
    expect(store.relations.filter((relation) => relation.relationType === 'hierarchy' && relation.parentConceptId === tcp.id && relation.childConceptId === transport.id)).toHaveLength(0)
    expect(store.relations.filter((relation) => relation.relationType === 'related')).toHaveLength(0)
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
      units: [{ title: '无证据片段', summary: '用于校验主题证据规则。', concept_ids: [], concepts: [] }],
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
      units: [{ title: '未知 ID 片段', summary: '用于校验未知主题 ID。', concept_ids: [], concepts: [] }],
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
    const result = store.applyTaskResult(task.id, JSON.stringify({ answer: '回答', units: [{ title: '未知 ID 片段', summary: '用于校验未知主题 ID。', concept_ids: [], concepts: [] }], concept_ids: ['missing'], memberships: [], disclosure_requests: [] }))

    expect(result.ok).toBe(false)
    expect(result.errors.some((error) => error.includes('Concept ID 不在当前目录中'))).toBe(true)
    expect(store.tasks.find((item) => item.id === task.id)?.status).toBe('needs_review')
    expect(store.messages.filter((message) => message.sessionId === sessionId)).toHaveLength(1)
  })

  it('keeps follow-up context and accurate message counts, and blocks duplicate application', () => {
    const sessionId = store.createConversationTask({ question: '第一轮问题' })
    const firstTask = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    expect(store.applyTaskResult(firstTask.id, JSON.stringify({ answer: '第一轮回答', units: [{ title: '第一轮片段', summary: '第一轮回答证据。', concept_ids: [], concepts: [] }], memberships: [], disclosure_requests: [] })).ok).toBe(true)
    const sessionAfterFirst = store.sessions.find((session) => session.id === sessionId)!
    expect(sessionAfterFirst.messageCount).toBe(2)
    const root = store.navNodes.find((node) => node.sessionId === sessionId && !node.parentId)!
    const followUpTaskId = store.createFollowUpTask({ sessionId, parentNodeId: root.id, question: '第二轮问题' })
    const followUpTask = store.tasks.find((item) => item.id === followUpTaskId)!
    expect(followUpTask.prompt).toContain('第一轮回答')
    expect(followUpTask.prompt).toContain(root.label)
    expect(store.applyTaskResult(followUpTaskId, JSON.stringify({ answer: '第二轮回答', units: [{ unit_id: store.units[0].id }], memberships: [], disclosure_requests: [] })).ok).toBe(true)
    expect(store.sessions.find((session) => session.id === sessionId)?.messageCount).toBe(4)
    const messageCount = store.messages.filter((message) => message.sessionId === sessionId).length
    const duplicate = store.applyTaskResult(followUpTaskId, JSON.stringify({ answer: '重复回答', units: [{ unit_id: store.units[0].id }], memberships: [], disclosure_requests: [] }))
    expect(duplicate.ok).toBe(false)
    expect(store.messages.filter((message) => message.sessionId === sessionId)).toHaveLength(messageCount)
  })

  it('discloses the Concept paths already visited by the current Session to follow-ups', () => {
    const sessionId = store.createConversationTask({ question: '解释响应式系统和调度器' })
    const firstTask = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    const question = store.messages.find((message) => message.sessionId === sessionId && message.role === 'user')!
    const first = store.applyTaskResult(firstTask.id, JSON.stringify({
      answer: '响应式系统包含调度器。',
      concepts: [
        { client_ref: 'new:1', name: '响应式系统', summary: '状态依赖追踪。', aliases: [] },
        { client_ref: 'new:2', name: '调度器', summary: '更新批处理。', aliases: [] },
      ],
      memberships: [{ target_type: 'message', target_id: question.id, concept_ids: ['new:1', 'new:2'] }],
      relations: [{ source: 'new:1', target: 'new:2', type: 'hierarchy', status: 'proposed' }],
      units: [{ title: '响应式系统概览', summary: '响应式系统及其调度器。', concept_ids: [], concepts: [] }],
      disclosure_requests: [],
    }))
    expect(first.ok, first.errors.join('; ')).toBe(true)
    const root = store.navNodes.find((node) => node.sessionId === sessionId && !node.parentId)!
    const followUpTaskId = store.createFollowUpTask({ sessionId, parentNodeId: root.id, question: '继续解释调度器' })
    const prompt = store.tasks.find((item) => item.id === followUpTaskId)!.prompt
    const scheduler = store.concepts.find((concept) => concept.name === '调度器')!
    expect(prompt).toContain(scheduler.id)
    expect(prompt).toContain('知识主题：调度器')
  })

  it('allows only one unfinished follow-up per Session', () => {
    const sessionId = store.createConversationTask({ question: '第一轮问题' })
    const initialTask = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    expect(store.applyTaskResult(initialTask.id, JSON.stringify({ answer: '第一轮回答', units: [{ title: '第一轮片段', summary: '第一轮回答证据。', concept_ids: [], concepts: [] }], memberships: [], disclosure_requests: [] })).ok).toBe(true)
    const root = store.navNodes.find((node) => node.sessionId === sessionId && !node.parentId)!
    store.createFollowUpTask({ sessionId, parentNodeId: root.id, question: '第一次追问' })
    expect(() => store.createFollowUpTask({ sessionId, parentNodeId: root.id, question: '重复追问' })).toThrow('待完成')
  })

  it('creates graph-wide maintenance prompts even when a focus scope is supplied', () => {
    const rootId = store.createConcept('全库根主题')
    const otherId = store.createConcept('未选中的主题')
    store.createRelation(rootId, otherId, 'hierarchy')
    const taskId = store.createMaintenanceTask({ conceptIds: [otherId] })
    const task = store.tasks.find((item) => item.id === taskId)!
    expect(task.scopeLabel).toContain('全库知识图谱')
    expect(task.prompt).toContain(rootId)
    expect(task.prompt).toContain(otherId)
    expect(task.prompt).toContain('一级主题及直接子主题引用')
    expect(task.prompt).toContain('用户附加关注范围')
  })

  it('preserves an overall maintenance reason when suggestions are empty', () => {
    store.createConcept('无需修改主题')
    const taskId = store.createMaintenanceTask()
    const task = store.tasks.find((item) => item.id === taskId)!
    const result = store.applyTaskResult(task.id, JSON.stringify({ suggestions: [], disclosure_requests: [] }))
    expect(result.ok, result.errors.join('; ')).toBe(true)
    const parsed = JSON.parse(store.tasks.find((item) => item.id === taskId)?.parsedResult ?? '{}') as { reason?: string; suggestions?: unknown[] }
    expect(parsed.suggestions).toEqual([])
    expect(parsed.reason).toBe('模型检查后未发现需要修改的地方。')
  })

  it('marks maintenance output stale when its message catalog changed', () => {
    store.createConcept('维护版本主题')
    const taskId = store.createMaintenanceTask()
    store.createConversationTask({ question: '这条新消息不在旧维护目录中' })

    const result = store.applyTaskResult(taskId, JSON.stringify({
      reason: '旧目录无需修改',
      suggestions: [],
      disclosure_requests: [],
    }))

    expect(result.ok).toBe(false)
    expect(result.errors.join('; ')).toContain('可选消息目录已更新')
    expect(store.tasks.find((task) => task.id === taskId)).toMatchObject({ status: 'stale' })
  })

  it('lets graph maintenance create a reading unit from unassigned messages', () => {
    const report = store.importJsonText(JSON.stringify(payload()))
    const sessionId = store.sessions[0].id
    const messages = store.messages.filter((message) => message.sessionId === sessionId)
    expect(report.taskIds.length).toBeGreaterThan(0)
    expect(messages.every((message) => !message.unitId)).toBe(true)
    const maintenanceId = store.createMaintenanceTask()
    const maintenance = store.tasks.find((item) => item.id === maintenanceId)!
    const result = store.applyTaskResult(maintenance.id, JSON.stringify({
      reason: '两条消息构成连续解释，形成可复用片段',
      suggestions: [{ type: 'unit_create', session_id: sessionId, message_ids: messages.map((message) => message.id), title: '连续解释', summary: '可复用的说明', reason: '消息内容连续且具备独立阅读价值', concept_ids: [] }],
      disclosure_requests: [],
    }))
    expect(result.ok, result.errors.join('; ')).toBe(true)
    expect(store.applyMaintenanceSuggestion(maintenanceId, 0).ok).toBe(true)
    const unit = store.units.find((item) => item.sessionId === sessionId && item.title === '连续解释')
    expect(unit).toBeTruthy()
    expect(store.messages.filter((message) => message.unitId === unit?.id)).toHaveLength(messages.length)
  })

  it('accepts conversation hierarchy suggestions and stores them as proposed edges', () => {
    const parentId = store.createConcept('网络基础')
    const sessionId = store.createConversationTask({ question: '解释一个更具体的网络主题' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    const question = store.messages.find((message) => message.sessionId === sessionId && message.role === 'user')!
    const answerMessageId = String(question.metadata?.answerMessageId)
    const result = store.applyTaskResult(task.id, JSON.stringify({
      answer: '这是一个更具体的主题。',
      concepts: [{ client_ref: 'new:1', name: '具体网络主题', summary: '网络基础下的具体主题。', aliases: [] }],
      memberships: [{ target_type: 'message', target_id: answerMessageId, concept_ids: ['new:1'] }],
      relations: [{ source: parentId, target: 'new:1', type: 'hierarchy' }],
      units: [{ title: '网络层级片段', summary: '记录网络主题的层级建议。', concept_ids: [], concepts: [] }],
      disclosure_requests: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    const child = store.concepts.find((concept) => concept.name === '具体网络主题')!
    expect(store.relations).toContainEqual(expect.objectContaining({
      parentConceptId: parentId,
      childConceptId: child.id,
      relationType: 'hierarchy',
      status: 'proposed',
    }))
  })

  it('applies graph maintenance Concept creation with a proposed parent edge', () => {
    const parentId = store.createConcept('维护父主题')
    const taskId = store.createMaintenanceTask()
    const task = store.tasks.find((item) => item.id === taskId)!
    const result = store.applyTaskResult(task.id, JSON.stringify({
      suggestions: [{ type: 'create_concept', name: '维护子主题', summary: '更具体的知识主题', parent_concept_id: parentId, reason: '语义范围更窄' }],
      disclosure_requests: [],
    }))

    expect(result.ok, result.errors.join('; ')).toBe(true)
    const applied = store.applyMaintenanceSuggestion(taskId, 0)
    expect(applied.ok, applied.error).toBe(true)
    const child = store.concepts.find((concept) => concept.name === '维护子主题')!
    expect(store.relations).toContainEqual(expect.objectContaining({ parentConceptId: parentId, childConceptId: child.id, relationType: 'hierarchy', status: 'proposed' }))
  })

  it('creates aliases and multiple proposed hierarchy parents atomically', () => {
    const parentA = store.createConcept('原子父主题 A')
    const parentB = store.createConcept('原子父主题 B')
    const taskId = store.createMaintenanceTask()
    const task = store.tasks.find((item) => item.id === taskId)!
    const result = store.applyTaskResult(task.id, JSON.stringify({
      suggestions: [{
        type: 'create_concept',
        name: '原子子主题',
        aliases: ['原子别名一', '原子别名二'],
        parent_concept_ids: [parentA, parentB],
        reason: '同一主题同时属于两个上位领域',
      }],
      disclosure_requests: [],
    }))
    expect(result.ok, result.errors.join('; ')).toBe(true)
    expect(store.applyMaintenanceSuggestion(taskId, 0)).toMatchObject({ ok: true })
    const child = store.concepts.find((concept) => concept.name === '原子子主题')!
    expect(store.aliases.filter((alias) => alias.conceptId === child.id).map((alias) => alias.alias)).toEqual(expect.arrayContaining(['原子别名一', '原子别名二']))
    expect(store.relations.filter((relation) => relation.relationType === 'hierarchy' && relation.childConceptId === child.id).map((relation) => relation.parentConceptId)).toEqual(expect.arrayContaining([parentA, parentB]))
  })

  it('rejects duplicate aliases and conflicting create parent fields before any write', () => {
    const parent = store.createConcept('冲突父主题')
    const taskId = store.createMaintenanceTask()
    const task = store.tasks.find((item) => item.id === taskId)!
    const result = store.applyTaskResult(task.id, JSON.stringify({
      suggestions: [
        {
          type: 'create_concept',
          name: '冲突子主题',
          aliases: ['重复别名', '重复别名'],
          reason: '重复别名应被拒绝',
        },
        {
          type: 'create_concept',
          name: '冲突父字段主题',
          parent_concept_id: parent,
          parent_concept_ids: [parent],
          reason: '字段冲突应被拒绝',
        },
      ],
      disclosure_requests: [],
    }))
    expect(result.ok).toBe(false)
    expect(result.errors.join('; ')).toContain('aliases 不能重复')
    expect(result.errors.join('; ')).toContain('不能同时使用 parent_concept_id 和 parent_concept_ids')
    expect(store.concepts.some((concept) => concept.name === '冲突子主题')).toBe(false)
  })

  it('enforces the maintenance action contract and supports clearing unit links', () => {
    const conceptId = store.createConcept('维护主题')
    const taskId = store.createMaintenanceTask()
    const invalid = store.applyTaskResult(taskId, JSON.stringify({
      suggestions: [{ type: 'delete_concept', concept_id: conceptId, reason: '清理重复主题', unexpected: true }],
      disclosure_requests: [],
    }))
    expect(invalid.ok).toBe(false)
    expect(invalid.errors.join('; ')).toContain('unexpected 不是 delete_concept 允许的字段')

    const strictRelationTaskId = store.createMaintenanceTask()
    const strictRelationTask = store.tasks.find((item) => item.id === strictRelationTaskId)!
    const strictRelation = store.applyTaskResult(strictRelationTask.id, JSON.stringify({
      suggestions: [{ type: 'add_relation', parent_concept_id: conceptId, child_concept_id: conceptId, relation_type: 'related', reason: 'canonical schema 不应接受兼容字段' }],
      disclosure_requests: [],
    }))
    expect(strictRelation.ok).toBe(false)
    expect(strictRelation.errors.join('; ')).toContain('parent_concept_id 不是 add_relation 允许的字段')

    const sessionId = store.createConversationTask({ question: '生成一个可维护阅读片段' })
    const conversationTask = store.tasks.find((task) => task.type === 'conversation' && task.inputRevision.startsWith(`${sessionId}:`))!
    const answer = store.applyTaskResult(conversationTask.id, JSON.stringify({
      answer: '片段正文',
      units: [{ title: '待维护片段', summary: '片段摘要', concept_ids: [], concepts: [] }],
      memberships: [],
      disclosure_requests: [],
    }))
    expect(answer.ok, answer.errors.join('; ')).toBe(true)
    const unit = store.units.find((item) => item.sessionId === sessionId)!
    store.setUnitConcept(unit.id, conceptId, true)
    expect(store.unitConcepts).toContainEqual(expect.objectContaining({ unitId: unit.id, conceptId }))

    const relinkTaskId = store.createMaintenanceTask({ unitIds: [unit.id] })
    const relinkTask = store.tasks.find((task) => task.id === relinkTaskId)!
    const relinkResult = store.applyTaskResult(relinkTask.id, JSON.stringify({
      suggestions: [{ type: 'unit_relink', unit_id: unit.id, concept_ids: [], reason: '该片段不再属于任何主题' }],
      disclosure_requests: [],
    }))
    expect(relinkResult.ok, relinkResult.errors.join('; ')).toBe(true)
    expect(store.applyMaintenanceSuggestion(relinkTaskId, 0).ok).toBe(true)
    expect(store.unitConcepts).not.toContainEqual(expect.objectContaining({ unitId: unit.id, conceptId }))
  })

  it('rejects null for optional non-nullable maintenance fields', () => {
    const conceptId = store.createConcept('严格字段主题')
    const taskId = store.createMaintenanceTask()
    const task = store.tasks.find((item) => item.id === taskId)!
    const result = store.applyTaskResult(task.id, JSON.stringify({
      suggestions: [{ type: 'update_concept', concept_id: conceptId, summary: null, reason: '测试 schema 类型边界' }],
      disclosure_requests: [],
    }))
    expect(result.ok).toBe(false)
    expect(result.errors.join('; ')).toContain('summary 类型不符合动作 API')
  })

  it('supports explicit relation edits and Session/Message/Unit membership relinking', () => {
    const parentId = store.createConcept('关系父主题')
    const childId = store.createConcept('关系子主题')
    const otherId = store.createConcept('关系关联主题')
    store.createRelation(parentId, childId, 'hierarchy')
    const relationId = store.relations.find((relation) => relation.parentConceptId === parentId && relation.childConceptId === childId)!.id
    const sessionId = store.createConversationTask({ question: '准备维护消息归属' })
    const question = store.messages.find((message) => message.sessionId === sessionId && message.role === 'user')!
    const taskId = store.createMaintenanceTask({ conceptIds: [childId] })
    const task = store.tasks.find((item) => item.id === taskId)!
    const result = store.applyTaskResult(task.id, JSON.stringify({
      suggestions: [
        { type: 'update_relation', relation_id: relationId, source_concept_id: otherId, target_concept_id: childId, relation_type: 'related', reason: '维护确认的显式相关关系' },
        { type: 'membership_relink', target_type: 'message', target_id: question.id, concept_ids: [childId, otherId], replace: true, reason: '消息明确提及两个主题' },
      ],
      disclosure_requests: [],
    }))
    expect(result.ok, result.errors.join('; ')).toBe(true)
    expect(store.applyMaintenanceSuggestion(taskId, 0).ok).toBe(true)
    expect(store.relations).toContainEqual(expect.objectContaining({ id: relationId, relationType: 'related', status: 'proposed' }))
    expect(store.applyMaintenanceSuggestion(taskId, 1).ok).toBe(true)
    expect(store.messageConcepts.filter((link) => link.messageId === question.id).map((link) => link.conceptId)).toEqual(expect.arrayContaining([childId, otherId]))

    const removeTaskId = store.createMaintenanceTask()
    const removeTask = store.tasks.find((item) => item.id === removeTaskId)!
    expect(store.applyTaskResult(removeTask.id, JSON.stringify({ suggestions: [{ type: 'remove_relation', relation_id: relationId, reason: '移除过时关联' }], disclosure_requests: [] })).ok).toBe(true)
    expect(store.applyMaintenanceSuggestion(removeTaskId, 0).ok).toBe(true)
    expect(store.relations.some((relation) => relation.id === relationId)).toBe(false)
  })

  it('supports idempotent Concept delete and restore actions', () => {
    const conceptId = store.createConcept('可恢复维护主题')
    const taskId = store.createMaintenanceTask()
    const task = store.tasks.find((item) => item.id === taskId)!
    expect(store.applyTaskResult(task.id, JSON.stringify({
      suggestions: [
        { type: 'delete_concept', concept_id: conceptId, reason: '主题不再使用' },
        { type: 'restore_concept', concept_id: conceptId, reason: '恢复主题' },
      ],
      disclosure_requests: [],
    })).ok).toBe(true)
    expect(store.applyMaintenanceSuggestion(taskId, 0).ok).toBe(true)
    expect(store.concepts.find((concept) => concept.id === conceptId)?.status).toBe('archived')
    expect(store.applyMaintenanceSuggestion(taskId, 1).ok).toBe(true)
    expect(store.concepts.find((concept) => concept.id === conceptId)?.status).toBe('active')
    const repeatTaskId = store.createMaintenanceTask()
    const repeatTask = store.tasks.find((item) => item.id === repeatTaskId)!
    expect(store.applyTaskResult(repeatTask.id, JSON.stringify({ suggestions: [{ type: 'delete_concept', concept_id: conceptId, reason: '重复归档应幂等' }], disclosure_requests: [] })).ok).toBe(true)
    expect(store.applyMaintenanceSuggestion(repeatTaskId, 0).ok).toBe(true)
    expect(store.applyMaintenanceSuggestion(repeatTaskId, 0)).toMatchObject({ ok: false, error: '这条建议已经应用' })
  })

  it('supports multi-parent hierarchy replacement, alias removal, and relation review actions', () => {
    const parentA = store.createConcept('多父主题 A')
    const parentB = store.createConcept('多父主题 B')
    const child = store.createConcept('多父子主题')
    const taskId = store.createMaintenanceTask()
    const task = store.tasks.find((item) => item.id === taskId)!
    expect(store.applyTaskResult(task.id, JSON.stringify({
      suggestions: [
        { type: 'alias', concept_id: child, alias: '多父别名', reason: '用户术语是该主题的同义词' },
        { type: 'set_hierarchy_parents', concept_id: child, parent_concept_ids: [parentA, parentB], reason: '该主题同时属于两个明确上位领域' },
      ],
      disclosure_requests: [],
    })).ok).toBe(true)
    expect(store.applyMaintenanceSuggestion(taskId, 0).ok).toBe(true)
    const alias = store.aliases.find((item) => item.conceptId === child && item.alias === '多父别名')!
    expect(store.applyMaintenanceSuggestion(taskId, 1).ok).toBe(true)
    expect(store.relations.filter((relation) => relation.relationType === 'hierarchy' && relation.childConceptId === child).map((relation) => relation.parentConceptId)).toEqual(expect.arrayContaining([parentA, parentB]))

    const reviewTaskId = store.createMaintenanceTask()
    const reviewTask = store.tasks.find((item) => item.id === reviewTaskId)!
    const relation = store.relations.find((item) => item.childConceptId === child && item.parentConceptId === parentA)!
    expect(store.applyTaskResult(reviewTask.id, JSON.stringify({
      suggestions: [
        { type: 'set_relation_status', relation_id: relation.id, status: 'confirmed', reason: '用户明确确认该父主题' },
        { type: 'remove_alias', alias_id: alias.id, reason: '别名不再使用' },
      ],
      disclosure_requests: [],
    })).ok).toBe(true)
    expect(store.applyMaintenanceSuggestion(reviewTaskId, 0).ok).toBe(true)
    expect(store.relations.find((item) => item.id === relation.id)?.status).toBe('confirmed')
    expect(store.applyMaintenanceSuggestion(reviewTaskId, 1).ok).toBe(true)
    expect(store.aliases.some((item) => item.id === alias.id)).toBe(false)
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
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: '唯一回答', units: [{ title: 'API 片段', summary: 'API 回答证据。', concept_ids: [], concepts: [] }], disclosure_requests: [] }) } }] }),
    } as Response)
    await expect(first).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('exposes incremental conversation text while parsing an SSE response', async () => {
    let releaseTail: (() => void) | undefined
    const firstFrame = 'data: {"choices":[{"delta":{"content":"{\\"answer\\":\\"实时"}}]}\n\n'
    const tailFrame = 'data: {"choices":[{"delta":{"content":"输出\\",\\"units\\":[{\\"title\\":\\"实时片段\\",\\"summary\\":\\"流式回答证据\\",\\"concept_ids\\":[],\\"concepts\\":[]}],\\"disclosure_requests\\":[]}"}}]}\n\ndata: [DONE]\n\n'
    const body = {
      getReader: () => ({
        read: async () => {
          if ((body as { step?: number }).step === undefined) {
            ;(body as { step?: number }).step = 1
            return { done: false, value: new TextEncoder().encode(firstFrame) }
          }
          if ((body as { step?: number }).step === 1) {
            ;(body as { step?: number }).step = 2
            await new Promise<void>((resolve) => { releaseTail = resolve })
            return { done: false, value: new TextEncoder().encode(tailFrame) }
          }
          return { done: true, value: undefined }
        },
      }),
    } as unknown as ReadableStream<Uint8Array> & { step?: number }
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
    } as Response)))
    store.updateConfig({
      llm: {
        ...store.config.llm,
        mode: 'api',
        stream: true,
        defaultProvider: 'stream-provider',
        providers: [{ id: 'stream-provider', name: 'Stream', baseUrl: 'https://example.test/v1', model: 'stream-model', apiKey: 'test-key' }],
      },
    })
    const sessionId = store.createConversationTask({ question: '检查流式回答' })
    const task = store.tasks.find((item) => item.type === 'conversation' && item.inputRevision.startsWith(`${sessionId}:`))!
    const pending = store.executeTask(task.id)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.streamingTaskPreview(task.id)).toBe('实时')
    releaseTail?.()
    await expect(pending).resolves.toEqual({ ok: true })
    expect(store.streamingTaskPreview(task.id)).toBe('')
    expect(store.units).toContainEqual(expect.objectContaining({ title: '实时片段' }))
  })

  it('exposes maintenance MCP tools and normalizes tool calls through the suggestion validator', async () => {
    const conceptId = store.createConcept('工具调用主题')
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ function: { name: 'nexus_maintenance_update_concept', arguments: JSON.stringify({ concept_id: conceptId, summary: '工具更新摘要', reason: '维护证据' }) } }] } }] }),
      } as Response
    }))
    store.updateConfig({
      llm: {
        ...store.config.llm,
        mode: 'api',
        defaultProvider: 'maintenance-provider',
        providers: [{ id: 'maintenance-provider', name: 'Maintenance', baseUrl: 'https://example.test/v1', model: 'maintenance-model', apiKey: 'test-key' }],
      },
    })
    const taskId = store.createMaintenanceTask({ conceptIds: [conceptId] })
    await expect(store.executeTask(taskId)).resolves.toEqual({ ok: true })
    const tools = requestBody?.tools as Array<{ type: string; function: { name: string; parameters: { additionalProperties: boolean } } }>
    expect(tools.some((tool) => tool.type === 'function' && tool.function.name === 'nexus_maintenance_update_concept')).toBe(true)
    expect(tools.find((tool) => tool.function.name === 'nexus_maintenance_set_hierarchy_parents')?.function.parameters.additionalProperties).toBe(false)
    const task = store.tasks.find((item) => item.id === taskId)!
    expect(JSON.parse(task.parsedResult ?? '{}')).toMatchObject({ suggestions: [{ type: 'update_concept', concept_id: conceptId, summary: '工具更新摘要', reason: '维护证据' }] })
  })
})
