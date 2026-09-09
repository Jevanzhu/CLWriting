// @vitest-environment happy-dom
/**
 * R8C-F1（2026-09-09 修复批）回归：Esc 让渡链「捕获层先行消费」不双关设置弹窗。
 *
 * 修复前：ConfirmPrompt 在 document capture 期消费 Esc（preventDefault +
 * resolveConfirm(false)），SettingsModal 的 window bubble 期处理器随后执行时
 * confirmState 已被同键清空——旧守卫 `if (ui.confirmState) return` 恰好失效 →
 * 一次 Esc 把确认框与设置弹窗双关。修复：SettingsModal 处理器首行短路
 * defaultPrevented（上层已消费即让渡，让渡链各层间的通用判据，对齐 Z-23 语义）。
 *
 * 手法：真实 pinia ui store（不 mock ui——双关状态流转必须在真 store 上可观察）；
 * 挂载序 = 层级序（ConfirmPrompt 先挂 → capture 先注册，SettingsModal 后挂 →
 * window bubble）；tab 子组件全 stub（r34d 同款清单）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => ({ bookName: '书A' })),
}))

import ConfirmPrompt from '../../../src/studio/web-next/src/components/ui/ConfirmPrompt.vue'
import SettingsModal from '../../../src/studio/web-next/src/components/ui/SettingsModal.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

const TAB_STUBS = {
  SettingsAppearance: true, SettingsEditor: true, SettingsWriting: true, SettingsAi: true,
  SettingsAnalysis: true, SettingsRetention: true, SettingsBook: true, AiServicePanel: true,
  BetaBadge: true,
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

function pressEsc(): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  document.dispatchEvent(e)
  return e
}

describe('R8C-F1: Esc 双关封堵（确认框在上时设置弹窗不连带关）', () => {
  it('确认框打开 → Esc 由确认框消费（capture），设置弹窗保持打开', async () => {
    const ui = useUiStore()
    // 挂载序 = 浮层层级序：确认框先（capture 先注册）→ 设置弹窗后（window bubble）
    const cw = mount(ConfirmPrompt, { attachTo: document.body })
    const sw = mount(SettingsModal, { global: { stubs: TAB_STUBS } })
    ui.openSettings()
    expect(ui.settingsOpen).toBe(true)
    const p = ui.ask({ title: '删除章节', message: '确认？', danger: true })
    expect(ui.confirmState).not.toBeNull()

    const e = pressEsc()
    expect(e.defaultPrevented).toBe(true) // 全局层 defaultPrevented 让渡链成立（capture 消费）
    await expect(p).resolves.toBe(false) // 确认框按取消收口
    expect(ui.confirmState).toBeNull()
    // 修复点：bubble 期处理器见 defaultPrevented 即让渡——一次 Esc 不双关
    //（修复前 confirmState 已被同键清空、旧守卫失效 → settingsOpen 此处为 false）
    expect(ui.settingsOpen).toBe(true)
    cw.unmount()
    sw.unmount()
  })

  it('无确认框 → Esc 照常关闭设置弹窗（本层消费语义保留）', async () => {
    const ui = useUiStore()
    const cw = mount(ConfirmPrompt, { attachTo: document.body })
    const sw = mount(SettingsModal, { global: { stubs: TAB_STUBS } })
    ui.openSettings()

    const e = pressEsc()
    expect(e.defaultPrevented).toBe(true) // 设置弹窗本层消费
    expect(ui.settingsOpen).toBe(false)
    cw.unmount()
    sw.unmount()
  })
})