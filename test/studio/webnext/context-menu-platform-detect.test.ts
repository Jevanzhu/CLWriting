// @vitest-environment happy-dom
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
import ContextMenu from '../../../src/studio/web-next/src/components/ui/ContextMenu.vue'

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
