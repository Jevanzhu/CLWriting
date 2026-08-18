// @vitest-environment happy-dom
/**
 * SettingsAi（「设置 · AI 写作」全局页）交互测试：
 * AI 对话（对话助手）+ AI 写作全局默认（文风注入/自动确认细纲/批量章数/单章上限）直写 prefs store
 * （clamp 在 store setter，防抖落 global.json），不触发 saveConfig。
 * IA 重组后本书覆盖组拆到 SettingsBookAi（「本书」页），其断言在 settings-book-ai.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsAi from '../../../src/studio/web-next/src/components/ui/SettingsAi.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

const mocks = vi.hoisted(() => ({
  saveConfig: vi.fn(),
}))

/** 全局页不依赖当前书：mount 即展示（无需打开设置/书）。 */
function mountPage(): ReturnType<typeof mount> {
  return mount(SettingsAi, {
    global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('SettingsAi AI 对话（直写 prefs store）', () => {
  it('对话助手开关 → prefs.chatEnabled', async () => {
    const wrapper = mountPage()
    await wrapper.find('input[aria-label="对话助手"]').setValue(true)
    expect(usePrefsStore().chatEnabled).toBe(true)
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })
})

describe('SettingsAi AI 写作全局默认（直写 prefs store）', () => {
  it('文风注入 seg → prefs.styleInjection', async () => {
    const wrapper = mountPage()
    // 本页唯一一个 seg（文风注入）
    const segBtns = wrapper.findAll('.seg').at(0)!.findAll('button')
    expect(segBtns).toHaveLength(2)
    await segBtns[1]!.trigger('click') // 点「重」
    expect(usePrefsStore().styleInjection).toBe('heavy')
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('自动确认细纲开关 → prefs.autoConfirmOutline', async () => {
    const wrapper = mountPage()
    await wrapper.find('input[aria-label="自动确认细纲（全局默认）"]').setValue(true)
    expect(usePrefsStore().autoConfirmOutline).toBe(true)
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('批量章数/单章上限 clamp 后写 prefs（1-20 / 1-50）', async () => {
    const wrapper = mountPage()
    await wrapper.find('input[aria-label="批量写作章数（全局默认）"]').setValue('99')
    await wrapper.find('input[aria-label="单章调用上限（全局默认）"]').setValue('0')
    const prefs = usePrefsStore()
    expect(prefs.aiBatchSize).toBe(20)
    expect(prefs.callsPerChapter).toBe(1)
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('store 初值即硬编码回落（批量 8 / 上限 8 / 轻 / 关）', async () => {
    mountPage()
    const prefs = usePrefsStore()
    expect(prefs.aiBatchSize).toBe(8)
    expect(prefs.callsPerChapter).toBe(8)
    expect(prefs.styleInjection).toBe('light')
    expect(prefs.autoConfirmOutline).toBe(false)
  })

  it('全局页不含本书覆盖组（无「本书使用独立设定」开关）', async () => {
    const wrapper = mountPage()
    expect(wrapper.find('input[aria-label="本书使用独立设定"]').exists()).toBe(false)
    expect(wrapper.find('input[aria-label="批量写作章数"]').exists()).toBe(false)
  })
})
