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

    target.querySelector<HTMLButtonElement>('.search-select-trigger')!.click()
    await nextTick()
    expect([...target.querySelectorAll('.search-select-option strong')].map((item) => item.textContent)).toEqual(['RoCE', '拥塞控制'])
    expect(target.textContent).not.toContain('[[nexus:')

    const input = target.querySelector<HTMLInputElement>('.search-select-input input')!
    input.value = 'ECN'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect([...target.querySelectorAll('.search-select-option strong')].map((item) => item.textContent)).toEqual(['拥塞控制'])
    target.querySelector<HTMLButtonElement>('.search-select-option')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(chosen).toEqual(['c2'])
  })
})
