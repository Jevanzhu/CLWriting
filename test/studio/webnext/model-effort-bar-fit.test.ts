// @vitest-environment happy-dom
/**
 * ModelEffortBar fitSelect 测宽行为（happy-dom）。
 * （原 r42-shell-mount 的 R42-28 节，按行为单拆。）
 *
 * R42-28（四十二轮）：fitSelect 测宽取选中项显示文本——value 与 label 不同时
 * （value=模型 id slug、label=显示名），测量 span 的文本应为 label。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// api/providers：useChatTier 单例首建即 refresh()，mock 掉防 happy-dom 真发网络请求
const providerMocks = vi.hoisted(() => ({ getProviders: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/providers', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/studio/web-next/src/api/providers')
  >()
  return { ...actual, getProviders: providerMocks.getProviders }
})

import ModelEffortBar from '../../../src/studio/web-next/src/components/ui/ModelEffortBar.vue'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import type { ProvidersResponse } from '../../../src/studio/web-next/src/api/providers'

const MODEL_ID = 'model-slug-uuid-long'
const MODEL_LABEL = '显示名甲'

const PROVIDERS: ProvidersResponse = {
  providers: [
    {
      id: 'p1',
      name: '测试提供方',
      protocol: 'openai',
      baseUrl: 'http://localhost:1',
      apiKey: '',
      apiKeyMasked: '',
      hasKey: true,
      caps: null,
      models: [{ id: MODEL_ID, name: MODEL_LABEL }],
    },
  ],
  currentId: 'p1',
  currentModel: MODEL_ID,
  tiers: { creative: { model: MODEL_ID, effort: 'high' }, assistant: null, chat: null },
  revision: 0,
}

describe('R42-28 ModelEffortBar：fitSelect 测宽取选中项显示文本', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    providerMocks.getProviders.mockReset().mockResolvedValue(PROVIDERS)
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('label ≠ value 时测量 span 的文本用 label（显示名），不用 value（模型 id）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    // 预置 provider store（单例 useChatTier 挂载时绑定同一 active pinia）
    const store = useProviderStore()
    store.providers = PROVIDERS.providers
    store.currentId = 'p1'
    store.tiers = PROVIDERS.tiers

    // document.body.appendChild 的 call-through 侦听：fitSelect 的测量 span 创建即移除，
    // 从 spy 调用参数取文本（span 挂过 body，事后已被 removeChild 不影响 node 引用可读）
    const appendSpy = vi.spyOn(document.body, 'appendChild')
    wrapper = mount(ModelEffortBar, { global: { plugins: [pinia] } })
    await flushPromises() // 单例首建 refresh()（mock 回填同值）
    await nextTick() // onMounted 的 nextTick → fitSelect

    const spanTexts = appendSpy.mock.calls
      .map(([node]) => node)
      .filter((n): n is HTMLSpanElement => n instanceof HTMLSpanElement)
      .map((s) => s.textContent)
    expect(spanTexts).toContain(MODEL_LABEL) // 测宽按显示文本
    expect(spanTexts).not.toContain(MODEL_ID) // 不再按 value（slug）测宽
  })
})
