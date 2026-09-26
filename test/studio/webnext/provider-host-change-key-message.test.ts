// @vitest-environment happy-dom
/**
 * RC 源码重审 B-4（Opus-5.5 轮）前端面：作者改 API 地址主机、Key 留空，服务端以
 * 400 API_KEY_REQUIRED_ON_HOST_CHANGE 拒绝时，「主机已变更，请重新填写 API Key」必须
 * 原样上屏——否则作者只看到保存没生效，不知道要重填 Key（本批不改编辑器交互：拒绝原因
 * 由服务端给，friendlyError 对带码 ApiError 直出服务端 message，前端零改动即通）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderConfDto, RagProviderDto, TierConfig } from '../../../src/studio/web-next/src/api/providers'

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

vi.mock('../../../src/studio/web-next/src/api/providers', () => mocks)
vi.mock('../../../src/studio/web-next/src/api/ai-status', () => ({
  getAiStatus: vi.fn().mockResolvedValue({ available: true, driver: 'mock' }),
}))

import AiServicePanel from '../../../src/studio/web-next/src/components/ui/AiServicePanel.vue'
import Toast from '../../../src/studio/web-next/src/components/ui/Toast.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { ApiError } from '../../../src/studio/web-next/src/api/client'

/** 服务端拒绝文案（逐字取自 src/studio/server/api/host-change-guard.ts 的单源常量——
 *  RC 源码重审 B-4 同型补洞后 providers/rag-providers 两族共用同一份，providers.ts
 *  经 API_KEY_HOST_CHANGE_MESSAGE 引用，不再就地字面量） */
const SERVER_MSG = 'API 地址的主机已变更，为防止已存 Key 被发往新主机，请重新填写 API Key'

const baseTiers: TierConfig = { creative: { model: 'gpt-5', effort: 'xhigh' }, assistant: null, chat: null }

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
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getProviders.mockResolvedValue({
    providers: [provider('p1', '甲家')],
    currentId: 'p1',
    currentModel: 'gpt-5',
    tiers: baseTiers,
    revision: 0,
  })
  mocks.getRagProviders.mockResolvedValue({ ragProviders: [] as RagProviderDto[], revision: 0 })
  mocks.fetchModels.mockResolvedValue({ models: [] })
})

describe('RC B-4：主机变更被拒时拒绝原因上屏', () => {
  it('改主机 + Key 留空 → 服务端 400 文案原样进 toast（不落进通用「保存失败」）', async () => {
    // 服务端信封：专用码 + 中文人话（ApiError 三参形状 = apiJson 解析信封后的产物）
    mocks.updateProvider.mockRejectedValue(new ApiError(SERVER_MSG, 400, 'API_KEY_REQUIRED_ON_HOST_CHANGE'))

    const wrapper = mount(AiServicePanel, { attachTo: document.body })
    await flushPromises()

    // 展开行内编辑卡 → 只改 API 地址（主机换掉），Key 输入留空
    await wrapper.findAll('.provider-row').at(0)!.find('.mini-btn[data-tip="编辑"]').trigger('click')
    await flushPromises()
    const editor = wrapper.find('.row-inline-editor')
    expect(editor.exists()).toBe(true)
    await editor.find('input[placeholder="https://..."]').setValue('https://api.host-b.example/v1')
    await editor.find('.form-actions .save-btn').trigger('click')
    await flushPromises()

    // 请求确实带着「新主机 + 空 Key」出去（触发服务端闸的那一笔）
    expect(mocks.updateProvider).toHaveBeenCalledTimes(1)
    expect(mocks.updateProvider.mock.calls[0]![1]).toMatchObject({
      baseUrl: 'https://api.host-b.example/v1',
      apiKey: '',
    })

    // 文案上屏：ui store 原样透出（friendlyError 对带码 ApiError 直出 message）
    const ui = useUiStore()
    const last = ui.toasts.at(-1)!
    expect(last.kind).toBe('error')
    expect(last.msg).toBe(SERVER_MSG)

    // DOM 面：全局 Toast 渲染同一句（作者真正看得到的字）
    mount(Toast, { attachTo: document.body })
    await flushPromises()
    expect(document.body.textContent).toContain(SERVER_MSG)
  })
})
