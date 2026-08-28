import { z } from 'zod'
import { DEFAULT_CONCEPT_LIMIT, normalizeConceptLimit } from '@/services/config'
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
export interface DisclosureRequest {
  refID: string
  depth: number
}

export type ConceptMembershipTarget = 'session' | 'message' | 'unit'

export interface ConceptMembership {
  target_type: ConceptMembershipTarget
  target_id: string
  concept_ids: string[]
}

/**
 * Validate many-to-many Concept membership declarations emitted by an LLM.
 * Membership is deliberately separate from the Concept definitions: a task
 * may introduce new definitions while reusing existing IDs from its catalog.
 */
export function validateConceptMemberships(
  value: unknown,
  options: { targetIds?: Iterable<string>; conceptIds?: Iterable<string>; targetTypes?: Iterable<ConceptMembershipTarget> } = {},
): ValidationIssue[] {
  if (value == null) return []
  if (!Array.isArray(value)) return [{ path: 'memberships', message: '必须是数组' }]
  const targetIds = options.targetIds ? new Set(options.targetIds) : null
  const conceptIds = options.conceptIds ? new Set(options.conceptIds) : null
  const targetTypes = options.targetTypes ? new Set(options.targetTypes) : null
  const issues: ValidationIssue[] = []
  value.forEach((raw, index) => {
    const path = `memberships.${index}`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ path, message: '归属声明必须是对象' })
      return
    }
    const item = raw as Record<string, unknown>
    const targetType = item.target_type
    const targetId = typeof item.target_id === 'string' ? item.target_id.trim() : ''
    if (targetType !== 'session' && targetType !== 'message' && targetType !== 'unit') {
      issues.push({ path: `${path}.target_type`, message: 'target_type 必须是 session、message 或 unit' })
    } else if (targetTypes && !targetTypes.has(targetType as ConceptMembershipTarget)) {
      issues.push({ path: `${path}.target_type`, message: `当前任务不允许 ${targetType} 归属` })
    }
    if (!targetId) issues.push({ path: `${path}.target_id`, message: 'target_id 必须是非空字符串' })
    else if (targetIds && !targetIds.has(targetId)) issues.push({ path: `${path}.target_id`, message: 'target_id 不在当前任务范围中' })
    if (Object.prototype.hasOwnProperty.call(item, 'concept_id')) {
      issues.push({ path: `${path}.concept_id`, message: '归属必须使用 concept_ids 数组，不能使用单个 concept_id' })
    }
    if (!Array.isArray(item.concept_ids)) {
      issues.push({ path: `${path}.concept_ids`, message: 'concept_ids 必须是数组（可包含多个 Concept）' })
      return
    }
    const seen = new Set<string>()
    item.concept_ids.forEach((rawConceptId, conceptIndex) => {
      const conceptId = typeof rawConceptId === 'string' ? rawConceptId.trim() : ''
      if (!conceptId) issues.push({ path: `${path}.concept_ids.${conceptIndex}`, message: 'Concept ID 必须是非空字符串' })
      else if (seen.has(conceptId)) issues.push({ path: `${path}.concept_ids.${conceptIndex}`, message: '同一归属声明中不能重复 Concept ID' })
      else if (conceptIds && !conceptIds.has(conceptId)) issues.push({ path: `${path}.concept_ids.${conceptIndex}`, message: 'Concept ID 不在当前目录中' })
      if (conceptId) seen.add(conceptId)
    })
  })
  return issues
}

/** Backward-compatible name for callers that describe these as assignments. */
export const validateConceptAssignments = validateConceptMemberships

export interface OriginConceptValidationOptions {
  targetIds?: Iterable<string>
  conceptIds?: Iterable<string>
  maxConcepts?: number
}

/**
 * Validate the direct Session/Message Concept extraction response.
 *
 * `client_ref` is deliberately scoped to one response: it lets memberships
 * and relations refer to a newly proposed Concept before persistence assigns
 * the database id. Existing task formats continue to use the generic
 * membership validator above.
 */
