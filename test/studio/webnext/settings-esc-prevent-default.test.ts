// @vitest-environment happy-dom
/**
 * SettingsModal Esc 消费面行为（happy-dom）。
 * （原 z-frontend-regressions 的 Z-23 节，按行为单拆。）
 *
 * Z-23（第五十八轮 Z 系列）：弹层 Esc 消费后 preventDefault——useHotkeys 的
 * defaultPrevented 让渡口生效（同一按键不再双效：关弹层 + 退专注）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const uiToastMock = vi.fn()
// ui mock 单例（组件与测试共享 settingsOpen 态）
const uiMock = {
  toast: uiToastMock,
  ask: vi.fn(async () => true),
  settingsOpen: false,
  closeSettings: vi.fn(),
  confirmState: null as unknown,
  // 遮罩单源判据（ui store 收编后 SettingsModal 的 Esc 让渡走此口）：false = 无其它弹层
  overlayOpenExcept: vi.fn(() => false),
  // R0916-7-P3-22：SettingsModal 遮罩走 ModalMask，挂载/卸载即登记
  setMaskOpen: vi.fn(),
}
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => uiMock),
  // ModalMask 渲染面从此表读浓度——mock 面补齐最小形状
  MASK_ALPHA: { palette: 0.25, settings: 0.45, export: 0.35, shelf: 0.35, confirm: 0.35, chapterMeta: 0.35, splitChapter: 0.35 },
}))
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import SettingsModal from '../../../src/studio/web-next/src/components/ui/SettingsModal.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('Z-23: 弹层 Esc 消费后 preventDefault', () => {
  it('SettingsModal 打开态按 Esc → closeSettings + preventDefault', async () => {
    const ui = useUiStore() as unknown as { settingsOpen: boolean; closeSettings: ReturnType<typeof vi.fn> }
    ui.settingsOpen = true
    ui.closeSettings.mockClear()
    const w = mount(SettingsModal, { props: { bookName: '书A' } })
    await nextTick()
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    window.dispatchEvent(ev)
    expect(ui.closeSettings).toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true) // 修复点：useHotkeys 让渡口可见
    w.unmount()
    ui.settingsOpen = false
  })
})
