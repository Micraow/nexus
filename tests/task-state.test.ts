import { describe, expect, it } from 'vitest'
import {
  canApplyTaskResult,
  canExecuteTask,
  canRetryTask,
  canTransitionTask,
  canTransitionTaskStatus,
  taskStatusForTransition,
} from '@/services/task-state'
import type { TaskStatus } from '@/types/domain'

describe('task state machine', () => {
  it('allows disclosure continuation to requeue active work', () => {
    for (const status of ['pending', 'running', 'needs_review'] as TaskStatus[]) {
      expect(canTransitionTask(status, 'continue_disclosure')).toBe(true)
      expect(taskStatusForTransition('continue_disclosure')).toBe('pending')
      expect(canApplyTaskResult(status)).toBe(true)
    }
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

  it('permits retry only from interrupted or review states', () => {
    for (const status of ['failed', 'needs_review', 'stale', 'cancelled'] as TaskStatus[]) {
      expect(canRetryTask(status)).toBe(true)
      expect(taskStatusForTransition('retry')).toBe('pending')
    }
    expect(canRetryTask('success')).toBe(false)
    expect(canRetryTask('running')).toBe(false)
  })
})