export function validateOriginConceptResult(
  value: unknown,
  options: OriginConceptValidationOptions = {},
): ValidationIssue[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ path: 'result', message: 'Concept 提取结果必须是 JSON 对象' }]
  }

  const result = value as Record<string, unknown>
  const rawConcepts = result.concepts
  const issues: ValidationIssue[] = []
  const candidateRefs = new Set<string>()
  const candidateNames = new Set<string>()
  const maxConcepts = normalizeConceptLimit(options.maxConcepts, DEFAULT_CONCEPT_LIMIT)

  if (!Array.isArray(rawConcepts)) {
    issues.push({ path: 'concepts', message: 'concepts 必须是数组' })
  } else {
    if (rawConcepts.length > maxConcepts) {
      issues.push({ path: 'concepts', message: `一次最多提取 ${maxConcepts} 个 Concept` })
    }
    rawConcepts.forEach((raw, index) => {
      const path = `concepts.${index}`
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push({ path, message: 'Concept 候选必须是对象' })
        return
      }
      const candidate = raw as Record<string, unknown>
      const clientRef = typeof candidate.client_ref === 'string' ? candidate.client_ref.trim() : ''
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
      const summary = typeof candidate.summary === 'string' ? candidate.summary.trim() : ''
      const clientRefNumber = /^new:(\d+)$/.exec(clientRef)?.[1]
      const validClientRef = clientRefNumber != null && Number(clientRefNumber) >= 1 && Number(clientRefNumber) <= maxConcepts
      if (!validClientRef) {
        issues.push({ path: `${path}.client_ref`, message: `client_ref 必须是 new:1 到 new:${maxConcepts}` })
      } else if (candidateRefs.has(clientRef)) {
        issues.push({ path: `${path}.client_ref`, message: 'client_ref 不能重复' })
      } else {
        candidateRefs.add(clientRef)
      }
      if (!name) {
        issues.push({ path: `${path}.name`, message: 'Concept 名称不能为空' })
      } else {
        const normalizedName = name.toLocaleLowerCase()
        if (candidateNames.has(normalizedName)) {
          issues.push({ path: `${path}.name`, message: '同一响应中不能重复 Concept 名称' })
        }
        candidateNames.add(normalizedName)
      }
      if (summary.length > 120) {
        issues.push({ path: `${path}.summary`, message: 'Concept 摘要不能超过 120 个字符' })
      }
      if (candidate.aliases != null && (!Array.isArray(candidate.aliases) || candidate.aliases.some((alias) => typeof alias !== 'string'))) {
        issues.push({ path: `${path}.aliases`, message: 'aliases 必须是字符串数组' })
      }
    })
  }

  const conceptIds = new Set<string>(options.conceptIds ?? [])
  candidateRefs.forEach((clientRef) => conceptIds.add(clientRef))
  issues.push(...validateConceptMemberships(result.memberships, {
    targetIds: options.targetIds,
    targetTypes: ['session', 'message'],
    conceptIds,
  }))

  const referencedCandidates = new Set<string>()
  if (Array.isArray(result.memberships)) {
    result.memberships.forEach((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
      const membership = raw as Record<string, unknown>
      if (membership.target_type !== 'message' || !Array.isArray(membership.concept_ids)) return
      membership.concept_ids.forEach((ref) => {
        if (typeof ref === 'string' && candidateRefs.has(ref.trim())) referencedCandidates.add(ref.trim())
      })
    })
  }
  candidateRefs.forEach((clientRef) => {
    if (!referencedCandidates.has(clientRef)) {
      issues.push({ path: 'memberships', message: `${clientRef} 必须至少归属于一条 Message` })
    }
  })

  const rawRelations = result.relations
  if (rawRelations != null && !Array.isArray(rawRelations)) {
    issues.push({ path: 'relations', message: 'relations 必须是数组' })
  } else if (Array.isArray(rawRelations)) {
    rawRelations.forEach((raw, index) => {
      const path = `relations.${index}`
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push({ path, message: '关系必须是对象' })
        return
      }
      const relation = raw as Record<string, unknown>
      const source = typeof relation.source === 'string' ? relation.source.trim() : ''
      const target = typeof relation.target === 'string' ? relation.target.trim() : ''
      const type = relation.type
      const status = relation.status
      if (!source || !conceptIds.has(source)) issues.push({ path: `${path}.source`, message: '关系 source 必须引用已披露 Concept 或 client_ref' })
      if (!target || !conceptIds.has(target)) issues.push({ path: `${path}.target`, message: '关系 target 必须引用已披露 Concept 或 client_ref' })
      if (source && source === target) issues.push({ path, message: '关系两端不能是同一个 Concept' })
      // Ordinary extraction may only propose hierarchy. Related edges are
      // derived from shared Session/Message evidence and are edited through
      // the maintenance action API instead.
      if (type !== 'hierarchy') issues.push({ path: `${path}.type`, message: '普通提取关系只能是 hierarchy；related 由共享 Session/Message 自动计算' })
      if (status != null && status !== 'proposed') issues.push({ path: `${path}.status`, message: 'LLM 关系 status 只能省略或为 proposed' })
    })
  }

  if (candidateRefs.size === 0 && !Array.isArray(result.memberships)) {
    issues.push({ path: 'memberships', message: '至少需要声明 Concept 归属' })
  }
  return issues
}

