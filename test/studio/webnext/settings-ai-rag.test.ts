// @vitest-environment happy-dom
/**
 * SettingsAnalysis（「设置 · 智能分析」全局页）交互测试：
 * AI 机检（短篇严格模式）/ 关系图（自动梳理/增量阈值）/ 知识检索（启用/提供方）的全局默认组
 * 直写 prefs store（不触发 saveConfig）。IA 重组后本书覆盖组建索引等断言拆到 settings-book-analysis.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsAnalysis from '../../../src/studio/web-next/src/components/ui/SettingsAnalysis.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

const mocks = vi.hoisted(() => ({
  getRagProviders: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/providers', () => ({
  getRagProviders: mocks.getRagProviders,
}))

/** 打开设置（触发 watch 拉提供方列表）。全局页不依赖当前书。 */
async function mountOpen(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  ui.settingsOpen = true
  const wrapper = mount(SettingsAnalysis, {
    global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getRagProviders.mockResolvedValue({
    ragProviders: [
      { id: 'rag-a', name: 'A 家嵌入', endpoint: 'https://a/v1/embeddings', model: 'embed-a', apiKey: '', apiKeyMasked: 'sk-1...abcd', caps: null },
      { id: 'rag-b', name: 'B 家嵌入', endpoint: 'https://b/v1/embeddings', model: 'embed-b', apiKey: '', apiKeyMasked: 'sk-2...efgh', caps: null },
    ],
  })
})

describe('SettingsAnalysis 知识检索全局默认', () => {
  it('启用检索 → 写 prefs.ragEnabled（不触发 saveConfig）', async () => {
    const wrapper = await mountOpen()
    const sw = wrapper.find('input[aria-label="启用知识检索（全局默认）"]')
    expect(sw.exists()).toBe(true)
    await sw.setValue(true)
    expect(usePrefsStore().ragEnabled).toBe(true)
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('检索提供方下拉列出服务商，选中写 prefs.ragProvider', async () => {
    const wrapper = await mountOpen()
    const select = wrapper.find('select[aria-label="检索提供方（全局默认）"]')
    expect(select.findAll('option').filter((o) => o.element.value === 'rag-a')).toHaveLength(1)
    await select.setValue('rag-b')
    expect(usePrefsStore().ragProvider).toBe('rag-b')
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('无可用服务商 → 引导去「服务提供方」页添加', async () => {
    mocks.getRagProviders.mockResolvedValue({ ragProviders: [] })
    const wrapper = await mountOpen()
    expect(wrapper.text()).toContain('尚未配置嵌入提供方')
  })

  it('全局页不含本书覆盖组（无「本书使用独立设定」开关，无建索引入口）', async () => {
    const wrapper = await mountOpen()
    expect(wrapper.find('input[aria-label="知识检索使用独立设定"]').exists()).toBe(false)
    expect(wrapper.find('input[aria-label="关系图使用独立设定"]').exists()).toBe(false)
    expect(wrapper.find('.rag-build-row').exists()).toBe(false)
  })
})

describe('SettingsAnalysis 短篇严格模式全局默认', () => {
  it('开关 → 写 prefs.defaultShortStrict（不触发 saveConfig）', async () => {
    const wrapper = await mountOpen()
    await wrapper.find('input[aria-label="短篇严格模式（全局默认）"]').setValue(true)
    expect(usePrefsStore().defaultShortStrict).toBe(true)
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })
})

describe('SettingsAnalysis 关系图全局默认', () => {
  it('自动梳理/增量阈值写 prefs store', async () => {
    const wrapper = await mountOpen()
    await wrapper.find('input[aria-label="关系图自动梳理（全局默认）"]').setValue(true)
    await wrapper.find('input[aria-label="章节增量阈值（全局默认）"]').setValue('7')
    const prefs = usePrefsStore()
    expect(prefs.relationAutoMine).toBe(true)
    expect(prefs.relationMineThreshold).toBe(7)
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })
})
