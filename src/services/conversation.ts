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

/** Resolve the navigation branch that owns a conversation message. */
export function conversationMessageBranchNodeId(message: Message, messages: Message[]): string | null {
  const metadata = parseMetadata(message.metadata)
  if (message.role === 'assistant') {
    return typeof metadata.navNodeId === 'string' && metadata.navNodeId.trim() ? metadata.navNodeId : null
  }
  if (message.role !== 'user') return null
  // The opening question belongs to the shared navigation root. Follow-up
  // questions move to the answer-created child once that answer exists.
  if (metadata.mode !== 'follow_up') {
    return typeof metadata.parentNodeId === 'string' && metadata.parentNodeId.trim() ? metadata.parentNodeId : null
  }
  if (typeof metadata.answerMessageId === 'string' && metadata.answerMessageId.trim()) {
    const answer = messages.find((candidate) => candidate.id === metadata.answerMessageId && candidate.role === 'assistant')
    const answerNodeId = parseMetadata(answer?.metadata).navNodeId
    if (typeof answerNodeId === 'string' && answerNodeId.trim()) return answerNodeId
  }
  return typeof metadata.parentNodeId === 'string' && metadata.parentNodeId.trim() ? metadata.parentNodeId : null
}

/**
 * Return the messages that belong to one visible branch card. The opening
 * question is stored on the shared root, so an answer card also pulls in the
 * user message with the same task id. Sibling branches remain disjoint.
 */
export function conversationMessagesForNode(nodeId: string, messages: Message[]): Message[] {
  // A legacy opening question can still carry `mode=new`/parent=root while
  // its answer was materialized on a child branch. Keep the triggering
  // question with that answer instead of rendering it once on the root and
  // once again through the answer-task backfill below.
  const answerBranchByTaskId = new Map<string, string>()
  messages.forEach((message) => {
    if (message.role !== 'assistant') return
    const metadata = parseMetadata(message.metadata)
    const taskId = typeof metadata.taskId === 'string' ? metadata.taskId.trim() : ''
    const branchId = typeof metadata.navNodeId === 'string' ? metadata.navNodeId.trim() : ''
    if (taskId && branchId) answerBranchByTaskId.set(taskId, branchId)
  })
  const cardMessages = messages.filter((message) => {
    if (conversationMessageBranchNodeId(message, messages) !== nodeId) return false
    if (message.role !== 'user') return true
    const metadata = parseMetadata(message.metadata)
    const taskId = typeof metadata.taskId === 'string' ? metadata.taskId.trim() : ''
    const answerBranchId = taskId ? answerBranchByTaskId.get(taskId) : undefined
    // Follow-up questions are already reassigned by
    // conversationMessageBranchNodeId once their answer exists. This branch
    // only handles opening/legacy questions that still resolve to a parent.
    return !answerBranchId || answerBranchId === nodeId || metadata.mode === 'follow_up'
  })
  const answerTaskIds = new Set(cardMessages
    .filter((message) => message.role === 'assistant')
    .map((message) => parseMetadata(message.metadata).taskId)
    .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0))
  messages.forEach((message) => {
    const taskId = parseMetadata(message.metadata).taskId
    if (message.role !== 'user' || typeof taskId !== 'string' || !answerTaskIds.has(taskId)) return
    if (!cardMessages.some((candidate) => candidate.id === message.id)) cardMessages.push(message)
  })
  return cardMessages.sort((left, right) => left.orderInSession - right.orderInSession)
}

export function suggestedExplorationQuestion(topic: string): string {
  const normalized = topic.replace(/\s+/g, ' ').trim()
  return normalized ? `请继续解释「${normalized}」，并说明它与当前讨论的关系。` : ''
}
