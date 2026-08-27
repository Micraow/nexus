// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  it('keeps legacy segmentation task application available', () => {
    const report = store.importJsonText(JSON.stringify(payload()))
    const session = store.sessions[0]
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
    const result = store.applyTaskResult(taskId, JSON.stringify({
      units: [{ message_indices: [0, 1], title_hint: '旧知识单元' }],
      unassigned_message_indices: [],
    }))

    expect(report.taskIds).toHaveLength(2)
    expect(result.ok, result.errors.join('; ')).toBe(true)
    expect(store.units).toHaveLength(1)
    expect(store.units[0].title).toBe('旧知识单元')
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
})
