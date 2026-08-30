// @vitest-environment happy-dom
/**
 * SettingsBookAnalysis（「设置 · 本书」页 · 智能分析覆盖组）交互测试：
 * - 知识检索：本书组开关 on/off 写/删 rag.enabled+provider；旧版内联配置（endpoint 直存）→
 *   本书子项显示「沿用」伪选项，选中服务商写 provider 并清旧内联 endpoint/model；建索引触发 + 状态轮询
 * - 短篇严格模式（short.strict）：本书组仅短篇书显示，开关 on/off 写/删 short.strict
 * - 关系图：本书组开关 on/off 写/删 auto.relation_auto_mine/relation_mine_threshold
 * - 组件测试 mock getConfig 直接返回 raw 形态（13 键未设时为 undefined），验证「跟随全局默认」展示与生效值计算。
 *   IA 重组前这些断言在 settings-ai-rag.test.ts（本书组部分）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsBookAnalysis from '../../../src/studio/web-next/src/components/ui/SettingsBookAnalysis.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'
import type { BookConfig } from '../../../src/studio/web-next/src/api/books'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getRagStatus: vi.fn(),
  triggerRagBuild: vi.fn(),
  getRagProviders: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getRagStatus: mocks.getRagStatus,
  triggerRagBuild: mocks.triggerRagBuild,
}))
vi.mock('../../../src/studio/web-next/src/api/providers', () => ({
  getRagProviders: mocks.getRagProviders,
}))

/** 打开设置 + 切到一本书（触发 raw watch 拉配置与服务商列表）。 */
async function mountOpen(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const ws = useWorkspaceStore()
  ui.settingsOpen = true
  ws.bookName = '测试书'
  const wrapper = mount(SettingsBookAnalysis, {
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
  // raw 形态：13 键未设时为 undefined（genre 空串=未设）——书级全跟随时的最小 config
  mocks.getConfig.mockResolvedValue({ kind: 'long', book: { title: '测试书' } } satisfies BookConfig)
  mocks.getRagStatus.mockResolvedValue({
    running: false, indexedChapters: 0, chunkCount: 0, model: null,
    ragConfig: {}, providerName: null, legacy: false, lastResult: null,
  })
  mocks.getRagProviders.mockResolvedValue({
    ragProviders: [
      { id: 'rag-a', name: 'A 家嵌入', endpoint: 'https://a/v1/embeddings', model: 'embed-a', apiKey: '', apiKeyMasked: 'sk-1...abcd', caps: null },
      { id: 'rag-b', name: 'B 家嵌入', endpoint: 'https://b/v1/embeddings', model: 'embed-b', apiKey: '', apiKeyMasked: 'sk-2...efgh', caps: null },
    ],
  })
})

describe('SettingsBookAnalysis 知识检索（本书组）', () => {
  it('本书开关 on → mutator 用生效值写 rag.enabled + rag.provider（全局未选 provider 则不落键）', async () => {
    const prefs = usePrefsStore()
    prefs.setRagEnabled(true)
    prefs.setRagProvider('rag-a')
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="知识检索使用独立设定"]').setValue(true)
    const cfg = {} as BookConfig
    run(cfg)
    expect(cfg.rag?.enabled).toBe(true)
    expect(cfg.rag?.provider).toBe('rag-a')
  })

  it('本书开关 off → mutator 删 rag.enabled / rag.provider（不动 endpoint/model 遗留键）', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书' },
      rag: { enabled: true, provider: 'rag-b', endpoint: 'https://legacy', model: 'old-model' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    expect((wrapper.find('input[aria-label="知识检索使用独立设定"]').element as HTMLInputElement).checked).toBe(true)
    const run = captureMutator()
    await wrapper.find('input[aria-label="知识检索使用独立设定"]').setValue(false)
    const cfg = { rag: { enabled: true, provider: 'rag-b', endpoint: 'https://legacy', model: 'old-model' } } as BookConfig
    run(cfg)
    expect(cfg.rag?.enabled).toBeUndefined()
    expect(cfg.rag?.provider).toBeUndefined()
    // 遗留内联键只随「选中提供方」迁移清键，组开关 off 不越权清理
    expect(cfg.rag?.endpoint).toBe('https://legacy')
    expect(cfg.rag?.model).toBe('old-model')
  })

  it('raw 全未设 → 开关 off + desc 标注跟随全局默认 + 本书子项不渲染', async () => {
    const wrapper = await mountOpen()
    const sw = wrapper.find('input[aria-label="知识检索使用独立设定"]')
    expect((sw.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('跟随全局默认')
    expect(wrapper.find('select[aria-label="检索提供方"]').exists()).toBe(false)
  })

  it('本书子开关 → saveConfig 写 rag.enabled', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书' },
      rag: { enabled: false },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="启用知识检索"]').setValue(true)
    const cfg = { rag: { enabled: false } } as BookConfig
    run(cfg)
    expect(cfg.rag?.enabled).toBe(true)
  })

  it('旧版内联 → 本书子项「沿用」伪选项存在且为当前值；选中服务商写 provider 并清旧内联（一次性迁移）', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书' },
      rag: { enabled: true, endpoint: 'https://legacy', model: 'old-model' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()

    const select = wrapper.find('select[aria-label="检索提供方"]')
    expect(select.exists()).toBe(true)
    expect(select.find('option[value="__legacy__"]').exists()).toBe(true)
    expect((select.element as HTMLSelectElement).value).toBe('__legacy__')

    const run = captureMutator()
    await select.setValue('rag-a')
    const cfg = { rag: { enabled: true, endpoint: 'https://legacy', model: 'old-model' } } as BookConfig
    run(cfg)
    expect(cfg.rag?.provider).toBe('rag-a')
    expect(cfg.rag?.endpoint).toBeUndefined()
    expect(cfg.rag?.model).toBeUndefined()
  })

  it('已有 provider 引用 → 本书子项下拉当前值为该服务商', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书' },
      rag: { enabled: true, provider: 'rag-b' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const select = wrapper.find('select[aria-label="检索提供方"]')
    expect((select.element as HTMLSelectElement).value).toBe('rag-b')
  })

  it('选「旧版内联配置（沿用）」→ 不触发任何写入', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书' },
      rag: { enabled: true, endpoint: 'https://legacy', model: 'old-model' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const select = wrapper.find('select[aria-label="检索提供方"]')
    await select.setValue('__legacy__')
    await flushPromises()
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('本书子项启用检索关闭 → 不渲染服务商子项下拉', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书' },
      rag: { enabled: false, provider: 'rag-a' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    expect(wrapper.find('select[aria-label="检索提供方"]').exists()).toBe(false)
  })

  it('生效启用（本书开关 off + 全局默认 on）→ 显示建立索引入口', async () => {
    usePrefsStore().setRagEnabled(true)
    const wrapper = await mountOpen()
    expect(wrapper.find('.rag-build-row').exists()).toBe(true)
    expect(wrapper.text()).toContain('建立索引')
  })

  it('生效未启用 → 不显示建立索引入口', async () => {
    const wrapper = await mountOpen()
    expect(wrapper.find('.rag-build-row').exists()).toBe(false)
  })

  it('点建立索引 → triggerRagBuild(书名) + 构建中状态（按钮置灰）', async () => {
    usePrefsStore().setRagEnabled(true)
    mocks.triggerRagBuild.mockResolvedValue({ ok: true })
    const wrapper = await mountOpen()

    const btn = wrapper.find('.rag-build-row button')
    expect(btn.text()).toBe('建立索引')
    await btn.trigger('click')
    await flushPromises()
    expect(mocks.triggerRagBuild).toHaveBeenCalledWith('测试书')
    expect(wrapper.text()).toContain('构建中')
    expect(wrapper.find('.rag-build-row button').attributes('disabled')).toBeDefined()

    // 卸载触发 onUnmounted 停轮询（interval 未到 1.5s 首跳即清，不泄漏到后续用例）
    wrapper.unmount()
  })
})

describe('SettingsBookAnalysis 短篇严格模式（本书组）', () => {
  it('短篇书显示本书组且开关反映已存值；on 用生效值写 short.strict', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'short',
      short: { strict: false },
      book: { title: '短篇', genre: '现实' },
    } satisfies BookConfig)
    const prefs = usePrefsStore()
    prefs.setDefaultShortStrict(true)
    const wrapper = await mountOpen()

    const sw = wrapper.find('input[aria-label="AI 机检使用独立设定"]')
    expect(sw.exists()).toBe(true)
    expect((sw.element as HTMLInputElement).checked).toBe(true)
    // 开关 on = 从当前生效值（书级 false 覆盖优先）初始化——desc 摘要展示书级值
    expect(wrapper.text()).toContain('当前生效 常规')

    // 子开关切换写入 short.strict
    const run = captureMutator()
    await wrapper.find('input[aria-label="短篇严格模式"]').setValue(true)
    const cfg = { kind: 'short', short: {} } as BookConfig
    run(cfg)
    expect(cfg.short?.strict).toBe(true)
  })

  it('短篇书本书开关 off → mutator 删 short.strict（保留段内阈值键）', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'short',
      short: { strict: true, word_min: 8000 },
      book: { title: '短篇', genre: '现实' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="AI 机检使用独立设定"]').setValue(false)
    const cfg = { kind: 'short', short: { strict: true, word_min: 8000 } } as BookConfig
    run(cfg)
    expect(cfg.short?.strict).toBeUndefined()
    expect(cfg.short?.word_min).toBe(8000)
  })

  it('长篇书不显示「AI 机检」本书组（开关与子项均无）', async () => {
    const wrapper = await mountOpen() // beforeEach 默认长篇
    expect(wrapper.find('input[aria-label="AI 机检使用独立设定"]').exists()).toBe(false)
    expect(wrapper.find('input[aria-label="短篇严格模式"]').exists()).toBe(false)
  })

  it('短篇书 raw 未设 → 本书开关 off + desc 跟随全局默认', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'short',
      book: { title: '短篇', genre: '现实' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const sw = wrapper.find('input[aria-label="AI 机检使用独立设定"]')
    expect((sw.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('当前生效 常规（跟随全局默认）')
  })
})

