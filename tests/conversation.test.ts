import { describe, expect, it } from 'vitest'
import { conversationTaskForNode, suggestedExplorationQuestion, unfinishedConversationTask } from '@/services/conversation'
import type { LLMTask, Message } from '@/types/domain'

const task = (id: string, status: LLMTask['status'], createdAt: string): LLMTask => ({
  id,
  type: 'conversation',
  mode: 'prompt_paste',
  promptVersion: 'test',
  inputRevision: 'session-1:1',
  prompt: '{}',
  status,
  retryCount: 0,
  createdAt,
  updatedAt: createdAt,
})

const message = (id: string, role: Message['role'], metadata: Record<string, unknown>): Message => ({
  id,
  sessionId: 'session-1',
  role,
  content: id,
  orderInSession: 0,
  metadata,
})

describe('conversation branch task mapping', () => {
  it('binds pending questions to their parent and completed answers to their branch', () => {
    const tasks = [
      task('task-a', 'success', '2026-08-28T01:00:00.000Z'),
      task('task-b', 'pending', '2026-08-28T02:00:00.000Z'),
    ]
    const messages = [
      message('answer-a', 'assistant', { taskId: 'task-a', navNodeId: 'branch-a' }),
      message('question-b', 'user', { taskId: 'task-b', parentNodeId: 'branch-b' }),
    ]

    expect(conversationTaskForNode(tasks, messages, 'session-1', 'branch-a')?.id).toBe('task-a')
    expect(conversationTaskForNode(tasks, messages, 'session-1', 'branch-b')?.id).toBe('task-b')
    expect(conversationTaskForNode(tasks, messages, 'session-1', 'unrelated')).toBeNull()
    expect(unfinishedConversationTask(tasks, 'session-1')?.id).toBe('task-b')
  })

  it('builds an editable follow-up from a suggested topic', () => {
    expect(suggestedExplorationQuestion('  量子   纠错 ')).toBe('请继续解释「量子 纠错」，并说明它与当前讨论的关系。')
    expect(suggestedExplorationQuestion('')).toBe('')
  })
})
