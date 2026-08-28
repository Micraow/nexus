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
      units: [],
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
      units: [],
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
      units: [],
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

  it('enforces the maintenance action contract and supports clearing unit links', () => {
    const conceptId = store.createConcept('维护主题')
    const taskId = store.createMaintenanceTask()
    const invalid = store.applyTaskResult(taskId, JSON.stringify({
      suggestions: [{ type: 'delete_concept', concept_id: conceptId, reason: '清理重复主题', unexpected: true }],
      disclosure_requests: [],
    }))
    expect(invalid.ok).toBe(false)
    expect(invalid.errors.join('; ')).toContain('unexpected 不是 delete_concept 允许的字段')

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
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: '唯一回答', units: [], disclosure_requests: [] }) } }] }),
    } as Response)
    await expect(first).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
