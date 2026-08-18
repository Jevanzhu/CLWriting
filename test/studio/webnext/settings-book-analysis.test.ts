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
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
