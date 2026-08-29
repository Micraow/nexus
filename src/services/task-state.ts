import type { TaskStatus, TaskType } from '@/types/domain'

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['pending', 'running', 'needs_review']
export const LEGACY_SEGMENTATION_RETIRED_REASON = '旧版对话分组已停用；原始消息和已有阅读片段均已保留，当前知识主题流程不再等待分组。'

/**
 * State changes are expressed as domain events. UI intent and transport
 * outcomes must not issue arbitrary `status = ...` writes.
 */
export type TaskTransitionEvent =
  | 'start'
  | 'continue_disclosure'
  | 'accept_validated_result'
  | 'reject_validation'
  | 'fail_transport'
  | 'retry'
  | 'cancel'
  | 'invalidate'

const TASK_TRANSITION_EVENT_TARGET: Readonly<Record<TaskTransitionEvent, TaskStatus>> = {
  start: 'running',
  continue_disclosure: 'pending',
  accept_validated_result: 'success',
  reject_validation: 'needs_review',
  fail_transport: 'failed',
  retry: 'pending',
  cancel: 'cancelled',
  invalidate: 'stale',
}

const TASK_TRANSITION_EVENT_SOURCES: Readonly<Record<TaskTransitionEvent, readonly TaskStatus[]>> = {
  start: ['pending'],
  continue_disclosure: ['pending', 'running', 'needs_review'],
  accept_validated_result: ['pending', 'running', 'needs_review'],
  reject_validation: ['pending', 'running', 'needs_review'],
  fail_transport: ['running'],
  retry: ['failed', 'needs_review', 'stale', 'cancelled'],
  cancel: ['pending', 'running', 'needs_review'],
  invalidate: ['pending', 'running', 'needs_review'],
}

/**
 * The persisted task status is the source of truth for queue and UI state.
 * Keep the legal transitions here instead of letting individual callers infer
 * them from display state or an API request's lifecycle.
 */
const TASK_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['running', 'success', 'failed', 'needs_review', 'stale', 'cancelled'],
  running: ['pending', 'success', 'failed', 'needs_review', 'stale', 'cancelled'],
  success: [],
  failed: ['pending'],
  needs_review: ['pending', 'success', 'stale', 'cancelled'],
  stale: ['pending', 'cancelled'],
  cancelled: ['pending'],
}

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status)
}

/** A response may be applied by a human or an API request in these states. */
export function canApplyTaskResult(status: TaskStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'needs_review'
}

/** Only a pending task may acquire an API execution lease. */
export function canExecuteTask(status: TaskStatus): boolean {
  return status === 'pending'
}

/** A completed or interrupted task may be queued again without mutation. */
export function canRetryTask(status: TaskStatus): boolean {
  return canTransitionTask(status, 'retry')
}

export function taskStatusForTransition(event: TaskTransitionEvent): TaskStatus {
  return TASK_TRANSITION_EVENT_TARGET[event]
}

export function canTransitionTask(status: TaskStatus, event: TaskTransitionEvent): boolean {
  return TASK_TRANSITION_EVENT_SOURCES[event].includes(status)
}

/** Retained for callers that only have source/target statuses. */
export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TASK_STATUS_TRANSITIONS[from].includes(to)
}

export function normalizeTaskStatus(type: TaskType, status: TaskStatus): TaskStatus {
  return type === 'segmentation' && isActiveTaskStatus(status) ? 'cancelled' : status
}
