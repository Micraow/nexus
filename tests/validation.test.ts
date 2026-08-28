import { describe, expect, it } from 'vitest'
import { parseImportPayload, validateConceptIdList, validateConceptMemberships, validateDisclosureRequests, validateOriginConceptResult, validateSegmentationResult, validateUnitText } from '@/services/validation'

describe('import validation', () => {
  it('accepts the documented DeepSeek payload and rejects unsupported roles', () => {
    const valid = parseImportPayload({
      schema_version: 1,
      platform: 'deepseek',
      conversations: [{ external_session_id: 'session-1', messages: [{ role: 'user', content: 'hello' }] }],
    })
    expect(valid.data?.platform).toBe('deepseek')

    const invalid = parseImportPayload({
      schema_version: 1,
      platform: 'deepseek',
      conversations: [{ messages: [{ role: 'tool', content: 'not a message' }] }],
    })
    expect(invalid.data).toBeUndefined()
    expect(invalid.issues[0]?.path).toContain('role')
  })

  it('requires segmentation output to cover every message exactly once', () => {
    const valid = validateSegmentationResult({ units: [{ message_indices: [0, 1], title_hint: '主题' }], unassigned_message_indices: [2] }, 3)
    expect(valid.issues).toHaveLength(0)

    const duplicate = validateSegmentationResult({ units: [{ message_indices: [0, 1] }, { message_indices: [1, 2] }], unassigned_message_indices: [] }, 3)
    expect(duplicate.data).toBeUndefined()
    expect(duplicate.issues.some((issue) => issue.message.includes('重复'))).toBe(true)

    const omitted = validateSegmentationResult({ units: [{ message_indices: [0] }], unassigned_message_indices: [] }, 2)
    expect(omitted.data).toBeUndefined()
    expect(omitted.issues.some((issue) => issue.message.includes('未被分配'))).toBe(true)
  })

  it('enforces title and summary limits without silently truncating', () => {
    expect(validateUnitText('a'.repeat(30), 'b'.repeat(120))).toHaveLength(0)
    expect(validateUnitText('a'.repeat(31), 'b'.repeat(121))).toHaveLength(2)
  })

  it('validates progressive-disclosure continuation requests against visible refs', () => {
    expect(validateDisclosureRequests([{ refID: 'concept-1', depth: 2 }], ['concept-1'])).toHaveLength(0)

    const invalid = validateDisclosureRequests([
      { refID: 'missing', depth: 0 },
      { refID: 'missing', depth: 1 },
    ], ['concept-1'])
    expect(invalid.some((issue) => issue.message.includes('不在当前目录'))).toBe(true)
    expect(invalid.some((issue) => issue.message.includes('1 到 64'))).toBe(true)
    expect(invalid.some((issue) => issue.message.includes('不能重复'))).toBe(true)
  })

  it('validates multi-Concept membership lists and keeps duplicate/unknown IDs visible', () => {
    expect(validateConceptIdList(['c1', 'c2'], ['c1', 'c2'])).toHaveLength(0)
    const listIssues = validateConceptIdList(['c1', 'c1', 'missing'], ['c1', 'c2'])
    expect(listIssues.some((issue) => issue.message.includes('不能重复'))).toBe(true)
    expect(listIssues.some((issue) => issue.message.includes('不在当前目录'))).toBe(true)

    const valid = validateConceptMemberships([
      { target_type: 'message', target_id: 'm1', concept_ids: ['c1', 'c2'] },
      { target_type: 'session', target_id: 's1', concept_ids: [] },
    ], { targetIds: ['m1', 's1'], conceptIds: ['c1', 'c2'] })
    expect(valid).toHaveLength(0)
    const invalid = validateConceptMemberships([{ target_type: 'message', target_id: 'm1', concept_ids: ['c1', 'c1', 'missing'] }], { targetIds: ['m1'], conceptIds: ['c1'] })
    expect(invalid.some((issue) => issue.message.includes('不能重复'))).toBe(true)
    expect(invalid.some((issue) => issue.message.includes('不在当前目录'))).toBe(true)
    expect(validateConceptMemberships([{ target_type: 'message', target_id: 'm1', concept_id: 'c1' }], { targetIds: ['m1'], conceptIds: ['c1'] }).some((issue) => issue.message.includes('concept_ids'))).toBe(true)
  })
})

describe('direct origin Concept response validation', () => {
  it('validates response-local refs and Session/Message-only memberships', () => {
    const valid = validateOriginConceptResult({
      concepts: [{ client_ref: 'new:1', name: 'Clos 网络', summary: '多级、可扩展的互连拓扑', aliases: [] }],
      memberships: [
        { target_type: 'message', target_id: 'm1', concept_ids: ['new:1', 'existing-clos'] },
        { target_type: 'session', target_id: 's1', concept_ids: ['existing-clos'] },
      ],
      relations: [{ source: 'existing-clos', target: 'new:1', type: 'hierarchy' }],
    }, { targetIds: ['m1', 's1'], conceptIds: ['existing-clos'] })
    expect(valid).toHaveLength(0)

    const invalid = validateOriginConceptResult({
      concepts: [{ client_ref: 'new:1', name: 'Clos 网络', summary: '' }],
      memberships: [
        { target_type: 'unit', target_id: 'u1', concept_ids: ['new:1'] },
      ],
      relations: [{ source: 'new:1', target: 'missing', type: 'related' }],
    }, { targetIds: ['u1'], conceptIds: [] })
    expect(invalid.some((issue) => issue.message.includes('当前任务不允许 unit'))).toBe(true)
    expect(invalid.some((issue) => issue.message.includes('关系 target'))).toBe(true)
    expect(invalid.some((issue) => issue.message.includes('普通 Concept 提取只允许 hierarchy'))).toBe(true)
    expect(invalid.some((issue) => issue.message.includes('至少归属于一条 Message'))).toBe(true)
  })
})
