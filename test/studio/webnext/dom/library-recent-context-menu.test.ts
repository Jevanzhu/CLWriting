/**
 * 书库管理页最近列表行右键菜单（happy-dom）：右击行 → 菜单含「在新窗口中打开」，
 * 选择后走 openLibraryInNewWindow(path)——与行内悬停按钮同链路；无原生菜单面
 * （showContextMenu 缺席）时回退自绘 ContextMenu 渲染同一项。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// 平台判定在 usePlatform 模块求值时快照 window.clwritingDesktop——mock 掉，
// 页面按桌面态渲染（否则整页落「书库管理仅在桌面版可用」分支，无最近列表可右键）
vi.mock('../../../../src/studio/web-next/src/composables/usePlatform', () => ({
  usePlatform: () => ({ isDesktop: true, platform: 'win32', isMac: false, isWin: true }),
}))

import Library from '../../../../src/studio/web-next/src/pages/Library.vue'
import type { MenuItem } from '../../../../src/studio/web-next/src/components/ui/ContextMenu.vue'

const CURRENT = '/libs/甲库'
const ROW = { path: '/libs/乙库', label: '乙库' }
const RECENTS = [ROW]

/** 桌面注入（最小面）——withNativeMenu=false 即 showContextMenu 缺席，
 *  useNativeMenu 判非原生、走自绘回退（浏览器/dev 形态）。 */
function installDesktop(opts: { withNativeMenu: boolean }) {
  const openLibraryInNewWindow = vi.fn().mockResolvedValue({ ok: true })
  const showContextMenu = vi.fn()
  const api: Record<string, unknown> = {
    getCurrentLibrary: vi.fn().mockResolvedValue(CURRENT),
    getRecentLibraries: vi.fn().mockResolvedValue(RECENTS),
    switchLibrary: vi.fn().mockResolvedValue({ ok: true }),
    openLibraryInNewWindow,
    openLibraryDir: vi.fn().mockResolvedValue(undefined),
  }
  if (opts.withNativeMenu) api.showContextMenu = showContextMenu
  ;(window as unknown as Record<string, unknown>).clwritingDesktop = api
  return { openLibraryInNewWindow, showContextMenu }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).clwritingDesktop
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('书库管理页：最近列表行右键菜单', () => {
  it('桌面原生路径：右击行 → 载荷含「在新窗口中打开」，选择 → IPC 到该行路径', async () => {
    const { openLibraryInNewWindow, showContextMenu } = installDesktop({ withNativeMenu: true })
    const wrapper = mount(Library, { attachTo: document.body })
    await flushPromises()
    const row = wrapper.find('li.recent-row')
    expect(row.exists()).toBe(true)

    await row.trigger('contextmenu')
    expect(showContextMenu).toHaveBeenCalledTimes(1)
    const [items, cb] = showContextMenu.mock.calls[0] as [MenuItem[], (key: string | null) => void]
    expect(items.some((i) => i.key === 'new-window' && i.label === '在新窗口中打开')).toBe(true)

    cb('new-window')
    await flushPromises()
    expect(openLibraryInNewWindow).toHaveBeenCalledWith(ROW.path)
    wrapper.unmount()
  })

  it('浏览器回退：无原生菜单面 → 自绘菜单渲染同项，点击 → 同链路 IPC', async () => {
    const { openLibraryInNewWindow, showContextMenu } = installDesktop({ withNativeMenu: false })
    const wrapper = mount(Library, { attachTo: document.body })
    await flushPromises()

    await wrapper.find('li.recent-row').trigger('contextmenu')
    await nextTick()
    expect(showContextMenu).not.toHaveBeenCalled()
    const item = document.querySelector<HTMLElement>('.cm-menu .cm-item')
    expect(item?.textContent ?? '').toContain('在新窗口中打开')

    item?.click()
    await flushPromises()
    expect(openLibraryInNewWindow).toHaveBeenCalledWith(ROW.path)
    wrapper.unmount()
  })
})
