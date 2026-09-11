// @vitest-environment happy-dom
/**
 * R0912-FE-P3-8（2026-09-11 重评-0911b 修复批）：Ribbon「书库管理」浏览器版静默无响应
 * 修复——原 openLibraryManager 只在 window.clwritingDesktop 存在时有行为，浏览器版点击
 * 零反馈。修复：else 分支 toast 交代「仅桌面版可用」（对齐 R33D-31「点击必须有响应」
 * 口径）。桌面 IPC 失败 toast 通道（R33D-31）一并回归锚定。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Ribbon from '../../../src/studio/web-next/src/components/shell/Ribbon.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
  // happy-dom 无 matchMedia 全实现，useTheme 动效面只读不触发（本测试不点主题钮）
})

afterEach(() => {
  vi.restoreAllMocks()
  // 清掉桌面注入（用例间互不渗透——浏览器版用例必须以无 preload 起步）
  delete (window as { clwritingDesktop?: unknown }).clwritingDesktop
})

function mountRibbon() {
  const wrapper = mount(Ribbon)
  // Ribbon setup 时取的 useUiStore() 与此处为同一 pinia 实例的同一 store 代理——
  // 事后 spy 方法即可观察其调用
  const ui = useUiStore()
  const toastSpy = vi.spyOn(ui, 'toast')
  return { wrapper, toastSpy }
}

function libraryButton(wrapper: ReturnType<typeof mount>): ReturnType<typeof wrapper.find> {
  return wrapper.findAll('button').find((b) => b.attributes('data-tip') === '书库管理')!
}

describe('Ribbon 书库管理（R0912-FE-P3-8）', () => {
  it('浏览器版（无 clwritingDesktop）点击 → toast「仅桌面版可用」，不再静默', async () => {
    const { wrapper, toastSpy } = mountRibbon()
    await libraryButton(wrapper).trigger('click')
    expect(toastSpy).toHaveBeenCalledWith('书库管理仅桌面版可用', 'info')
    wrapper.unmount()
  })

  it('桌面版点击 → 走 openLibraryWindow IPC，不弹可用性提示', async () => {
    const openLibraryWindow = vi.fn().mockResolvedValue(undefined)
    ;(window as { clwritingDesktop?: unknown }).clwritingDesktop = { openLibraryWindow }
    const { wrapper, toastSpy } = mountRibbon()
    await libraryButton(wrapper).trigger('click')
    expect(openLibraryWindow).toHaveBeenCalledTimes(1)
    expect(toastSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('桌面版 IPC 失败 → friendlyError toast（R33D-31 通道回归锚）', async () => {
    ;(window as { clwritingDesktop?: unknown }).clwritingDesktop = {
      openLibraryWindow: vi.fn().mockRejectedValue(new Error('窗口创建失败')),
    }
    const { wrapper, toastSpy } = mountRibbon()
    await libraryButton(wrapper).trigger('click')
    await Promise.resolve()
    await Promise.resolve()
    expect(toastSpy).toHaveBeenCalledWith('窗口创建失败', 'error')
    wrapper.unmount()
  })
})