describe('SettingsBookAnalysis 关系图（本书组）', () => {
  it('本书开关 on → mutator 用生效值写 auto.relation_*（保留段内 AI 写作键）', async () => {
    const prefs = usePrefsStore()
    prefs.setRelationAutoMine(true)
    prefs.setRelationMineThreshold(5)
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="关系图使用独立设定"]').setValue(true)
    const cfg = { auto: { confirm_outline: false, batch_size: 3 } } as BookConfig
    run(cfg)
    expect(cfg.auto?.relation_auto_mine).toBe(true)
    expect(cfg.auto?.relation_mine_threshold).toBe(5)
    expect(cfg.auto?.confirm_outline).toBe(false)
    expect(cfg.auto?.batch_size).toBe(3)
  })

  it('本书开关 off → mutator 删 auto.relation_*（不动 AI 写作键）', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      auto: { relation_auto_mine: true, relation_mine_threshold: 6, batch_size: 9 },
      book: { title: '测试书' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="关系图使用独立设定"]').setValue(false)
    const cfg = { auto: { relation_auto_mine: true, relation_mine_threshold: 6, batch_size: 9 } } as BookConfig
    run(cfg)
    expect(cfg.auto?.relation_auto_mine).toBeUndefined()
    expect(cfg.auto?.relation_mine_threshold).toBeUndefined()
    expect(cfg.auto?.batch_size).toBe(9)
  })

  it('子项阈值输入 clamp 1-20 写 auto.relation_mine_threshold', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      auto: { relation_auto_mine: true, relation_mine_threshold: 6 },
      book: { title: '测试书' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const run = captureMutator()
    await wrapper.find('input[aria-label="章节增量阈值"]').setValue('99')
    const cfg = { auto: {} } as BookConfig
    run(cfg)
    expect(cfg.auto?.relation_mine_threshold).toBe(20)
  })
})

