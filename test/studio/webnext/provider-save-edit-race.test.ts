// @vitest-environment happy-dom
/**
 * 0918独立重评修复批（F001）回归：AiServicePanel.save() 的 add→update 分支竞态。
 *
 * 修复前：save() 两行各读一次 editedId.value——add 在途窗口内用户点行「编辑」改写
 * editedId 后，第二行重新求值走 update 分支，把新增草稿（含 apiKey）写进他行。
 * 修复后：首个 await 前钉定 editTarget，分支与目标全函数用钉定值。
 *
 * mock 面对齐 settings-service-provider.test.ts / r73-double-submit-guards.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderConfDto, TierConfig } from '../../../src/studio/web-next/src/api/providers'
import AiServicePanel from '../../../src/studio/web-next/src/components/ui/AiServicePanel.vue'

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

function provider(id: string, name: string): ProviderConfDto {
  return {
    id,
    name,
    protocol: 'openai',
    baseUrl: `https://${id}.local/v1`,
    apiKey: '',
    apiKeyMasked: 'sk-1...abcd',
    hasKey: true,
    caps: null,
    models: [],
  }
}

/** 手动决议的 Promise（挂起 add/update 制造在途窗口） */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
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
  mocks.getRagProviders.mockResolvedValue({ ragProviders: [], revision: 0 })
  mocks.fetchModels.mockResolvedValue({ models: ['gpt-5', 'gpt-4o'] })
})

describe('F001: save() add→update 分支竞态（editTarget 钉定）', () => {
  it('add 在途窗口内点行「编辑」→ update 不被误触发，add 流程正常收尾', async () => {
    const req = pending<{ provider: ProviderConfDto; revision: number }>()
    mocks.createProvider.mockReturnValue(req.promise)
    const w = mount(AiServicePanel, { attachTo: document.body })
    await flushPromises()

    // 开新增卡，填表并提交（第一笔挂起在途）
    await w.find('.group-title .add-btn').trigger('click')
    await flushPromises()
    const card = w.find('.add-provider-card')
    expect(card.exists()).toBe(true)
    // 表单骨架输入序：API Key（主字段）→ 名称 → API 地址（r73 同款）
    const inputs = card.findAll('input')
    await inputs[0]!.setValue('sk-secret-add-key')
    await inputs[1]!.setValue('测试家')
    await inputs[2]!.setValue('https://api.test/v1')
    await card.find('.save-btn').trigger('click')
    expect(mocks.createProvider).toHaveBeenCalledTimes(1)

    // 在途窗口内点 p1 行「编辑」→ editedId 被改写（修复前 :163 重读走 update 分支的诱因）
    await w.findAll('.provider-row')[0]!.find('.mini-btn[data-tip="编辑"]').trigger('click')
    await flushPromises()
    expect(w.find('.row-inline-editor').exists()).toBe(true) // 编辑槽已开

    // add resolve → 修复后按钉定的「新增」分支收尾
    req.resolve({ provider: provider('p9', '测试家'), revision: 1 })
    await flushPromises()

    expect(mocks.updateProvider).not.toHaveBeenCalled() // 修复点：update 未以 add 载荷被调
    expect(mocks.createProvider).toHaveBeenCalledTimes(1)
    // add 流程正常收尾：新增卡关闭 + store.refresh（getProviders 二次拉取）已发生
    expect(w.find('.add-provider-card').exists()).toBe(false)
    expect(mocks.getProviders).toHaveBeenCalledTimes(2)
    w.unmount()
  })

  it('对照：update 在途窗口内改点他行「编辑」→ update 仍落原目标（载荷不串行）', async () => {
    const req = pending<{ provider: ProviderConfDto; revision: number }>()
    mocks.updateProvider.mockReturnValue(req.promise)
    const w = mount(AiServicePanel, { attachTo: document.body })
    await flushPromises()

    // 展开 p1 编辑并保存（update 挂起在途）
    await w.findAll('.provider-row')[0]!.find('.mini-btn[data-tip="编辑"]').trigger('click')
    await flushPromises()
    await w.find('.row-inline-editor .form-actions .save-btn').trigger('click')
    expect(mocks.updateProvider).toHaveBeenCalledTimes(1)
    expect(mocks.updateProvider.mock.calls[0]![0]).toBe('p1')

    // 在途窗口内改点 p2 行「编辑」→ editedId 切到 p2
    await w.findAll('.provider-row')[1]!.find('.mini-btn[data-tip="编辑"]').trigger('click')
    await flushPromises()

    req.resolve({ provider: provider('p1', '甲家改'), revision: 1 })
    await flushPromises()

    // 修复点：update 目标钉定为发起时的 p1，不随 editedId 漂移到 p2
    expect(mocks.updateProvider).toHaveBeenCalledTimes(1)
    expect(mocks.updateProvider.mock.calls[0]![0]).toBe('p1')
    expect(mocks.createProvider).not.toHaveBeenCalled()
    w.unmount()
  })
})
