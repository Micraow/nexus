import type { LLMTask, Message } from '@/types/domain'
import { parseMetadata } from '@/utils/metadata'

const unfinishedStatuses = new Set<LLMTask['status']>(['pending', 'running', 'needs_review'])

function conversationTasks(tasks: LLMTask[], sessionId: string): LLMTask[] {
  return tasks
    .filter((task) => task.type === 'conversation' && task.inputRevision.startsWith(`${sessionId}:`))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
}

/** The one unfinished conversation task that owns the Session input lock. */
export function unfinishedConversationTask(tasks: LLMTask[], sessionId: string): LLMTask | null {
  return conversationTasks(tasks, sessionId).find((task) => unfinishedStatuses.has(task.status)) ?? null
}

/**
 * Resolve status for the selected exploration node instead of borrowing the
 * newest task from another branch. Pending questions point at their parent
 * node; completed answers point at the branch node through Message metadata.
 */
export function conversationTaskForNode(
  tasks: LLMTask[],
  messages: Message[],
  sessionId: string,
  nodeId: string | null | undefined,
): LLMTask | null {
  if (!nodeId) return unfinishedConversationTask(tasks, sessionId)
  const taskById = new Map(conversationTasks(tasks, sessionId).map((task) => [task.id, task]))
  const sessionMessages = messages.filter((message) => message.sessionId === sessionId)

  const pendingTaskIds = sessionMessages
    .filter((message) => message.role === 'user' && parseMetadata(message.metadata).parentNodeId === nodeId)
    .map((message) => parseMetadata(message.metadata).taskId)
    .filter((taskId): taskId is string => typeof taskId === 'string')
  const pending = pendingTaskIds
    .map((taskId) => taskById.get(taskId))
    .filter((task): task is LLMTask => Boolean(task))
    .filter((task) => unfinishedStatuses.has(task.status))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  if (pending) return pending

  const answerTaskIds = sessionMessages
    .filter((message) => message.role === 'assistant' && parseMetadata(message.metadata).navNodeId === nodeId)
    .map((message) => parseMetadata(message.metadata).taskId)
    .filter((taskId): taskId is string => typeof taskId === 'string')
  return answerTaskIds
    .map((taskId) => taskById.get(taskId))
    .filter((task): task is LLMTask => Boolean(task))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
}

export function suggestedExplorationQuestion(topic: string): string {
  const normalized = topic.replace(/\s+/g, ' ').trim()
  return normalized ? `请继续解释「${normalized}」，并说明它与当前讨论的关系。` : ''
}