describe('R63-3（十一轮）：配置加载竞态守卫（代守卫 + await 后双复检）', () => {
  it('A 书在途 getConfig 迟到、期间已切 B 书 → 不回填（B 面板不被 A 值污染）', async () => {
    const ui = useUiStore()
    const ws = useWorkspaceStore()
    ui.settingsOpen = true
    ws.bookName = '甲书'
    // 首次调用（甲书）挂起，后续调用（乙书）立即回最小 config
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
    const wrapper = mount(SettingsBookAnalysis, {
      global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
    })
    await flushPromises() // 甲书在途
    ws.bookName = '乙书'
    await flushPromises() // 乙书已加载（全部跟随全局）

    // 甲书迟到响应落地（满覆盖形态——若回填会全部盖到乙书面板）
    resolveA({
      kind: 'short',
      book: { title: '甲书' },
      short: { strict: true },
      auto: { relation_auto_mine: true, relation_mine_threshold: 9 },
      rag: { enabled: true, provider: 'rag-a' },
    } satisfies BookConfig)
    await flushPromises()

    // 修复前：甲书值迟到落地 → 组开关全亮（甲覆盖值污染乙书面板）；
    // 修复后：代守卫丢弃 → 乙书保持「跟随全局」
    expect((wrapper.find('input[aria-label="知识检索使用独立设定"]').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.find('input[aria-label="关系图使用独立设定"]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.find('input[aria-label="AI 机检使用独立设定"]').exists()).toBe(false) // 乙书 long → 短篇组不显示（甲 short 不泄漏）
  })

  it('污染放大器闭合：迟到不回填后，乙书开组开关写的是乙书生效值（全局默认），非甲书残留值', async () => {
    const ui = useUiStore()
    const ws = useWorkspaceStore()
    const prefs = usePrefsStore()
    prefs.setRagEnabled(false) // 全局默认关——甲书迟到值是 true
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
    const wrapper = mount(SettingsBookAnalysis, {
      global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
    })
    await flushPromises()
    ws.bookName = '乙书'
    await flushPromises()
    resolveA({ kind: 'short', book: { title: '甲书' }, rag: { enabled: true, provider: 'rag-a' } } satisfies BookConfig)
    await flushPromises()

    // 乙书开知识检索组 → mutator 写入的应是乙书生效值（全局默认 false），而非甲书 true
    const run = captureMutator()
    await wrapper.find('input[aria-label="知识检索使用独立设定"]').setValue(true)
    const cfg = {} as BookConfig
    run(cfg)
    expect(cfg.rag?.enabled).toBe(false)
  })

  it('refreshRagStatus 在途切书 → 旧书状态不落到新书面板（书名复检）', async () => {
    const ui = useUiStore()
    const ws = useWorkspaceStore()
    const prefs = usePrefsStore()
    prefs.setRagEnabled(true) // 建索引行渲染（.rag-status 可见）
    ui.settingsOpen = true
    ws.bookName = '甲书'
    // 甲书 getConfig 立即回；getRagStatus 首调（甲）挂起、次调（乙）立即回
    mocks.getConfig.mockResolvedValue({ kind: 'long', book: { title: '甲书' } } satisfies BookConfig)
    let resolveA!: (s: unknown) => void
    let first = true
    mocks.getRagStatus.mockImplementation(() => {
      if (first) {
        first = false
        return new Promise((r) => {
          resolveA = r
        })
      }
      return Promise.resolve({
        running: false, indexedChapters: 9, chunkCount: 40, model: null,
        ragConfig: {}, providerName: null, legacy: false, lastResult: null,
      })
    })
    const wrapper = mount(SettingsBookAnalysis, {
      global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
    })
    await flushPromises() // 甲书配置已回，状态在途
    ws.bookName = '乙书'
    await flushPromises() // 乙书状态已回（已索引 9 章）
    expect(wrapper.find('.rag-status').text()).toContain('已索引 9 章')

    // 甲书状态迟到（已索引 3 章）——修复前会覆盖乙书面板
    resolveA({
      running: false, indexedChapters: 3, chunkCount: 12, model: null,
      ragConfig: {}, providerName: null, legacy: false, lastResult: null,
    })
    await flushPromises()
    expect(wrapper.find('.rag-status').text()).toContain('已索引 9 章')
    expect(wrapper.find('.rag-status').text()).not.toContain('3 章')
  })
})

// R26-14（二十六轮）：RAG 轮询连续失败终态——原轮询对失败无感知（catch 静默），
// 服务端持续 5xx 时 ragBuilding 恒 true：按钮永久置灰、状态卡死「构建中…」。
// 修复后连续 5 次失败（1.5s 间隔 ≈7.5s）停轮询、按钮解禁、状态给可行动提示；成功归零。
describe('R26-14（二十六轮）：RAG 轮询连续失败终态', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('连续 5 次失败 → 停轮询 + 失败终态文本 + 按钮解禁', async () => {
    vi.useFakeTimers()
    usePrefsStore().setRagEnabled(true)
    mocks.triggerRagBuild.mockResolvedValue({ ok: true })
    mocks.getRagStatus.mockRejectedValue(new Error('服务端挂了'))
    const wrapper = await mountOpen()
    await wrapper.find('.rag-build-row button').trigger('click') // 建立索引 → 轮询启动
    await flushPromises()
    expect(wrapper.find('.rag-status').text()).toContain('构建中')
    expect(wrapper.find('.rag-build-row button').attributes('disabled')).toBeDefined()

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1500)
      await flushPromises()
    }
    // 修复点：失败终态（非「构建中」卡死），按钮解禁可手动重试
    expect(wrapper.find('.rag-status').text()).toContain('索引状态获取失败，请稍后重试')
    expect(wrapper.find('.rag-build-row button').attributes('disabled')).toBeUndefined()

    // 轮询已停：再走 3 拍不再打接口（1 次 mount 直调 + 5 次轮询 = 6 次封顶）
    const calls = mocks.getRagStatus.mock.calls.length
    expect(calls).toBe(6)
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1500)
      await flushPromises()
    }
    expect(mocks.getRagStatus.mock.calls.length).toBe(calls)
    wrapper.unmount()
  })

  it('中途成功归零：4 败 → 成功 → 再 4 败不终态，第 10 败才终态', async () => {
    vi.useFakeTimers()
    usePrefsStore().setRagEnabled(true)
    mocks.triggerRagBuild.mockResolvedValue({ ok: true })
    // 调用序：#1 mount 直调（失败不计数，直调不进轮询计数）；轮询 #2..#5 败（streak 4）、
    // #6 成功（running，归零）、#7..#10 败 → 第 10 次轮询失败才触终态
    let n = 0
    const runningStatus = {
      running: true, indexedChapters: 0, chunkCount: 0, model: null,
      ragConfig: {}, providerName: null, legacy: false, lastResult: null,
    }
    mocks.getRagStatus.mockImplementation(() => {
      n++
      return n === 6 ? Promise.resolve(runningStatus) : Promise.reject(new Error('down'))
    })
    const wrapper = await mountOpen()
    await wrapper.find('.rag-build-row button').trigger('click')
    await flushPromises()

    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(1500)
      await flushPromises()
    }
    // 第 6 次成功已把计数归零，此后 4 连败（streak 4 < 5）→ 仍未终态
    expect(wrapper.find('.rag-status').text()).not.toContain('索引状态获取失败')
    expect(wrapper.text()).toContain('构建中')

    vi.advanceTimersByTime(1500) // 第 10 次轮询失败 → streak 达 5
    await flushPromises()
    expect(wrapper.find('.rag-status').text()).toContain('索引状态获取失败，请稍后重试')
    wrapper.unmount()
  })
})

