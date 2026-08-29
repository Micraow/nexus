import type { TaskPhase, TaskStatus, TaskType } from '@/types/domain'

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

export interface TaskTransition {
  from: TaskStatus
  event: TaskTransitionEvent
  to: TaskStatus
  phase: TaskPhase
}

const TASK_TRANSITION_EVENT_PHASE: Readonly<Record<TaskTransitionEvent, TaskPhase>> = {
  start: 'executing',
  continue_disclosure: 'awaiting_disclosure',
  accept_validated_result: 'committed',
  reject_validation: 'awaiting_review',
  fail_transport: 'failed',
  retry: 'queued',
  cancel: 'cancelled',
  invalidate: 'stale',
}

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
 * Resolve one legal domain transition. This is the only source of truth for
 * both the compact queue status and its explanatory lifecycle phase.
 */
export function transitionTaskState(from: TaskStatus, event: TaskTransitionEvent): TaskTransition | null {
  if (!TASK_TRANSITION_EVENT_SOURCES[event].includes(from)) return null
  return { from, event, to: TASK_TRANSITION_EVENT_TARGET[event], phase: TASK_TRANSITION_EVENT_PHASE[event] }
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

export function taskPhaseForTransition(event: TaskTransitionEvent): TaskPhase {
  return TASK_TRANSITION_EVENT_PHASE[event]
}

/** Derive a phase for rows created before the explicit phase column existed. */
export function taskPhaseForStatus(status: TaskStatus, awaitingDisclosure = false): TaskPhase {
  if (status === 'pending') return awaitingDisclosure ? 'awaiting_disclosure' : 'queued'
  if (status === 'running') return 'executing'
  if (status === 'needs_review') return 'awaiting_review'
  if (status === 'success') return 'committed'
  if (status === 'failed') return 'failed'
  if (status === 'stale') return 'stale'
  return 'cancelled'
}

export function canTransitionTask(status: TaskStatus, event: TaskTransitionEvent): boolean {
  return transitionTaskState(status, event) !== null
}

/** Retained for callers that only have source/target statuses. */
export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true
  return (Object.keys(TASK_TRANSITION_EVENT_TARGET) as TaskTransitionEvent[])
    .some((event) => TASK_TRANSITION_EVENT_TARGET[event] === to && canTransitionTask(from, event))
}

export function normalizeTaskStatus(type: TaskType, status: TaskStatus): TaskStatus {
  return type === 'segmentation' && isActiveTaskStatus(status) ? 'cancelled' : status
}
