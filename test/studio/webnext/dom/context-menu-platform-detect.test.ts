/**
 * ContextMenu 平台探测行为族（happy-dom）。
 * （原 r37-e-components 的 R37-35 节，按行为单拆。）
 *
 * R37-35（三十七轮批 E）：平台探测三级兜底（userAgentData → navigator.platform →
 * UA 串）——探测不再单源落空（修复前只读一个源，空值即误判非 mac）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ContextMenu from '../../../../src/studio/web-next/src/components/ui/ContextMenu.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('R37-35: 平台探测三级兜底（userAgentData → navigator.platform → UA）', () => {
  function stubNavigator(opts: { userAgentData?: string; platform?: string; userAgent?: string }): void {
    const nav = window.navigator as Navigator & { userAgentData?: { platform?: string } }
    if ('userAgentData' in nav) delete nav.userAgentData
    if (opts.userAgentData !== undefined) {
      Object.defineProperty(nav, 'userAgentData', {
        value: { platform: opts.userAgentData },
        configurable: true,
      })
    }
    Object.defineProperty(nav, 'platform', { value: opts.platform ?? '', configurable: true })
    Object.defineProperty(nav, 'userAgent', { value: opts.userAgent ?? '', configurable: true })
  }

  function mountMenu(): void {
    mount(ContextMenu, {
      props: {
        visible: true,
        x: 10,
        y: 10,
        items: [{ key: 'a', label: '动作', accelerator: 'CmdOrCtrl+S' }],
      },
      attachTo: document.body,
    })
  }

  afterEach(() => {
    document.body.innerHTML = ''
    stubNavigator({}) // 还原探测源（避免污染后续用例）
  })

  it('无 userAgentData（老 WebView/非 Chromium）+ navigator.platform=MacIntel → ⌘ 兜底命中', async () => {
    stubNavigator({ platform: 'MacIntel', userAgent: '' })
    mountMenu()
    await nextTick()
    expect(document.querySelector('.cm-shortcut')!.textContent).toContain('⌘')
  })

  it('无 userAgentData 且 platform 为空 → userAgent 字符串嗅探兜底（Mac → ⌘）', async () => {
    stubNavigator({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' })
    mountMenu()
    await nextTick()
    // 修复点：探测不再单源落空（修复前只读一个源，空值即误判非 mac）
    expect(document.querySelector('.cm-shortcut')!.textContent).toContain('⌘')
  })

  it('无 userAgentData + platform/userAgent 均 Windows → Ctrl+', async () => {
    stubNavigator({ platform: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' })
    mountMenu()
    await nextTick()
    expect(document.querySelector('.cm-shortcut')!.textContent).toContain('Ctrl+')
  })

  it('有 userAgentData 时以其为准（新 API 优先于 navigator.platform）', async () => {
    stubNavigator({ userAgentData: 'Windows', platform: 'MacIntel', userAgent: '' })
    mountMenu()
    await nextTick()
    expect(document.querySelector('.cm-shortcut')!.textContent).toContain('Ctrl+')
  })
})

describe('ContextMenu 夹边补全：翻转后仍溢出时落点夹进视口', () => {
  /** 挂一个关闭态菜单 → 装受控尺寸 → 开启（开启拍才测量）→ 返回菜单元素。 */
  async function openWithRect(
    rect: DOMRect,
    x: number,
    y: number,
  ): Promise<{ menu: HTMLElement; wrapper: ReturnType<typeof mount> }> {
    const { vi } = await import('vitest')
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect)
    const wrapper = mount(ContextMenu, {
      props: { visible: false, x, y, items: [{ key: 'a', label: '动作' }] },
      attachTo: document.body,
    })
    await wrapper.setProps({ visible: true })
    await nextTick()
    await nextTick()
    // 菜单经 Teleport 挂 body：取末个，避免上一用例残留元素干扰
    const menus = document.querySelectorAll('.cm-menu')
    spy.mockRestore()
    return { menu: menus[menus.length - 1] as HTMLElement, wrapper }
  }

  it('菜单宽于视口 → 不翻转且落点夹到左边距（此前翻转后仍探出屏外）', async () => {
    const { menu, wrapper } = await openWithRect(new DOMRect(0, 0, window.innerWidth, 40), 10, 10)
    expect(menu.classList.contains('flip-x')).toBe(false)
    expect(menu.style.getPropertyValue('--cm-x')).toBe('8px')
    wrapper.unmount()
  })

  it('贴右缘且左侧放得下 → 仍按翻转口径贴右（回归锚）', async () => {
    const vw = window.innerWidth
    const { menu, wrapper } = await openWithRect(new DOMRect(0, 0, 200, 40), vw - 20, 10)
    expect(menu.classList.contains('flip-x')).toBe(true)
    expect(menu.style.getPropertyValue('--cm-x')).toBe(String(vw - 20) + 'px')
    wrapper.unmount()
  })
})
