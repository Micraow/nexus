import { describe, expect, it } from 'vitest'
import { parseImportPayload, validateSegmentationResult, validateUnitText } from '@/services/validation'

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
})
