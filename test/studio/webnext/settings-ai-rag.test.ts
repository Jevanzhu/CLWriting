// @vitest-environment happy-dom
/**
 * SettingsAi 知识检索服务商化交互测试：
 * - 书存 rag.provider（应用级服务商引用）→ 下拉选服务商写 provider 并清旧内联 endpoint/model
 * - 旧版内联配置（endpoint 直存）→ 显示「沿用」伪选项；选它不写任何东西
 * - 未启用检索 → 不渲染服务商下拉；无服务商 → 引导文案
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsAi from '../../../src/studio/web-next/src/components/ui/SettingsAi.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
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

/** 打开设置 + 切到一本书（触发 watch 拉配置与服务商列表）。 */
async function mountOpen(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const ws = useWorkspaceStore()
  ui.settingsOpen = true
  ws.bookName = '测试书'
  const wrapper = mount(SettingsAi, {
    global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
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

describe('SettingsAi 知识检索（服务商化）', () => {
  it('启用检索 + 有服务商 → 下拉列出服务商；选中写 rag.provider 并清旧内联（一次性迁移）', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书' },
      rag: { enabled: true, endpoint: 'https://legacy', model: 'old-model' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()

    const select = wrapper.find('select.rag-prov-select')
    expect(select.exists()).toBe(true)
    // 旧版内联 → 「沿用」伪选项存在且为当前值
    expect(select.find('option[value="__legacy__"]').exists()).toBe(true)
    expect((select.element as HTMLSelectElement).value).toBe('__legacy__')
    // 服务商选项按列表渲染
    expect(select.findAll('option').filter((o) => o.element.value === 'rag-a')).toHaveLength(1)

    // 选 A 家 → saveConfig 的 mutator 写 provider、删 endpoint/model
    let captured: ((c: BookConfig) => void) | undefined
    mocks.saveConfig.mockImplementation((mut: (c: BookConfig) => void) => {
      captured = mut
      return Promise.resolve()
    })
    await select.setValue('rag-a')
    await flushPromises()
    expect(captured).toBeDefined()
    const cfg = { rag: { enabled: true, endpoint: 'https://legacy', model: 'old-model' } } as BookConfig
    captured!(cfg)
    expect(cfg.rag?.provider).toBe('rag-a')
    expect(cfg.rag?.endpoint).toBeUndefined()
    expect(cfg.rag?.model).toBeUndefined()
  })

  it('已有 provider 引用 → 下拉当前值为该服务商', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书' },
      rag: { enabled: true, provider: 'rag-b' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const select = wrapper.find('select.rag-prov-select')
    expect((select.element as HTMLSelectElement).value).toBe('rag-b')
  })

  it('选「旧版内联配置（沿用）」→ 不触发任何写入', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书' },
      rag: { enabled: true, endpoint: 'https://legacy', model: 'old-model' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const select = wrapper.find('select.rag-prov-select')
    await select.setValue('__legacy__')
    await flushPromises()
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('未启用检索 → 不渲染服务商下拉', async () => {
    const wrapper = await mountOpen() // beforeEach 默认无 rag 段
    expect(wrapper.find('select.rag-prov-select').exists()).toBe(false)
  })

  it('无可用服务商 → 描述引导去「AI 服务商」页添加', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'long',
      book: { title: '测试书' },
      rag: { enabled: true },
    } satisfies BookConfig)
    mocks.getRagProviders.mockResolvedValue({ ragProviders: [] })
    const wrapper = await mountOpen()
    expect(wrapper.text()).toContain('尚未配置嵌入提供方')
  })

  it('启用检索开关 → saveConfig 写 rag.enabled', async () => {
    const wrapper = await mountOpen()
    let captured: ((c: BookConfig) => void) | undefined
    mocks.saveConfig.mockImplementation((mut: (c: BookConfig) => void) => {
      captured = mut
      return Promise.resolve()
    })
    const sw = wrapper.find('input[aria-label="启用知识检索"]')
    await sw.setValue(true)
    await flushPromises()
    expect(captured).toBeDefined()
    const cfg = {} as BookConfig
    captured!(cfg)
    expect(cfg.rag?.enabled).toBe(true)
  })
})
