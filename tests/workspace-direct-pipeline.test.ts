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
    store.updateConfig({ llm: { tokenBudget: 1000 } })
    const report = store.importJsonText(JSON.stringify(payload(8)))
    const originTasks = store.tasks.filter((task) => report.taskIds.includes(task.id) && task.type === 'origin_concepts')
    expect(originTasks.length).toBeGreaterThan(1)

    const task = originTasks.find((item) => item.inputRevision.includes(':chunk:'))!
    const [, , , startText] = task.inputRevision.split(':')
    const targetMessage = store.messages.find((message) => message.orderInSession === Number(startText))!
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
})
