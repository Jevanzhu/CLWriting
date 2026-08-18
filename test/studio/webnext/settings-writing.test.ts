// @vitest-environment happy-dom
/**
 * SettingsWriting（「设置 · 写作默认」全局页）交互测试：
 * 4 控件（题材/每卷章数/目标字数/每章字数）直写 prefs store（clamp 在 store setter，防抖落 global.json），
 * 不触发 saveConfig（book.yaml 不动）。IA 重组前这些断言在 settings-book.test.ts（书籍与目标子页的全局默认组）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsWriting from '../../../src/studio/web-next/src/components/ui/SettingsWriting.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

const mocks = vi.hoisted(() => ({
  saveConfig: vi.fn(),
}))

/** 全局页不依赖当前书：mount 即展示（无需打开设置/书）。 */
function mountPage(): ReturnType<typeof mount> {
  return mount(SettingsWriting, {
    global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('SettingsWriting 写作默认全局默认（直写 prefs store）', () => {
  it('题材输入写 prefs.defaultGenre；不触发 saveConfig', async () => {
    const wrapper = mountPage()
    const input = wrapper.find('input[aria-label="题材（全局默认）"]')
    await input.setValue('  都市  ')
    expect(usePrefsStore().defaultGenre).toBe('都市')
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('每卷章数 clamp 5-500 写 prefs.defaultVolumeSize', async () => {
    const wrapper = mountPage()
    const input = wrapper.find('input[aria-label="每卷章数（全局默认）"]')
    await input.setValue('3')
    expect(usePrefsStore().defaultVolumeSize).toBe(5)
    await input.setValue('999')
    expect(usePrefsStore().defaultVolumeSize).toBe(500)
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('目标字数/每章字数 0=未设 语义直写 prefs', async () => {
    const wrapper = mountPage()
    await wrapper.find('input[aria-label="目标字数（全局默认）"]').setValue('0')
    await wrapper.find('input[aria-label="每章字数（全局默认）"]').setValue('3000')
    const prefs = usePrefsStore()
    expect(prefs.defaultTargetWords).toBe(0)
    expect(prefs.defaultChapterTargetWords).toBe(3000)
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('store 初值即硬编码回落（每卷 50 章 / 目标 0 / 每章 0）', () => {
    mountPage()
    const prefs = usePrefsStore()
    expect(prefs.defaultGenre).toBe('')
    expect(prefs.defaultVolumeSize).toBe(50)
    expect(prefs.defaultTargetWords).toBe(0)
    expect(prefs.defaultChapterTargetWords).toBe(0)
  })
})
