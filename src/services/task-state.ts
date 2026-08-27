import type { TaskStatus, TaskType } from '@/types/domain'

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['pending', 'running', 'needs_review']
export const LEGACY_SEGMENTATION_RETIRED_REASON = '旧版对话分组已停用；原始消息和已有阅读片段均已保留，当前知识主题流程不再等待分组。'

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status)
}

export function normalizeTaskStatus(type: TaskType, status: TaskStatus): TaskStatus {
  return type === 'segmentation' && isActiveTaskStatus(status) ? 'cancelled' : status
}