/** Validate a top-level many-to-many Concept ID list. */
export function validateConceptIdList(value: unknown, availableConceptIds?: Iterable<string>): ValidationIssue[] {
  if (value == null) return []
  if (!Array.isArray(value)) return [{ path: 'concept_ids', message: 'concept_ids 必须是数组（可包含多个 Concept）' }]
  const available = availableConceptIds ? new Set(availableConceptIds) : null
  const seen = new Set<string>()
  const issues: ValidationIssue[] = []
  value.forEach((raw, index) => {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id) issues.push({ path: `concept_ids.${index}`, message: 'Concept ID 必须是非空字符串' })
    else if (seen.has(id)) issues.push({ path: `concept_ids.${index}`, message: 'concept_ids 不能重复' })
    else if (available && !available.has(id)) issues.push({ path: `concept_ids.${index}`, message: 'Concept ID 不在当前目录中' })
    if (id) seen.add(id)
  })
  return issues
}

/** Validate optional progressive-disclosure continuation requests. */
export function validateDisclosureRequests(value: unknown, availableRefIds?: Iterable<string>): ValidationIssue[] {
  if (value == null) return []
  if (!Array.isArray(value)) return [{ path: 'disclosure_requests', message: '必须是数组' }]
  const available = availableRefIds ? new Set(availableRefIds) : null
  const seen = new Set<string>()
  const issues: ValidationIssue[] = []
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { issues.push({ path: 'disclosure_requests.' + index, message: '引用请求必须是对象' }); return }
    const item = raw as Record<string, unknown>
    const refID = typeof item.refID === 'string' ? item.refID.trim() : ''
    const depth = item.depth
    if (!refID) issues.push({ path: 'disclosure_requests.' + index + '.refID', message: 'refID 必须是非空字符串' })
    if (refID === 'DISCLOSURE_INDEX') issues.push({ path: 'disclosure_requests.' + index + '.refID', message: 'DISCLOSURE_INDEX 是目录标签，不是可请求的 refID' })
    if (!Number.isInteger(depth) || Number(depth) < 1 || Number(depth) > 64) issues.push({ path: 'disclosure_requests.' + index + '.depth', message: 'depth 必须是 1 到 64 的整数' })
    if (refID && seen.has(refID)) issues.push({ path: 'disclosure_requests.' + index + '.refID', message: '不能重复请求同一 refID' })
    if (refID) seen.add(refID)
    if (refID && available && !available.has(refID)) issues.push({ path: 'disclosure_requests.' + index + '.refID', message: 'refID 不在当前目录中' })
  })
  return issues
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
  requiredIndices?: number[],
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
  const expected = new Set(requiredIndices ?? Array.from({ length: messageCount }, (_, index) => index))
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
      if (!expected.has(index)) {
        issues.push({ path: `units.${unitIndex}.message_indices`, message: `索引 ${index} 不属于当前分块` })
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
    if (!expected.has(index)) {
      issues.push({ path: 'unassigned_message_indices', message: `索引 ${index} 不属于当前分块` })
    }
    if (seen.has(index)) {
      issues.push({ path: 'unassigned_message_indices', message: `索引 ${index} 已经被知识单元占用` })
    } else {
      seen.set(index, 'unassigned')
    }
  })

  for (const index of expected) {
    if (!seen.has(index)) issues.push({ path: 'unassigned_message_indices', message: `消息 ${index} 未被分配` })
  }
  if (issues.length) return { issues }
  return { data: { units: normalizedUnits, unassigned_message_indices: unassignedIndices }, issues: [] }
}
