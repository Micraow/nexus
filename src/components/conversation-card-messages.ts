import { conversationMessagesForNode } from '@/services/conversation'
import type { Message } from '@/types/domain'
import { parseMetadata } from '@/utils/metadata'

export interface PendingConversationMessageTarget {
  id: string
  taskId?: string
}

export interface PendingConversationTaskTarget extends PendingConversationMessageTarget {
  parentId?: string | null
  started: boolean
}

/**
 * Run task creation before locking the temporary branch. If creation throws,
 * this function never returns and the caller's immutable branch object stays
 * closable. A successfully created task atomically supplies the lock and ID
 * used to move its question into the temporary card.
 */
export function createPendingConversationTask<T extends PendingConversationTaskTarget>(
  pending: T | null,
  parentNodeId: string,
  createTask: () => string,
): { taskId: string; pending: T | null } {
  const taskId = createTask()
  return {
    taskId,
    pending: pending?.parentId === parentNodeId
      ? { ...pending, started: true, taskId }
      : pending,
  }
}

/**
 * While a suggested exploration is waiting for its answer, its persisted user
 * message belongs exclusively to the temporary card. The normal branch
 * resolver intentionally maps unanswered follow-ups to their parent, so this
 * presentation override prevents the question from appearing twice.
 */
export function conversationCardMessages(
  nodeId: string,
  messages: Message[],
  pending: PendingConversationMessageTarget | null,
): Message[] {
  const pendingTaskId = pending?.taskId
  if (nodeId === pending?.id && pendingTaskId) {
    return messages.filter((message) => message.role === 'user' && parseMetadata(message.metadata).taskId === pendingTaskId)
  }
  const resolved = conversationMessagesForNode(nodeId, messages)
  return pendingTaskId
    ? resolved.filter((message) => parseMetadata(message.metadata).taskId !== pendingTaskId)
    : resolved
}
