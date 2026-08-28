// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import SearchSelect from '@/components/SearchSelect.vue'

const mounted: Array<ReturnType<typeof createApp>> = []

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount())
  document.body.innerHTML = ''
})

describe('SearchSelect', () => {
  it('cleans presentation markers, filters candidates and emits the chosen local id', async () => {
    const chosen: Array<string | null> = []
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = createApp(SearchSelect, {
      modelValue: null,
      options: [
        { value: 'c1', label: '## [[nexus:existing:RoCE]]RoCE[[/nexus]]', hint: '**传输协议**' },
        { value: 'c2', label: '拥塞控制', hint: 'ECN' },
      ],
      'onUpdate:modelValue': (value: string | null) => chosen.push(value),
    })
    mounted.push(app)
    app.mount(target)
    await nextTick()

    const trigger = target.querySelector<HTMLButtonElement>('.search-select-trigger')!
    trigger.focus()
    trigger.click()
    await nextTick()
    expect([...target.querySelectorAll('.search-select-option strong')].map((item) => item.textContent)).toEqual(['RoCE', '拥塞控制'])
    expect(target.textContent).not.toContain('[[nexus:')

    const input = target.querySelector<HTMLInputElement>('.search-select-input input')!
    expect(document.activeElement).toBe(input)
    input.value = 'ECN'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect([...target.querySelectorAll('.search-select-option strong')].map((item) => item.textContent)).toEqual(['拥塞控制'])
    target.querySelector<HTMLButtonElement>('.search-select-option')!.click()
    expect(chosen).toEqual(['c2'])
  })

  it('stays open while focus moves inside and closes when focus leaves', async () => {
    const target = document.createElement('div')
    const outside = document.createElement('button')
    document.body.append(target, outside)
    const app = createApp(SearchSelect, {
      modelValue: null,
      options: [{ value: 'c1', label: 'RoCE' }],
    })
    mounted.push(app)
    app.mount(target)
    await nextTick()

    const trigger = target.querySelector<HTMLButtonElement>('.search-select-trigger')!
    trigger.focus()
    trigger.click()
    await nextTick()

    expect(document.activeElement).toBe(target.querySelector('.search-select-input input'))
    expect(target.querySelector('.search-select-popover')).not.toBeNull()

    outside.focus()
    await nextTick()
    expect(target.querySelector('.search-select-popover')).toBeNull()
  })
})
