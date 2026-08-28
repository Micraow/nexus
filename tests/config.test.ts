// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_API_CONCURRENCY,
  DEFAULT_CONCEPT_LIMIT,
  DEFAULT_TOKEN_BUDGET,
  MAX_API_CONCURRENCY,
  MAX_CONCEPT_LIMIT,
  MIN_API_CONCURRENCY,
  MIN_CONCEPT_LIMIT,
  MIN_TOKEN_BUDGET,
  normalizeApiConcurrency,
  normalizeConceptLimit,
  normalizeTokenBudget,
  parseConfig,
  parseConfigText,
  readConfigText,
  serializeConfig,
  writeConfig,
} from '@/services/config'
import type { AppConfig } from '@/types/domain'

const config: AppConfig = {
  llm: {
    mode: 'prompt_paste',
    defaultProvider: null,
    concurrency: 2,
    conceptLimit: 12,
    tokenBudget: 32_000,
    providers: [],
    taskOverrides: {},
  },
  prompts: { overrideDir: '' },
  ui: {
    theme: 'system',
    reducedMotion: false,
    fontFamily: 'system-sans',
    fontSize: 15,
    graph: { showUnits: false, showMessages: false, showProposed: false, showRetainedSessions: false },
  },
  storage: { databasePath: '' },
}

const storedValues = new Map<string, string>()
const localStorageStub = {
  clear: () => storedValues.clear(),
  getItem: (key: string) => storedValues.get(key) ?? null,
  key: (index: number) => [...storedValues.keys()][index] ?? null,
  removeItem: (key: string) => storedValues.delete(key),
  setItem: (key: string, value: string) => storedValues.set(key, value),
  get length() { return storedValues.size },
} satisfies Storage

describe('token budget config', () => {
  beforeEach(() => {
    storedValues.clear()
    vi.stubGlobal('localStorage', localStorageStub)
  })

  it('normalizes manual and config values to the supported integer range', () => {
    expect(normalizeTokenBudget('24000')).toBe(24_000)
    expect(normalizeTokenBudget(12_345.6)).toBe(12_346)
    expect(normalizeTokenBudget(10)).toBe(MIN_TOKEN_BUDGET)
    expect(normalizeTokenBudget(Number.MAX_SAFE_INTEGER + 1_000)).toBe(Number.MAX_SAFE_INTEGER)
    expect(normalizeTokenBudget('')).toBe(DEFAULT_TOKEN_BUDGET)
    expect(normalizeTokenBudget('invalid', 16_000)).toBe(16_000)
  })

  it('accepts snake_case and legacy camelCase config keys', () => {
    expect(parseConfig({ llm: { token_budget: 48_000 } }).llm?.tokenBudget).toBe(48_000)
    expect(parseConfig({ llm: { tokenBudget: 64_000 } }).llm?.tokenBudget).toBe(64_000)
  })

  it('serializes and persists the manually selected value', async () => {
    const yaml = serializeConfig(config)
    expect(yaml).toContain('token_budget: 32000')
    expect(parseConfigText(yaml).llm?.tokenBudget).toBe(32_000)

    writeConfig(config)
    const stored = await readConfigText()
    expect(stored).not.toBeNull()
    expect(parseConfigText(stored!).llm?.tokenBudget).toBe(32_000)
  })
})

describe('Concept limit and API concurrency config', () => {
  it('normalizes manual values to their configured bounds', () => {
    expect(normalizeConceptLimit(12)).toBe(12)
    expect(normalizeConceptLimit(0)).toBe(MIN_CONCEPT_LIMIT)
    expect(normalizeConceptLimit(999)).toBe(MAX_CONCEPT_LIMIT)
    expect(normalizeConceptLimit('invalid')).toBe(DEFAULT_CONCEPT_LIMIT)
    expect(normalizeApiConcurrency(7)).toBe(7)
    expect(normalizeApiConcurrency(0)).toBe(MIN_API_CONCURRENCY)
    expect(normalizeApiConcurrency(999)).toBe(MAX_API_CONCURRENCY)
    expect(normalizeApiConcurrency('invalid')).toBe(DEFAULT_API_CONCURRENCY)
  })

  it('accepts and serializes both config key styles', () => {
    expect(parseConfig({ llm: { concept_limit: 11, concurrency: 9 } }).llm?.conceptLimit).toBe(11)
    expect(parseConfig({ llm: { conceptLimit: 13 } }).llm?.conceptLimit).toBe(13)
    const yaml = serializeConfig(config)
    expect(yaml).toContain('concept_limit: 12')
    expect(parseConfigText(yaml).llm?.conceptLimit).toBe(12)
  })
})
