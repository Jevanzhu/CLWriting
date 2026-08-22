// @vitest-environment happy-dom
/**
 * AiServicePanel（「设置 · 服务提供方」面板）卡片化交互测试（阶段 14 第二步 §四，照搬 DSH ModelsSection）：
 *  - 列表即卡片、列表始终可见（编辑/新增都不切视图、不弹全屏）；
 *  - 「编辑」/行尾展开钮切单值互斥就地进行编辑（开一张收另一张）；
 *  - 「新增」= 列表下方新增卡（内嵌空白编辑器），与任一展开行互斥。
 * 数据层走统一 store（getProviders/getRagProviders/... 全 mock）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderConfDto, RagProviderDto, TierConfig } from '../../../src/studio/web-next/src/api/providers'
import AiServicePanel from '../../../src/studio/web-next/src/components/ui/AiServicePanel.vue'

// ── mock：provider 数据层 + AI 可达性探测 ──
const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getRagProviders: vi.fn(),
  fetchModels: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setCurrentProvider: vi.fn(),
  testProvider: vi.fn(),
  setTiers: vi.fn(),
  setChatTier: vi.fn(),
  createRagProvider: vi.fn(),
  updateRagProvider: vi.fn(),
  deleteRagProvider: vi.fn(),
  testRagProvider: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/providers', () => ({
  getProviders: mocks.getProviders,
  getRagProviders: mocks.getRagProviders,
  fetchModels: mocks.fetchModels,
  createProvider: mocks.createProvider,
  updateProvider: mocks.updateProvider,
  deleteProvider: mocks.deleteProvider,
  setCurrentProvider: mocks.setCurrentProvider,
  testProvider: mocks.testProvider,
  setTiers: mocks.setTiers,
  setChatTier: mocks.setChatTier,
  createRagProvider: mocks.createRagProvider,
  updateRagProvider: mocks.updateRagProvider,
  deleteRagProvider: mocks.deleteRagProvider,
  testRagProvider: mocks.testRagProvider,
}))

vi.mock('../../../src/studio/web-next/src/api/ai-status', () => ({
  getAiStatus: vi.fn().mockResolvedValue({ available: true, driver: 'mock' }),
}))

const baseTiers: TierConfig = {
  creative: { model: 'gpt-5', effort: 'xhigh' },
  assistant: null,
  chat: null,
}

function provider(id: string, name: string, overrides: Partial<ProviderConfDto> = {}): ProviderConfDto {
  return {
    id,
    name,
    protocol: 'openai',
    baseUrl: `https://${id}.local/v1`,
    apiKey: '',
    apiKeyMasked: 'sk-1...abcd',
    hasKey: true,
    caps: null,
    ...overrides,
  }
}

function ragProvider(id: string, name: string): RagProviderDto {
  return { id, name, endpoint: `https://${id}.local/v1/embeddings`, model: 'embed-a', apiKey: '', apiKeyMasked: 'sk-e...abcd', hasKey: true, caps: null }
}

async function mountPanel(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(AiServicePanel, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getProviders.mockResolvedValue({
    providers: [provider('p1', '甲家'), provider('p2', '乙家')],
    currentId: 'p1',
    currentModel: 'gpt-5',
    tiers: baseTiers,
    revision: 0,
  })
  mocks.getRagProviders.mockResolvedValue({ ragProviders: [ragProvider('r1', '嵌入甲')], revision: 0 })
  mocks.fetchModels.mockResolvedValue({ models: ['gpt-5', 'gpt-4o'] })
  mocks.setCurrentProvider.mockResolvedValue({ ok: true, currentId: 'p2' })
})

describe('AiServicePanel 卡片化交互（照搬 DSH）', () => {
  it('列表即卡片：多提供方各一行，列表常驻可见', async () => {
    const wrapper = await mountPanel()
    const rows = wrapper.findAll('.ai-service-panel .provider-row')
    expect(rows).toHaveLength(2)
    expect(wrapper.text()).toContain('甲家')
    expect(wrapper.text()).toContain('乙家')
    // 默认无卡片展开、无新增卡
    expect(wrapper.find('.row-inline-editor').exists()).toBe(false)
    expect(wrapper.find('.add-provider-card').exists()).toBe(false)
  })

  it('「编辑」就地单卡展开：点一张开、点另一张互斥收起；列表始终可见', async () => {
    const wrapper = await mountPanel()
    // 点「编辑」甲家 → 就地展开
    await wrapper.findAll('.provider-row').at(0)!.find('.mini-btn[data-tip="编辑"]').trigger('click')
    await flushPromises()
    // 列表仍在（两张行卡都在），编辑器内嵌该行下方
    expect(wrapper.findAll('.ai-service-panel .provider-row')).toHaveLength(2)
    expect(wrapper.findAll('.row-inline-editor')).toHaveLength(1)
    // 展开不打上游：模型清单预热归 ModelListEditor 按需「获取模型」（dsh 语义），
    // 展开只是切 editedId 单值——fetchModels 不应被调
    expect(mocks.fetchModels).not.toHaveBeenCalled()

    // 点「编辑」乙家 → 单值互斥：甲家收起，乙家展开
    await wrapper.findAll('.provider-row').at(1)!.find('.mini-btn[data-tip="编辑"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.row-inline-editor')).toHaveLength(1)
    const expandedRow = wrapper.findAll('.provider-row').find((r) => r.classes().includes('expanded'))
    expect(expandedRow?.text()).toContain('乙家')
  })

  it('「新增」= 列表下方新增卡：列表保持可见，且开新增收任一展开行', async () => {
    const wrapper = await mountPanel()
    // 先展开甲家
    await wrapper.findAll('.provider-row').at(0)!.find('.mini-btn[data-tip="编辑"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.row-inline-editor')).toHaveLength(1)

    // 点「添加」→ 新增卡出现在列表下方，展开行被收起，列表仍在
    await wrapper.find('.ai-service-panel > .group-title .add-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.add-provider-card').exists()).toBe(true)
    expect(wrapper.findAll('.row-inline-editor')).toHaveLength(0)
    expect(wrapper.findAll('.ai-service-panel .provider-row')).toHaveLength(2)
    // 新增卡内嵌空白编辑器（新增态，标题「新增提供方」）
    expect(wrapper.find('.add-provider-card').text()).toContain('新增提供方')
  })

  it('展开行内「取消」收行；新增卡「取消」关卡、列表不动', async () => {
    const wrapper = await mountPanel()
    // 展开甲家 → 取消
    await wrapper.findAll('.provider-row').at(0)!.find('.mini-btn[data-tip="编辑"]').trigger('click')
    await flushPromises()
    await wrapper.find('.row-inline-editor .cancel-btn').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.row-inline-editor')).toHaveLength(0)
    expect(wrapper.findAll('.ai-service-panel .provider-row')).toHaveLength(2)

    // 新增卡 → 取消
    await wrapper.find('.ai-service-panel > .group-title .add-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.add-provider-card').exists()).toBe(true)
    await wrapper.find('.add-provider-card .cancel-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.add-provider-card').exists()).toBe(false)
    expect(wrapper.findAll('.ai-service-panel .provider-row')).toHaveLength(2)
  })
})