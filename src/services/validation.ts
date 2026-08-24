import { z } from 'zod'
import type { ImportPayload } from '@/types/domain'

const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

const conversationSchema = z.object({
  external_session_id: z.string().optional(),
  session_id: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  created_at: z.string().optional(),
  messages: z.array(messageSchema).min(1, '至少需要一条消息'),
})

export const importPayloadSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  platform: z.string().min(1),
  exported_at: z.string().optional(),
  conversations: z.array(conversationSchema).min(1),
}).superRefine((payload, context) => {
  if (payload.schema_version != null && payload.schema_version !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['schema_version'], message: '只支持 schema_version=1' })
  }
})

export interface SegmentationUnitResult {
  message_indices: number[]
  title_hint?: string
}

export interface SegmentationResult {
  units: SegmentationUnitResult[]
  unassigned_message_indices: number[]
}

export interface ValidationIssue {
  path: string
  message: string
}

export function validateUnitText(title: string | null | undefined, summary: string | null | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (title != null && Array.from(title.trim()).length > 30) {
    issues.push({ path: 'title', message: '标题不能超过 30 个字符' })
  }
  if (summary != null && Array.from(summary.trim()).length > 120) {
    issues.push({ path: 'summary', message: '摘要不能超过 120 个字符' })
  }
  return issues
}

export function parseImportPayload(raw: unknown): { data?: ImportPayload; issues: ValidationIssue[] } {
  const result = importPayloadSchema.safeParse(raw)
  if (result.success) return { data: result.data as ImportPayload, issues: [] }
  return {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join('.') || '$', message: issue.message })),
  }
}

export function validateSegmentationResult(
  result: unknown,
  messageCount: number,
): { data?: SegmentationResult; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = []
  if (!result || typeof result !== 'object') return { issues: [{ path: '$', message: '结果必须是 JSON 对象' }] }
  const candidate = result as Record<string, unknown>
  const units = candidate.units
  const unassigned = candidate.unassigned_message_indices
  if (!Array.isArray(units)) issues.push({ path: 'units', message: '必须是数组' })
  if (!Array.isArray(unassigned)) issues.push({ path: 'unassigned_message_indices', message: '必须是数组，不能默默遗漏消息' })
  if (issues.length) return { issues }

  const seen = new Map<number, string>()
  const normalizedUnits: SegmentationUnitResult[] = []
  ;(units as unknown[]).forEach((unit, unitIndex) => {
    if (!unit || typeof unit !== 'object') {
      issues.push({ path: `units.${unitIndex}`, message: '知识单元必须是对象' })
      return
    }
    const item = unit as Record<string, unknown>
    if (!Array.isArray(item.message_indices) || item.message_indices.length === 0) {
      issues.push({ path: `units.${unitIndex}.message_indices`, message: '必须包含至少一条消息索引' })
      return
    }
    const indices = item.message_indices.filter((value): value is number => Number.isInteger(value))
    if (indices.length !== item.message_indices.length) {
      issues.push({ path: `units.${unitIndex}.message_indices`, message: '索引必须是整数' })
    }
    const titleHint = typeof item.title_hint === 'string' ? item.title_hint.trim() : undefined
    if (titleHint && Array.from(titleHint).length > 30) {
      issues.push({ path: `units.${unitIndex}.title_hint`, message: '标题提示不能超过 30 个字符' })
    }
    normalizedUnits.push({ message_indices: indices, title_hint: titleHint })
    indices.forEach((index) => {
      if (index < 0 || index >= messageCount) {
        issues.push({ path: `units.${unitIndex}.message_indices`, message: `索引 ${index} 越界` })
      }
      if (seen.has(index)) {
        issues.push({ path: `units.${unitIndex}.message_indices`, message: `索引 ${index} 重复归属` })
      } else {
        seen.set(index, `unit_${unitIndex}`)
      }
    })
  })

  const unassignedIndices = (unassigned as unknown[]).filter((value): value is number => Number.isInteger(value))
  if (unassignedIndices.length !== (unassigned as unknown[]).length) {
    issues.push({ path: 'unassigned_message_indices', message: '索引必须是整数' })
  }
  unassignedIndices.forEach((index) => {
    if (index < 0 || index >= messageCount) {
      issues.push({ path: 'unassigned_message_indices', message: `索引 ${index} 越界` })
    }
    if (seen.has(index)) {
      issues.push({ path: 'unassigned_message_indices', message: `索引 ${index} 已经被知识单元占用` })
    } else {
      seen.set(index, 'unassigned')
    }
  })

  for (let index = 0; index < messageCount; index += 1) {
    if (!seen.has(index)) issues.push({ path: 'unassigned_message_indices', message: `消息 ${index} 未被分配` })
  }
  if (issues.length) return { issues }
  return { data: { units: normalizedUnits, unassigned_message_indices: unassignedIndices }, issues: [] }
}