// R28-26（二十八轮）：轮询重叠去重——interval 回调 async，单拍慢于 1.5s 时下一拍照发、
// 多拍并发：同一失败被并发响应重复计数（ragFailStreak 连加）提前误进失败终态。
// 修复后上一拍未 settle 本拍跳过（不并发），streak 只按 settle 次数累加。
describe('R28-26（二十八轮）：RAG 轮询重叠去重（inFlight 旗标）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('慢响应在途 → 后续拍跳过不并发；失败只计一次，不提前进终态', async () => {
    vi.useFakeTimers()
    usePrefsStore().setRagEnabled(true)
    mocks.triggerRagBuild.mockResolvedValue({ ok: true })
    // 调用序：#1 mount 直调（rejected，不进轮询计数）；#2 轮询第 1 拍 = 慢请求（挂起）；
    // 其余调用立即 rejected
    let n = 0
    let rejectSlow!: (e: unknown) => void
    mocks.getRagStatus.mockImplementation(() => {
      n++
      if (n === 2) {
        return new Promise((_, rej) => {
          rejectSlow = rej
        })
      }
      return Promise.reject(new Error('down'))
    })
    const wrapper = await mountOpen()
    await wrapper.find('.rag-build-row button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('构建中')

    // 第 1 拍发起慢请求（#2：mount 直调 #1 之后）
    vi.advanceTimersByTime(1500)
    await flushPromises()
    const callsDuringSlow = mocks.getRagStatus.mock.calls.length

    // 慢请求未 settle 期间连走 3 拍 → 全部跳过，无新请求（修复前会并发 3 拍）
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1500)
      await flushPromises()
    }
    expect(mocks.getRagStatus.mock.calls.length).toBe(callsDuringSlow)

    // 慢拍失败 settle → streak 只 +1；此后 3 拍全败（累计 4）仍未终态，第 4 拍才达 5
    rejectSlow(new Error('down'))
    await flushPromises()
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1500)
      await flushPromises()
      expect(wrapper.find('.rag-status').text()).not.toContain('索引状态获取失败')
    }
    vi.advanceTimersByTime(1500) // 第 5 次失败 settle → 终态
    await flushPromises()
    expect(wrapper.find('.rag-status').text()).toContain('索引状态获取失败，请稍后重试')
    wrapper.unmount()
  })
})

