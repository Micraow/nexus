import { describe, expect, it } from 'vitest'
import {
  ACTIVE_TASK_STATUSES,
  canApplyTaskResult,
  canExecuteTask,
  canRetryTask,
  canTransitionTask,
  canTransitionTaskStatus,
  isActiveTaskStatus,
  normalizeTaskStatus,
  taskPhaseForStatus,
  taskPhaseForTransition,
  taskStatusForTransition,
  transitionTaskState,
} from '@/services/task-state'
import type { TaskPhase, TaskStatus } from '@/types/domain'

describe('task state machine', () => {
  it('allows disclosure continuation to requeue active work', () => {
    for (const status of ['pending', 'running', 'needs_review'] as TaskStatus[]) {
      expect(canTransitionTask(status, 'continue_disclosure')).toBe(true)
      expect(taskStatusForTransition('continue_disclosure')).toBe('pending')
      expect(canApplyTaskResult(status)).toBe(true)
    }
  })

  it('keeps the event contract aligned with the persisted status and phase', () => {
    const expected: Array<[Parameters<typeof taskStatusForTransition>[0], TaskStatus, TaskPhase]> = [
      ['start', 'running', 'executing'],
      ['continue_disclosure', 'pending', 'awaiting_disclosure'],
      ['accept_validated_result', 'success', 'committed'],
      ['reject_validation', 'needs_review', 'awaiting_review'],
      ['fail_transport', 'failed', 'failed'],
      ['retry', 'pending', 'queued'],
      ['cancel', 'cancelled', 'cancelled'],
      ['invalidate', 'stale', 'stale'],
    ]
    expected.forEach(([event, status, phase]) => {
      expect(taskStatusForTransition(event)).toBe(status)
      expect(taskPhaseForTransition(event)).toBe(phase)
    })
  })

  it('returns one atomic transition record for legal events only', () => {
    expect(transitionTaskState('pending', 'start')).toEqual({
      from: 'pending',
      event: 'start',
      to: 'running',
      phase: 'executing',
    })
    expect(transitionTaskState('running', 'continue_disclosure')).toEqual({
      from: 'running',
      event: 'continue_disclosure',
      to: 'pending',
      phase: 'awaiting_disclosure',
    })
    expect(transitionTaskState('success', 'retry')).toBeNull()
    expect(canTransitionTaskStatus('pending', 'failed')).toBe(false)
    expect(canTransitionTaskStatus('running', 'failed')).toBe(true)
  })

  it('allows only the event sources documented by the state machine', () => {
    const statuses: TaskStatus[] = ['pending', 'running', 'success', 'failed', 'needs_review', 'stale', 'cancelled']
    const sources: Record<string, TaskStatus[]> = {
      start: ['pending'],
      continue_disclosure: ['pending', 'running', 'needs_review'],
      accept_validated_result: ['pending', 'running', 'needs_review'],
      reject_validation: ['pending', 'running', 'needs_review'],
      fail_transport: ['running'],
      retry: ['failed', 'needs_review', 'stale', 'cancelled'],
      cancel: ['pending', 'running', 'needs_review'],
      invalidate: ['pending', 'running', 'needs_review'],
    }
    Object.entries(sources).forEach(([event, allowed]) => {
      statuses.forEach((status) => {
        expect(canTransitionTask(status, event as Parameters<typeof canTransitionTask>[1])).toBe(allowed.includes(status))
      })
    })
  })

  it('only lets pending tasks acquire an API execution lease', () => {
    expect(canExecuteTask('pending')).toBe(true)
    expect(canExecuteTask('running')).toBe(false)
    expect(canExecuteTask('success')).toBe(false)
  })

  it('keeps terminal success immutable and prevents arbitrary status jumps', () => {
    expect(canTransitionTaskStatus('success', 'pending')).toBe(false)
    expect(canTransitionTask('success', 'retry')).toBe(false)
    expect(canTransitionTask('pending', 'retry')).toBe(false)
  })

  it('keeps queue activity and result application tied to persisted status', () => {
    expect(ACTIVE_TASK_STATUSES).toEqual(['pending', 'running', 'needs_review'])
    ACTIVE_TASK_STATUSES.forEach((status) => {
      expect(isActiveTaskStatus(status)).toBe(true)
      expect(canApplyTaskResult(status)).toBe(true)
    })
    ;(['success', 'failed', 'stale', 'cancelled'] as TaskStatus[]).forEach((status) => {
      expect(isActiveTaskStatus(status)).toBe(false)
      expect(canApplyTaskResult(status)).toBe(false)
    })
  })

  it('permits retry only from interrupted or review states', () => {
    for (const status of ['failed', 'needs_review', 'stale', 'cancelled'] as TaskStatus[]) {
      expect(canRetryTask(status)).toBe(true)
      expect(taskStatusForTransition('retry')).toBe('pending')
    }
    expect(canRetryTask('success')).toBe(false)
    expect(canRetryTask('running')).toBe(false)
  })

  it('derives legacy phases without changing the status value', () => {
    const expected: Array<[TaskStatus, TaskPhase]> = [
      ['pending', 'queued'],
      ['running', 'executing'],
      ['needs_review', 'awaiting_review'],
      ['success', 'committed'],
      ['failed', 'failed'],
      ['stale', 'stale'],
      ['cancelled', 'cancelled'],
    ]
    expected.forEach(([status, phase]) => expect(taskPhaseForStatus(status)).toBe(phase))
    expect(taskPhaseForStatus('pending', true)).toBe('awaiting_disclosure')
    expect(taskPhaseForStatus('pending', false)).toBe('queued')
  })

  it('retires active legacy segmentation tasks while preserving terminal records', () => {
    ;(['pending', 'running', 'needs_review'] as TaskStatus[]).forEach((status) => {
      expect(normalizeTaskStatus('segmentation', status)).toBe('cancelled')
    })
    ;(['success', 'failed', 'stale', 'cancelled'] as TaskStatus[]).forEach((status) => {
      expect(normalizeTaskStatus('segmentation', status)).toBe(status)
    })
    expect(normalizeTaskStatus('conversation', 'pending')).toBe('pending')
  })
})
