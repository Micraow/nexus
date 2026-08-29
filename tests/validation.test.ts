import { describe, expect, it } from 'vitest'
import { normalizeOriginConceptResultForReuse, parseImportPayload, validateConceptIdList, validateConceptMemberships, validateConceptName, validateDisclosureRequests, validateOriginConceptResult, validateSegmentationResult, validateUnitText } from '@/services/validation'

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
    const reserved = validateDisclosureRequests([{ refID: 'DISCLOSURE_INDEX', depth: 1 }])
    expect(reserved.some((issue) => issue.message.includes('目录标签'))).toBe(true)
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
  it('rejects unsupported compound titles but accepts evidenced fixed technical names', () => {
    expect(validateConceptName('DRE 拥塞测量')).toHaveLength(0)
    expect(validateConceptName('CAVER 与 CONGA、MP-RDMA 等负载均衡方案对比').some((issue) => issue.message.includes('单一主题'))).toBe(true)
    expect(validateConceptName('和声编码')).toHaveLength(0)
    expect(validateConceptName('与门逻辑')).toHaveLength(0)
    expect(validateConceptName('拥塞控制 与 流量整形').some((issue) => issue.message.includes('单一主题'))).toBe(true)
    expect(validateConceptName('PFC 与 ECN 控制', { allowCompoundWithEvidence: true, confidence: 0.92, reason: '该名称是资料中固定使用的联合协议栈术语，整体作为一个章节主题。' })).toHaveLength(0)
    expect(validateConceptName('PFC 与 ECN 控制', { allowCompoundWithEvidence: true, confidence: 0.92 })).toHaveLength(1)
    expect(validateConceptName('超长知识主题'.repeat(5)).some((issue) => issue.message.includes('24'))).toBe(true)
  })

  it('requires disclosed prefix parents instead of creating another root', () => {
    const base = {
      concepts: [{ client_ref: 'new:1', name: 'CAVER 路径信息交换', summary: '交换路径状态。', aliases: [] }],
      memberships: [{ target_type: 'message', target_id: 'm1', concept_ids: ['new:1'] }],
    }
    const options = { targetIds: ['m1'], conceptIds: ['caver'], conceptCatalog: [{ id: 'caver', name: 'CAVER' }] }
    const missingParent = validateOriginConceptResult({ ...base, relations: [] }, options)
    expect(missingParent.some((issue) => issue.message.includes('不能另建一级根'))).toBe(true)

    const valid = validateOriginConceptResult({ ...base, relations: [{ source: 'caver', target: 'new:1', type: 'hierarchy' }] }, options)
    expect(valid).toHaveLength(0)
  })

  it('requires exact disclosed matches to reuse their existing IDs', () => {
    const issues = validateOriginConceptResult({
      concepts: [{ client_ref: 'new:1', name: 'CAVER', summary: '重复主题。', aliases: [] }],
      memberships: [{ target_type: 'message', target_id: 'm1', concept_ids: ['new:1'] }],
      relations: [],
    }, { targetIds: ['m1'], conceptIds: ['caver'], conceptCatalog: [{ id: 'caver', name: 'CAVER' }] })
    expect(issues.some((issue) => issue.message.includes('必须复用 Concept ID caver'))).toBe(true)
  })

  it('repairs exact duplicate Concepts into disclosed IDs without merging near matches', () => {
    const repaired = normalizeOriginConceptResultForReuse({
      concepts: [
        { client_ref: 'new:1', name: 'CAVER', summary: '重复主题。', aliases: [] },
        { client_ref: 'new:2', name: 'CAVER 路径选择', summary: '新的子主题。', aliases: [] },
      ],
      concept_ids: ['new:1', 'new:2'],
      memberships: [{ target_type: 'message', target_id: 'm1', concept_ids: ['new:1', 'new:2'] }],
      relations: [{ source: 'new:1', target: 'new:2', type: 'hierarchy' }],
    }, [{ id: 'caver', name: 'CAVER', aliases: ['CAVER 网络'] }])
    expect(repaired.reused).toEqual([{ client_ref: 'new:1', concept_id: 'caver', name: 'CAVER', matched_by: 'name' }])
    expect(repaired.data.concepts).toEqual([{ client_ref: 'new:2', name: 'CAVER 路径选择', summary: '新的子主题。', aliases: [] }])
    expect(repaired.data.concept_ids).toEqual(['caver', 'new:2'])
    expect(repaired.data.memberships).toEqual([{ target_type: 'message', target_id: 'm1', concept_ids: ['caver', 'new:2'] }])
    expect(repaired.data.relations).toEqual([{ source: 'caver', target: 'new:2', type: 'hierarchy' }])
    const near = normalizeOriginConceptResultForReuse({ concepts: [{ client_ref: 'new:1', name: 'CAVERX', summary: '', aliases: [] }] }, [{ id: 'caver', name: 'CAVER' }])
    expect(near.reused).toHaveLength(0)
    expect(near.data.concepts).toHaveLength(1)
  })

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

  it('only permits proposed LLM relation status', () => {
    const invalid = validateOriginConceptResult({
      concepts: [{ client_ref: 'new:1', name: 'TCP 拥塞控制', summary: '', aliases: [] }],
      memberships: [{ target_type: 'message', target_id: 'm1', concept_ids: ['new:1'] }],
      relations: [{ source: 'existing-network', target: 'new:1', type: 'hierarchy', status: 'confirmed' }],
    }, { targetIds: ['m1'], conceptIds: ['existing-network'] })

    expect(invalid.some((issue) => issue.message.includes('只能省略或为 proposed'))).toBe(true)
  })

  it('enforces the configured Concept limit and client refs', () => {
    const invalid = validateOriginConceptResult({
      concepts: [1, 2, 3].map((index) => ({ client_ref: `new:${index}`, name: `主题${index}`, summary: '', aliases: [] })),
      memberships: [{ target_type: 'message', target_id: 'm1', concept_ids: ['new:1', 'new:2', 'new:3'] }],
    }, { targetIds: ['m1'], maxConcepts: 2 })
    expect(invalid.some((issue) => issue.message.includes('一次最多提取 2 个 Concept'))).toBe(true)
    expect(invalid.some((issue) => issue.message.includes('new:1 到 new:2'))).toBe(true)
  })
})