// R28-22（二十八轮）：重建先清库再后台建（服务端不动）——建索引期失败时旧索引已删、
// 新索引未成，recall 归零但普通「索引失败」文案不明示。修复后：本组件触发过重建且未见
// 成功结果、最近结果 ok=false 且不在构建中 → 补「已清空 / 可重试 / 正文不受影响」提示；
// 非本组件触发的失败不提示（数据无「已清空」字段，保守面不误报，见组件注释）。
describe('R28-22（二十八轮）：重建失败「索引已清空」提示', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('触发重建后最近结果失败 → 提示出现且含出路；构建中不显示', async () => {
    vi.useFakeTimers()
    usePrefsStore().setRagEnabled(true)
    mocks.triggerRagBuild.mockResolvedValue({ ok: true })
    const wrapper = await mountOpen()
    await wrapper.find('.rag-build-row button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('构建中')
    expect(wrapper.find('.rag-rebuild-hint').exists()).toBe(false) // 构建中不提示

    mocks.getRagStatus.mockResolvedValue({
      running: false, indexedChapters: 0, chunkCount: 0, model: null,
      ragConfig: {}, providerName: null, legacy: false,
      lastResult: { ok: false, chunkCount: 0, chapterCount: 0, error: '嵌入配额超限' },
    })
    vi.advanceTimersByTime(1500)
    await flushPromises()

    expect(wrapper.find('.rag-status').text()).toContain('索引失败：嵌入配额超限')
    const hint = wrapper.find('.rag-rebuild-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('已清空')
    expect(hint.text()).toContain('重试')
    expect(hint.text()).toContain('正文不受影响')
    wrapper.unmount()
  })

  it('非本组件触发的失败（打开页面即读到 lastResult 失败）→ 不提示（不误报）', async () => {
    usePrefsStore().setRagEnabled(true)
    mocks.getRagStatus.mockResolvedValue({
      running: false, indexedChapters: 0, chunkCount: 0, model: null,
      ragConfig: {}, providerName: null, legacy: false,
      lastResult: { ok: false, chunkCount: 0, chapterCount: 0, error: '历史失败' },
    })
    const wrapper = await mountOpen()
    expect(wrapper.find('.rag-status').text()).toContain('索引失败')
    expect(wrapper.find('.rag-rebuild-hint').exists()).toBe(false)
    wrapper.unmount()
  })

  it('触发重建后最近结果成功 → 提示不出现（触发记忆已撤销）', async () => {
    vi.useFakeTimers()
    usePrefsStore().setRagEnabled(true)
    mocks.triggerRagBuild.mockResolvedValue({ ok: true })
    const wrapper = await mountOpen()
    await wrapper.find('.rag-build-row button').trigger('click')
    await flushPromises()

    mocks.getRagStatus.mockResolvedValue({
      running: false, indexedChapters: 3, chunkCount: 12, model: null,
      ragConfig: {}, providerName: null, legacy: false,
      lastResult: { ok: true, chunkCount: 12, chapterCount: 3 },
    })
    vi.advanceTimersByTime(1500)
    await flushPromises()

    expect(wrapper.find('.rag-status').text()).toContain('已索引 3 章')
    expect(wrapper.find('.rag-rebuild-hint').exists()).toBe(false)
    wrapper.unmount()
  })

  it('切书后触发记忆复位：A 书失败提示不串到 B 书', async () => {
    vi.useFakeTimers()
    const ui = useUiStore()
    const ws = useWorkspaceStore()
    const prefs = usePrefsStore()
    prefs.setRagEnabled(true)
    ui.settingsOpen = true
    ws.bookName = '甲书'
    mocks.triggerRagBuild.mockResolvedValue({ ok: true })
    mocks.getRagStatus.mockResolvedValue({
      running: false, indexedChapters: 0, chunkCount: 0, model: null,
      ragConfig: {}, providerName: null, legacy: false,
      lastResult: { ok: false, chunkCount: 0, chapterCount: 0, error: '嵌入失败' },
    })
    const wrapper = mount(SettingsBookAnalysis, {
      global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
    })
    await flushPromises()
    // 甲书：手动触发一次重建（触发记忆置位），下一拍轮询读回失败 → 提示出现
    await wrapper.find('.rag-build-row button').trigger('click')
    await flushPromises()
    vi.advanceTimersByTime(1500)
    await flushPromises()
    expect(wrapper.find('.rag-rebuild-hint').exists()).toBe(true)

    // 切到乙书：watch 换书复位触发记忆 → 乙书虽也读到失败 lastResult，但不带甲书提示
    mocks.getConfig.mockResolvedValue({ kind: 'long', book: { title: '乙书' } } satisfies BookConfig)
    ws.bookName = '乙书'
    await flushPromises()
    expect(wrapper.find('.rag-rebuild-hint').exists()).toBe(false)
    wrapper.unmount()
  })
})
