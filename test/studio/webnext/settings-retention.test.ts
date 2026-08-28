// @vitest-environment happy-dom
/**
 * SettingsRetention（「设置 · 版本保留」全局页）交互测试：
 * 2 控件（保留天数/保留数量）clamp 1-365 / 1-200 后直写 prefs store（防抖落 global.json），
 * 不触发 saveConfig。IA 重组前这些控件在 SettingsHistory（「本书」页版本与定稿子页的全局默认组）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsRetention from '../../../src/studio/web-next/src/components/ui/SettingsRetention.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

const mocks = vi.hoisted(() => ({
  saveConfig: vi.fn(),
}))

/** 全局页不依赖当前书：mount 即展示（无需打开设置/书）。 */
function mountPage(): ReturnType<typeof mount> {
  return mount(SettingsRetention, {
    global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('SettingsRetention 版本保留全局默认（直写 prefs store）', () => {
  it('保留天数 clamp 1-365 写 prefs.snapDays；不触发 saveConfig', async () => {
    const wrapper = mountPage()
    const input = wrapper.find('input[aria-label="保留天数（全局默认）"]')
    await input.setValue('0')
    expect(usePrefsStore().snapDays).toBe(1)
    await input.setValue('999')
    expect(usePrefsStore().snapDays).toBe(365)
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('保留数量 clamp 1-200 写 prefs.snapCount', async () => {
    const wrapper = mountPage()
    await wrapper.find('input[aria-label="保留数量（全局默认）"]').setValue('500')
    expect(usePrefsStore().snapCount).toBe(200)
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('清空输入（空串）按 0 参与钳制 → 写最小值（沿用原 SettingsHistory 行为）', async () => {
    const wrapper = mountPage()
    // R72-11（二十轮 E-1/E-2）：空串不再写 store——Number('')=0 恰好过 isFinite 闸被
    // clamp 成下限 1 是已修复的 bug（清空输入框不应改值），此处断言值保持不变
    const before = usePrefsStore().snapDays
    await wrapper.find('input[aria-label="保留天数（全局默认）"]').setValue('')
    expect(usePrefsStore().snapDays).toBe(before)
  })
})
