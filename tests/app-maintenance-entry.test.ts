// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import App from '@/App.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const mounted: Array<ReturnType<typeof createApp>> = []

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
})

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount())
  document.body.innerHTML = ''
})

describe('full-graph maintenance entry', () => {
  it('is discoverable on a knowledge page and disappears with its panel on unrelated pages', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const pinia = createPinia()
    useWorkspaceStore(pinia).init = async () => undefined
    const app = createApp(App)
    app.use(pinia)
    mounted.push(app)
    app.mount(target)
    await nextTick()

    const navButton = (label: string) => [...target.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find((button) => button.textContent?.includes(label))

    navButton('知识主题')!.click()
    await nextTick()
    const entry = target.querySelector<HTMLButtonElement>('.concepts-view .maintenance-entry-button')
    expect(entry?.textContent).toContain('全图知识维护')

    entry!.click()
    await nextTick()
    expect(target.querySelector('.maintenance-panel')?.textContent).toContain('扫描整个知识图谱')
    expect(target.querySelector('.maintenance-panel')?.textContent).not.toContain('优先关注：')

    navButton('设置')!.click()
    await nextTick()
    expect(target.querySelector('.maintenance-entry-button')).toBeNull()
    expect(target.querySelector('.maintenance-panel')).toBeNull()
  })
})
