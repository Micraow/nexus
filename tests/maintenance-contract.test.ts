// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '@/stores/workspace'

describe('maintenance contract', () => {
  let store: ReturnType<typeof useWorkspaceStore>

  beforeEach(async () => {
    setActivePinia(createPinia())
    store = useWorkspaceStore()
    await store.init()
    store.clearAllData()
  })

  afterEach(() => {
    store.clearAllData()
  })

  it('rejects maintenance concept IDs that are outside the disclosed scope', () => {
    const scope = {
      conceptIds: new Set(['concept-visible']),
      sessionIds: new Set(['session-visible']),
      unitIds: new Set(['unit-visible']),
      messageIds: new Set(['message-visible']),
      relationIds: new Set<string>(),
      aliasIds: new Set<string>(),
    }
    const result = store.maintenanceSuggestionErrors({
      suggestions: [
        { type: 'unit_relink', unit_id: 'unit-visible', concept_ids: ['concept-hidden'], reason: '证据不匹配' },
        { type: 'unit_create', session_id: 'session-visible', message_ids: ['message-visible'], concept_ids: ['concept-hidden'], reason: '消息属于另一主题' },
      ],
    }, undefined, scope)

    expect(result.errors).toEqual(expect.arrayContaining([
      'suggestions.0.concept_ids: Concept ID 不在当前披露范围中',
      'suggestions.1.concept_ids: Concept ID 不在当前披露范围中',
    ]))
  })

  it('rejects undisclosed hierarchy parents', () => {
    const scope = {
      conceptIds: new Set(['concept-visible']),
      sessionIds: new Set<string>(),
      unitIds: new Set<string>(),
      messageIds: new Set<string>(),
      relationIds: new Set<string>(),
      aliasIds: new Set<string>(),
    }
    const result = store.maintenanceSuggestionErrors({
      suggestions: [
        { type: 'move_concept', concept_id: 'concept-visible', parent_concept_id: 'concept-hidden', reason: '层级证据' },
        { type: 'set_hierarchy_parents', concept_id: 'concept-visible', parent_concept_ids: ['concept-hidden'], reason: '层级证据' },
      ],
    }, undefined, scope)

    expect(result.errors).toEqual(expect.arrayContaining([
      'suggestions.0.parent_concept_id: Concept ID 不在当前披露范围中',
      'suggestions.1.parent_concept_ids: Concept ID 不在当前披露范围中',
    ]))
  })

  it('requires an explicit empty suggestions array for a maintenance disclosure round', () => {
    const rootId = store.createConcept('披露根主题')
    const taskId = store.createMaintenanceTask()

    const result = store.applyTaskResult(taskId, JSON.stringify({
      reason: '首轮只请求展开根主题。',
      disclosure_requests: [{ refID: rootId, depth: 1 }],
    }))

    expect(result.ok).toBe(false)
    expect(result.continued).toBeUndefined()
    expect(result.errors[0]).toContain('suggestions: []')
    expect(store.tasks.find((task) => task.id === taskId)).toEqual(expect.objectContaining({ status: 'needs_review' }))
  })

  it('requires a non-empty reason for a maintenance disclosure round', () => {
    const rootId = store.createConcept('披露根主题')
    const taskId = store.createMaintenanceTask()

    const result = store.applyTaskResult(taskId, JSON.stringify({
      suggestions: [],
      disclosure_requests: [{ refID: rootId, depth: 1 }],
    }))

    expect(result.ok).toBe(false)
    expect(result.continued).toBeUndefined()
    expect(result.errors[0]).toContain('reason 必须是非空字符串')
    expect(store.tasks.find((task) => task.id === taskId)).toEqual(expect.objectContaining({ status: 'needs_review' }))
  })
})
