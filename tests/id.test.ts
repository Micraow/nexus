import { describe, expect, it } from 'vitest'
import { normalizeText, parseIsoTimestamp } from '@/utils/id'

describe('text utilities', () => {
  it('normalizes unicode, punctuation, whitespace, and English case for matching', () => {
    expect(normalizeText('  rdma　拥塞控制！  ')).toBe('RDMA 拥塞控制!')
    expect(normalizeText('ＡＢＣ')).toBe('ABC')
  })

  it('keeps invalid source timestamps null and serializes valid ones as UTC ISO', () => {
    expect(parseIsoTimestamp('not-a-date')).toBeNull()
    expect(parseIsoTimestamp('2026-08-24T10:00:00+08:00')).toBe('2026-08-24T02:00:00.000Z')
  })
})
