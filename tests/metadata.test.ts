import { describe, expect, it } from 'vitest'
import { parseMetadata } from '@/utils/metadata'

describe('message metadata', () => {
  it('accepts both parsed objects and JSON strings', () => {
    expect(parseMetadata({ taskId: 'task-1' }).taskId).toBe('task-1')
    expect(parseMetadata('{"taskId":"task-2"}').taskId).toBe('task-2')
  })

  it('returns an empty object for malformed or non-object metadata', () => {
    expect(parseMetadata('{bad')).toEqual({})
    expect(parseMetadata('[]')).toEqual({})
    expect(parseMetadata(null)).toEqual({})
  })
})
