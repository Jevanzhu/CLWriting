// @vitest-environment happy-dom
/**
 * SettingsBookWriting（「设置 · 本书」页 · 写作默认覆盖组）交互测试：
 * 开关 on/off = 组内四键（genre/volume_size/target_words/chapter_target_words）写生效值/删键；
 * raw 形态（13 键未设时为 undefined，genre 空串=未设）验证「跟随全局默认」展示与生效值计算。
 * IA 重组前这些断言在 settings-book.test.ts（写作默认 · 本书组）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import SettingsBookWriting from '../../../src/studio/web-next/src/components/ui/SettingsBookWriting.vue'
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
  const wrapper = mount(SettingsBookWriting, {
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
  // raw 形态：13 键未设时为 undefined（genre 空串=未设）——书级全跟随时四键均缺省
  mocks.getConfig.mockResolvedValue({
    kind: 'long',
    book: { title: '测试书' },
  } satisfies BookConfig)
})

describe('SettingsBookWriting 写作默认本书覆盖（两层组开关）', () => {
  it('raw 全未设 → 开关 off + desc 标注跟随全局默认 + 子项不渲染', async () => {
    const wrapper = await mountOpen()
    const sw = wrapper.find('input[aria-label="本书使用独立设定"]')
    expect(sw.exists()).toBe(true)
    expect((sw.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('（跟随全局默认）')
    expect(wrapper.find('input[aria-label="题材"]').exists()).toBe(false)
    expect(wrapper.find('input[aria-label="每卷章数"]').exists()).toBe(false)
  })

  it('开关 on → mutator 用生效值（书级 ?? 全局）写四键；子项用生效值初始化', async () => {
    const prefs = usePrefsStore()
    prefs.setDefaultGenre('玄幻')
    prefs.setDefaultVolumeSize(30)
    const wrapper = await mountOpen()

    const run = captureMutator()
    await wrapper.find('input[aria-label="本书使用独立设定"]').setValue(true)
    await nextTick()
    const cfg = { book: { title: '测试书' } } as BookConfig
    run(cfg)
    expect(cfg.book?.genre).toBe('玄幻')
    expect(cfg.book?.volume_size).toBe(30)
    // 全局未设的键写 0（=未设语义），书名 title 原样保留
    expect(cfg.book?.target_words).toBe(0)
    expect(cfg.book?.chapter_target_words).toBe(0)
    expect(cfg.book?.title).toBe('测试书')

    // 子项出现且以生效值起步（防呆：切换本身不改变行为）
    expect((wrapper.find('input[aria-label="每卷章数"]').element as HTMLInputElement).value).toBe('30')
    expect((wrapper.find('input[aria-label="题材"]').element as HTMLInputElement).value).toBe('玄幻')
  })

  it('开关 off → mutator 删四键（genre 置 undefined），书名保留', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书', genre: '都市', volume_size: 40, target_words: 1_000_000 },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    expect((wrapper.find('input[aria-label="本书使用独立设定"]').element as HTMLInputElement).checked).toBe(true)

    const run = captureMutator()
    await wrapper.find('input[aria-label="本书使用独立设定"]').setValue(false)
    const cfg = { book: { title: '测试书', genre: '都市', volume_size: 40, target_words: 1_000_000, chapter_target_words: 3000 } } as BookConfig
    run(cfg)
    expect(cfg.book?.genre).toBeUndefined()
    expect(cfg.book?.volume_size).toBeUndefined()
    expect(cfg.book?.target_words).toBeUndefined()
    expect(cfg.book?.chapter_target_words).toBeUndefined()
    expect(cfg.book?.title).toBe('测试书')
  })

  it('已设题材 → 子项显示已存值；改动写 c.book.genre', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书', genre: '都市' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const input = wrapper.find('input[aria-label="题材"]')
    expect((input.element as HTMLInputElement).value).toBe('都市')

    const run = captureMutator()
    await input.setValue('科幻')
    const cfg = { book: { title: '测试书', genre: '都市' } } as BookConfig
    run(cfg)
    expect(cfg.book?.genre).toBe('科幻')
  })

  it('短篇书不显示每卷章数子项（长篇才显示规则保持）', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'short',
      book: { title: '测试书', genre: '现实', volume_size: 40 },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    expect(wrapper.find('input[aria-label="每卷章数"]').exists()).toBe(false)
    // 目标字数/每章字数子项仍在
    expect(wrapper.find('input[aria-label="目标字数"]').exists()).toBe(true)
    expect(wrapper.find('input[aria-label="每章字数"]').exists()).toBe(true)
  })

  it('每卷章数子项非法输入（<5）→ 清键回跟随（写 undefined）', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书', volume_size: 40 },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const input = wrapper.find('input[aria-label="每卷章数"]')
    const run = captureMutator()
    await input.setValue('2')
    const cfg = { book: { title: '测试书', volume_size: 40 } } as BookConfig
    run(cfg)
    expect(cfg.book?.volume_size).toBeUndefined()
  })

  it('无书打开 → 覆盖复位为跟随全局（开关 off，无子项残留）', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书', genre: '都市', volume_size: 40 },
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
    expect(wrapper.find('input[aria-label="题材"]').exists()).toBe(false)
  })
})

describe('R64-4（十二轮）：配置加载代守卫（R63-3 同款，本组件漏点收口）', () => {
  it('甲书在途 getConfig 迟到、期间已切乙书 → 覆盖组不被甲书值点亮（防跨书写盘放大器）', async () => {
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
    const wrapper = mount(SettingsBookWriting, {
      global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
    })
    await flushPromises() // 甲书在途
    ws.bookName = '乙书'
    await flushPromises() // 乙书已回填（全跟随）
    // 甲书迟到：题材/字数全设——若回填会点亮本书覆盖组，组开关即以甲书值写乙书 book.yaml
    resolveA({
      kind: 'long',
      book: { title: '甲书', genre: '玄幻', volume_size: 9, target_words: 3000000, chapter_target_words: 6666 },
    } satisfies BookConfig)
    await flushPromises()
    expect((wrapper.find('input[aria-label="本书使用独立设定"]').element as HTMLInputElement).checked).toBe(false)
    wrapper.unmount()
  })
})
