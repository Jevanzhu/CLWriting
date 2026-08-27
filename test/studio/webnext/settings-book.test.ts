// @vitest-environment happy-dom
/**
 * SettingsBook（「设置 · 本书」单页，IA 重组后为父组件）交互测试：
 * - 书名全量改名：书名改动 → renameBook API（目录+登记+active 一起搬），renamed=true → 路由切新名；
 *   同名 no-op 不切路由；失败回退输入框（书名现为基本信息组唯一纯书级项）
 * - 覆盖子组件（写作默认/智能分析/版本保留）在此 stub 掉——它们各自的
 *   两层组交互有专属测试文件（settings-book-writing / -analysis），父组件只管书名/存储/空态
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsBook from '../../../src/studio/web-next/src/components/ui/SettingsBook.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'
import type { BookConfig } from '../../../src/studio/web-next/src/api/books'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  renameBook: vi.fn(),
  routerReplace: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  renameBook: mocks.renameBook,
}))

vi.mock('../../../src/studio/web-next/node_modules/vue-router', () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
}))

/** 打开设置 + 切到一本书（触发 watch 拉书名基线）。
 *  覆盖子组件 stub 掉：避免拉 getConfig/getRagStatus/getVersionStats 等依赖（各有专属测试）。 */
async function mountOpen(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const ws = useWorkspaceStore()
  ui.settingsOpen = true
  ws.bookName = '旧名'
  const wrapper = mount(SettingsBook, {
    global: {
      provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig },
      stubs: { SettingsBookWriting: true, SettingsBookAnalysis: true, SettingsBookRetention: true },
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 父组件只读书名（覆盖组子组件已 stub）；title 缺省即最小 config
  mocks.getConfig.mockResolvedValue({
    kind: 'long',
    book: { title: '旧名' },
  } satisfies BookConfig)
})

describe('SettingsBook 书名全量改名', () => {
  it('书名改动 → renameBook(旧名,新名)；renamed=true → 路由切新名 + 已保存 toast', async () => {
    mocks.renameBook.mockResolvedValue({ ok: true, renamed: true, name: '新名', path: '长篇/新名' })
    const ui = useUiStore()
    const wrapper = await mountOpen()

    const input = wrapper.find('input[aria-label="书名"]')
    expect((input.element as HTMLInputElement).value).toBe('旧名')

    await input.setValue('新名')
    await input.trigger('change')
    await flushPromises()

    expect(mocks.renameBook).toHaveBeenCalledWith('旧名', '新名')
    expect(mocks.routerReplace).toHaveBeenCalledWith('/book/%E6%96%B0%E5%90%8D')
    expect(ui.toasts.at(-1)?.msg).toBe('已保存')
  })

  it('同名 no-op（renamed=false）→ 不切路由', async () => {
    mocks.renameBook.mockResolvedValue({ ok: true, renamed: false, name: '旧名', path: '长篇/旧名' })
    const wrapper = await mountOpen()

    const input = wrapper.find('input[aria-label="书名"]')
    await input.setValue('新名')
    await input.trigger('change')
    await flushPromises()

    expect(mocks.renameBook).toHaveBeenCalledWith('旧名', '新名')
    expect(mocks.routerReplace).not.toHaveBeenCalled()
  })

  it('书名与基线相同 → 不调 renameBook', async () => {
    const wrapper = await mountOpen()
    const input = wrapper.find('input[aria-label="书名"]')
    await input.setValue('旧名')
    await input.trigger('change')
    await flushPromises()
    expect(mocks.renameBook).not.toHaveBeenCalled()
  })

  it('改名失败 → error toast + 输入框回退当前名', async () => {
    mocks.renameBook.mockRejectedValue(new Error('已有一本叫「新名」的书'))
    const ui = useUiStore()
    const wrapper = await mountOpen()

    const input = wrapper.find('input[aria-label="书名"]')
    await input.setValue('新名')
    await input.trigger('change')
    await flushPromises()

    expect(ui.toasts.at(-1)?.msg).toContain('已有一本')
    expect((input.element as HTMLInputElement).value).toBe('旧名')
    expect(mocks.routerReplace).not.toHaveBeenCalled()
  })

  it('空书名 → 回退基线，不调 renameBook', async () => {
    const wrapper = await mountOpen()
    const input = wrapper.find('input[aria-label="书名"]')
    await input.setValue('   ')
    await input.trigger('change')
    await flushPromises()
    expect(mocks.renameBook).not.toHaveBeenCalled()
    expect((input.element as HTMLInputElement).value).toBe('旧名')
  })
})

describe('SettingsBook 单页结构（IA 重组）', () => {
  it('有书打开 → banner 展示书名 + 基本信息/存储组在位 + 覆盖子组件挂载（AI 写作已砍书级，不在其中）', async () => {
    const wrapper = await mountOpen()
    expect(wrapper.find('.book-banner').text()).toContain('旧名')
    expect(wrapper.find('input[aria-label="书名"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('基本信息')
    // stub 后仍是占位元素（settings-book-stub）——验证父层确实挂了覆盖子组件
    expect(wrapper.find('settings-book-writing-stub').exists()).toBe(true)
    expect(wrapper.find('settings-book-analysis-stub').exists()).toBe(true)
    expect(wrapper.find('settings-book-retention-stub').exists()).toBe(true)
    // AI 写作书级覆盖 2026-08-19 已删除
    expect(wrapper.find('settings-book-ai-stub').exists()).toBe(false)
  })

  it('无书打开 → 整页空态（请先打开一本书），书名输入与覆盖组均不渲染', async () => {
    const ui = useUiStore()
    ui.settingsOpen = true
    const ws = useWorkspaceStore()
    ws.bookName = null
    const wrapper = mount(SettingsBook, {
      global: {
        provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig },
        stubs: { SettingsBookWriting: true, SettingsBookAnalysis: true, SettingsBookRetention: true },
      },
    })
    await flushPromises()
    expect(wrapper.find('input[aria-label="书名"]').exists()).toBe(false)
    expect(wrapper.find('settings-book-writing-stub').exists()).toBe(false)
    expect(wrapper.text()).toContain('请先打开一本书')
  })
})

describe('R64-4（十二轮）：书名基线加载代守卫（R63-3 同款，本组件漏点收口）', () => {
  it('甲书在途 getConfig 迟到、期间已切乙书 → 书名/基线不回填', async () => {
    const ui = useUiStore()
    const ws = useWorkspaceStore()
    ui.settingsOpen = true
    ws.bookName = '甲书'
    let resolveA!: (c: BookConfig) => void
    let first = true
    mocks.getConfig.mockImplementation(() => {
      if (first) {
        first = false
        return new Promise<BookConfig>((r) => {
          resolveA = r
        })
      }
      return Promise.resolve({ kind: 'long', book: { title: '乙书' } } satisfies BookConfig)
    })
    const wrapper = mount(SettingsBook, {
      global: {
        provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig },
        stubs: { SettingsBookWriting: true, SettingsBookAnalysis: true, SettingsBookRetention: true },
      },
    })
    await flushPromises() // 甲书在途
    ws.bookName = '乙书'
    await flushPromises() // 乙书已回填
    resolveA({ kind: 'long', book: { title: '甲书' } } satisfies BookConfig) // 甲书迟到
    await flushPromises()
    // 修复前：甲书标题迟到落地 → 书名框显示「甲书」且 titleBaseline 被污染（后续改名误判）
    expect((wrapper.find('input[aria-label="书名"]').element as HTMLInputElement).value).toBe('乙书')
    wrapper.unmount()
  })
})

describe('SettingsBook 编辑排版覆盖组（纸张宽度/自动保存 书级覆盖）', () => {
  it('默认（无覆盖）→ 开关未勾、「跟随全局默认」、无子项；全局默认提示在', async () => {
    const wrapper = await mountOpen()
    const prefs = usePrefsStore()
    expect(prefs.bookPageWidth).toBeNull()
    expect(prefs.bookAutosaveInterval).toBeNull()
    const pfwSwitch = wrapper.find('input[aria-label="本书独立设定纸张宽度"]').element as HTMLInputElement
    expect(pfwSwitch.checked).toBe(false)
    expect(wrapper.text()).toContain('跟随全局默认')
    expect(wrapper.find('input[aria-label="本书纸宽"]').exists()).toBe(false)
    expect(wrapper.text()).toContain(`${prefs.pageWidth}px`)
  })

  it('开启纸宽开关 → 写书级（=当前生效值）且不动全局；出现本书纸宽子项', async () => {
    const wrapper = await mountOpen()
    const prefs = usePrefsStore()
    prefs.pageWidth = 1100 // 全局默认
    await wrapper.find('input[aria-label="本书独立设定纸张宽度"]').setValue(true)
    expect(prefs.bookPageWidth).toBe(1100) // effectivePageWidth = 1100
    expect(prefs.pageWidth).toBe(1100) // 全局不动
    expect(wrapper.text()).toContain('本书独立设定')
    expect(wrapper.find('input[aria-label="本书纸宽"]').exists()).toBe(true)
  })

  it('改本书纸宽 → 只写书级，全局默认保持原值', async () => {
    const wrapper = await mountOpen()
    const prefs = usePrefsStore()
    await wrapper.find('input[aria-label="本书独立设定纸张宽度"]').setValue(true)
    const bookW = wrapper.find('input[aria-label="本书纸宽"]')
    await bookW.setValue(800)
    await bookW.trigger('change')
    expect(prefs.bookPageWidth).toBe(800)
    expect(prefs.pageWidth).toBe(1020) // 全局仍默认，未被覆盖
  })

  it('关闭纸宽开关 → 仅清书级（null），全局默认保持不变 -> 回复「跟随全局默认」', async () => {
    const wrapper = await mountOpen()
    const prefs = usePrefsStore()
    const switchIn = wrapper.find('input[aria-label="本书独立设定纸张宽度"]')
    await switchIn.setValue(true)
    await wrapper.find('input[aria-label="本书纸宽"]').trigger('change') // 走一次变化确保有覆盖
    expect(prefs.bookPageWidth).not.toBeNull()
    await switchIn.setValue(false) // 关闭
    expect(prefs.bookPageWidth).toBeNull()
    expect(prefs.pageWidth).toBe(1020) // 全局默认未被改
    expect(wrapper.find('input[aria-label="本书纸宽"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('跟随全局默认')
  })

  it('自动保存覆盖组同构：开启写书级、数值只写书级、关闭只清书级不动全局', async () => {
    const wrapper = await mountOpen()
    const prefs = usePrefsStore()
    prefs.autosaveInterval = 60
    await wrapper.find('input[aria-label="本书独立设定自动保存"]').setValue(true)
    expect(prefs.bookAutosaveInterval).toBe(60)
    expect(prefs.autosaveInterval).toBe(60) // 全局不变
    const asInput = wrapper.find('input[aria-label="本书自动保存间隔"]')
    await asInput.setValue(20)
    await asInput.trigger('change')
    expect(prefs.bookAutosaveInterval).toBe(20)
    expect(prefs.autosaveInterval).toBe(60) // 全局默认保持
    await wrapper.find('input[aria-label="本书独立设定自动保存"]').setValue(false)
    expect(prefs.bookAutosaveInterval).toBeNull()
    expect(prefs.autosaveInterval).toBe(60) // 关闭不动全局
  })
})
