// @vitest-environment happy-dom
/**
 * SettingsBookAi（「设置 · 本书」页 · AI 写作覆盖组）交互测试：
 * 开关 on/off = 组内四键（style.injection / auto.confirm_outline / auto.batch_size /
 * budget.calls_per_chapter）写生效值/删键；raw 形态（13 键未设时为 undefined）验证
 * 「跟随全局默认」展示与生效摘要计算。IA 重组前这些断言在 settings-ai.test.ts（本书组）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsBookAi from '../../../src/studio/web-next/src/components/ui/SettingsBookAi.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'
import type { BookConfig } from '../../../src/studio/web-next/src/api/books'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))

/** 打开设置 + 切到一本书（触发 raw watch 拉配置）。 */
async function mountOpen(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const ws = useWorkspaceStore()
  ui.settingsOpen = true
  ws.bookName = '测试书'
  const wrapper = mount(SettingsBookAi, {
    global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
  })
  await flushPromises()
  return wrapper
}

/** 捕获 saveConfig mutator 的惯用包装：返回「执行 mutator 的函数」供断言写入结果。 */
function captureMutator(): (cfg: BookConfig) => void {
  let captured: ((c: BookConfig) => void) | undefined
  mocks.saveConfig.mockImplementation((mut: (c: BookConfig) => void) => {
    captured = mut
    return Promise.resolve()
  })
  return (cfg: BookConfig) => captured!(cfg)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // raw 形态：13 键未设时为 undefined——书级全跟随时四键均缺省
  mocks.getConfig.mockResolvedValue({
    kind: 'long',
    book: { title: '测试书' },
  } satisfies BookConfig)
})

describe('SettingsBookAi AI 写作本书覆盖（两层组开关）', () => {
  it('raw 全未设 → 开关 off + desc 生效摘要（轻 · 批量 8 章 · 上限 8 次）+ 跟随全局默认 + 无子项', async () => {
    const wrapper = await mountOpen()
    const sw = wrapper.find('input[aria-label="本书使用独立设定"]')
    expect(sw.exists()).toBe(true)
    expect((sw.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('当前生效 轻 · 批量 8 章 · 上限 8 次（跟随全局默认）')
    expect(wrapper.find('input[aria-label="批量写作章数"]').exists()).toBe(false)
  })

  it('开关 on → mutator 用生效值写四键（含 auto 段成对写 + budget/style 分段）', async () => {
    const prefs = usePrefsStore()
    prefs.setStyleInjection('heavy')
    prefs.setAiBatchSize(5)
    prefs.setCallsPerChapter(12)
    const wrapper = await mountOpen()

    const run = captureMutator()
    await wrapper.find('input[aria-label="本书使用独立设定"]').setValue(true)
    const cfg = { auto: { relation_auto_mine: true } } as BookConfig
    run(cfg)
    expect(cfg.style?.injection).toBe('heavy')
    expect(cfg.auto?.confirm_outline).toBe(false)
    expect(cfg.auto?.batch_size).toBe(5)
    expect(cfg.budget?.calls_per_chapter).toBe(12)
    // auto 段他键（关系图，归「本书」页的智能分析组管）不被覆盖
    expect(cfg.auto?.relation_auto_mine).toBe(true)
  })

  it('开关 off → mutator 删四键（不动 auto.relation_* 他键）', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      style: { injection: 'heavy' },
      auto: { confirm_outline: true, batch_size: 6, relation_auto_mine: true, relation_mine_threshold: 4 },
      budget: { calls_per_chapter: 12 },
      book: { title: '测试书' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    expect((wrapper.find('input[aria-label="本书使用独立设定"]').element as HTMLInputElement).checked).toBe(true)

    const run = captureMutator()
    await wrapper.find('input[aria-label="本书使用独立设定"]').setValue(false)
    const cfg = {
      style: { injection: 'heavy' },
      auto: { confirm_outline: true, batch_size: 6, relation_auto_mine: true, relation_mine_threshold: 4 },
      budget: { calls_per_chapter: 12 },
    } as BookConfig
    run(cfg)
    expect(cfg.style?.injection).toBeUndefined()
    expect(cfg.auto?.confirm_outline).toBeUndefined()
    expect(cfg.auto?.batch_size).toBeUndefined()
    expect(cfg.budget?.calls_per_chapter).toBeUndefined()
    expect(cfg.auto?.relation_auto_mine).toBe(true)
    expect(cfg.auto?.relation_mine_threshold).toBe(4)
  })

  it('子项批量章数 clamp 1-20 写 c.auto.batch_size', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      auto: { batch_size: 3 },
      book: { title: '测试书' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const input = wrapper.find('input[aria-label="批量写作章数"]')
    expect((input.element as HTMLInputElement).value).toBe('3')
    const run = captureMutator()
    await input.setValue('30')
    const cfg = { auto: {} } as BookConfig
    run(cfg)
    expect(cfg.auto?.batch_size).toBe(20)
  })

  it('子项文风注入写 c.style.injection', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      style: { injection: 'light' },
      book: { title: '测试书' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    // 本组件唯一一个 seg（文风注入子项，override 开后出现）
    const segBtns = wrapper.findAll('.seg').at(0)!.findAll('button')
    const run = captureMutator()
    await segBtns[1]!.trigger('click')
    const cfg = { style: { injection: 'light' } } as BookConfig
    run(cfg)
    expect(cfg.style?.injection).toBe('heavy')
  })

  it('子项单章调用上限 clamp 1-50 写 c.budget.calls_per_chapter', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      budget: { calls_per_chapter: 10 },
      book: { title: '测试书' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="单章调用上限"]').setValue('0')
    const cfg = { budget: {} } as BookConfig
    run(cfg)
    expect(cfg.budget?.calls_per_chapter).toBe(1)
  })

  it('无书打开 → 覆盖复位为跟随全局（开关 off，无子项残留）', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      style: { injection: 'heavy' },
      auto: { batch_size: 6 },
      book: { title: '测试书' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    expect((wrapper.find('input[aria-label="本书使用独立设定"]').element as HTMLInputElement).checked).toBe(true)

    // 关设置 → 切走书 → 重开：refs 复位，开关回 off
    const ui = useUiStore()
    const ws = useWorkspaceStore()
    ui.settingsOpen = false
    ws.bookName = null
    await flushPromises()
    ui.settingsOpen = true
    await flushPromises()
    expect((wrapper.find('input[aria-label="本书使用独立设定"]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.find('input[aria-label="批量写作章数"]').exists()).toBe(false)
  })
})
