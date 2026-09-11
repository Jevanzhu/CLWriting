// @vitest-environment happy-dom
/**
 * R1010b（2026-09-10 全量代码重审与内存专项重审修复批，GLM-5.3）：
 *
 * - R1010b-FTC-P3-1：FontPicker typeahead 定时器卸载随清——本域 timer 纪律唯一偏离点
 *   （对照 TooltipHost showTimer / OnboardPremise premiseTimer 先例），800ms 清窗定时器
 *   在途时卸载则回调滞留。断言卸载后 vi.getTimerCount() 归零（在途定时器不再滞留）。
 * - R1010b-FTC-P3-2：异步动作 await 后写已卸载实例 ref——三代表例（AiServicePanel
 *   refreshAll→syncTierForm / ModelListEditor fetchList 的 busy·failure·showPicker /
 *   WbUsageCard load 的 byTask·total·cost·loaded）补 armed 单门。手法对齐
 *   dead-instance-guard.test.ts 的 pending 手动放行（挂载→卸载→resolve）；组件内 ref
 *   经内部实例 setupState 读（proxyRefs 解包，卸载后存续可读），断言迟到续体不触达
 *   内部态 + 未卸载对照路径照常写回（armed 不误伤）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── FontPicker（P3-1）：win 自绘路径须 isWin=true（对齐 font-picker.test.ts 的 mock） ──
vi.mock('../../../src/studio/web-next/src/composables/usePlatform', () => ({
  usePlatform: () => ({ isWin: true, isMac: false }),
}))

// ── WbUsageCard（P3-2）：取数 API mock ──
const usageMocks = vi.hoisted(() => ({
  getTraceStats: vi.fn(),
  getCostStats: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => ({
  getTraceStats: usageMocks.getTraceStats,
}))
vi.mock('../../../src/studio/web-next/src/api/cost-stats', () => ({
  getCostStats: usageMocks.getCostStats,
}))

// ── ModelListEditor + AiServicePanel（P3-2）：api/providers 全量具名导出 mock
//    （store 模块级 import 缺一即崩；清单同 settings-service-provider.test.ts） ──
const apiMocks = vi.hoisted(() => ({
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
vi.mock('../../../src/studio/web-next/src/api/providers', () => apiMocks)
vi.mock('../../../src/studio/web-next/src/api/ai-status', () => ({
  getAiStatus: vi.fn().mockResolvedValue({ available: true, driver: 'mock' }),
}))

import FontPicker from '../../../src/studio/web-next/src/components/ui/FontPicker.vue'
import WbUsageCard from '../../../src/studio/web-next/src/components/workbench/WbUsageCard.vue'
import ModelListEditor from '../../../src/studio/web-next/src/components/ui/ModelListEditor.vue'
import AiServicePanel from '../../../src/studio/web-next/src/components/ui/AiServicePanel.vue'

/** 起一个手动放行的 Promise（模拟在途请求；手法同 dead-instance-guard.test.ts） */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** 读 script setup 内部态（ref 经 proxyRefs 解包；卸载后内部实例存续仍可读；
 *  setupState 未入公开类型，转换手法同 r34d-settingsmodal-revision.test.ts 的 vm.$ 取 provides） */
function setupState(w: { vm: ComponentPublicInstance }): Record<string, unknown> {
  return (w.vm.$ as unknown as { setupState: Record<string, unknown> }).setupState
}

let wrapper: ReturnType<typeof mount> | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

// ── R1010b-FTC-P3-1：typeahead 定时器卸载随清 ──────────────────────────

describe('R1010b-FTC-P3-1: FontPicker typeahead 定时器卸载清理', () => {
  const PROPS = {
    value: '',
    fonts: ['Font0', 'Font1', 'Font2'],
    placeholder: '默认字体',
    display: (f: string): string => f,
  }

  it('800ms 清窗定时器在途时卸载 → 定时器随清不滞留（对齐 TooltipHost/OnboardPremise 惯例）', async () => {
    vi.useFakeTimers()
    try {
      wrapper = mount(FontPicker, { props: PROPS })
      await wrapper.find('button.font-picker').trigger('click') // 开菜单（键盘收口仅在 open 态）
      const base = vi.getTimerCount()
      // typeahead：可打印字符起 800ms 清窗定时器
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }))
      await nextTick()
      expect(vi.getTimerCount()).toBe(base + 1) // 在途：清窗定时器挂起
      wrapper.unmount()
      wrapper = null // 本用例已手卸，交还 afterEach 前先清引用（防二次 unmount）
      expect(vi.getTimerCount()).toBe(base) // 修复点：卸载随清，不再滞留 800ms
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── R1010b-FTC-P3-2：await 后写已卸载实例 ref（armed 单门） ─────────────

const COST_OFF = { enabled: false, total: 0, byDay: {}, byTask: {}, byChapter: {}, unpricedModels: [] }

function tracePayload(): { total: number; byTask: Record<string, unknown>; ruleHits: string[] } {
  return {
    total: 15,
    byTask: {
      outline: {
        count: 3,
        successRate: 0.67,
        avgAttempts: 1,
        durationP50: 800,
        durationP95: 1500,
        totalInputTokens: 12_000,
        totalOutputTokens: 3_000,
        byDay: { '2026-08-19': { count: 3, successRate: 1, tokens: 1 } },
      },
    },
    ruleHits: [],
  }
}

describe('R1010b-FTC-P3-2: WbUsageCard load 卸载不写回', () => {
  beforeEach(() => {
    // R0912-FE-P3-4：WbUsageCard 改走 trace-stats 共享 store——挂载需活动 pinia
    setActivePinia(createPinia())
    usageMocks.getTraceStats.mockReset()
    usageMocks.getCostStats.mockReset()
  })

  it('取数在途卸载 → 迟到响应不写回死实例（byTask/total/cost/loaded 全门）', async () => {
    const req = pending<{ total: number; byTask: Record<string, unknown>; ruleHits: string[] }>()
    usageMocks.getTraceStats.mockReturnValue(req.promise)
    usageMocks.getCostStats.mockResolvedValue({ enabled: true, currency: 'USD', total: 9.9, byDay: {}, byTask: {}, byChapter: {}, unpricedModels: [] })

    wrapper = mount(WbUsageCard, { props: { bookName: '测试书' } })
    await nextTick() // onMounted load 已发起（请求在途）
    wrapper.unmount() // armed 置 false
    req.resolve(tracePayload())
    await flushPromises()

    const st = setupState(wrapper)
    expect(st.total).toBe(0) // 初值未动
    expect(st.byTask).toEqual({})
    expect(st.cost).toBeNull()
    expect(st.loaded).toBe(false) // finally 的 loaded 置位同门拦下
  })

  it('对照：未卸载 → 迟到响应照常写回（armed 不误伤）', async () => {
    usageMocks.getTraceStats.mockResolvedValue(tracePayload())
    usageMocks.getCostStats.mockResolvedValue(COST_OFF)
    wrapper = mount(WbUsageCard, { props: { bookName: '测试书' } })
    await flushPromises()
    const st = setupState(wrapper)
    expect(st.total).toBe(15)
    expect(st.loaded).toBe(true)
  })
})

describe('R1010b-FTC-P3-2: ModelListEditor fetchList 卸载不写回', () => {
  const PROPS = {
    modelValue: [],
    probe: { protocol: 'openai' as const, baseUrl: 'https://x.local/v1', apiKey: 'sk-x' },
  }

  beforeEach(() => {
    apiMocks.fetchModels.mockReset()
  })

  it('探测在途卸载 → busy/failure/showPicker 不写回死实例', async () => {
    const req = pending<{ models: string[] }>()
    apiMocks.fetchModels.mockReturnValue(req.promise)
    wrapper = mount(ModelListEditor, { props: PROPS })

    await wrapper.find('.chip-btn').trigger('click') // fetchList：busy 同步置位，请求在途
    expect(setupState(wrapper).busy).toBe(true)
    wrapper.unmount() // armed 置 false
    req.resolve({ models: ['m1', 'm2'] })
    await flushPromises()

    const st = setupState(wrapper)
    expect(st.busy).toBe(true) // finally 的 busy 复位被门拦下
    expect(st.showPicker).toBe(false) // 勾选弹窗不落死实例
    expect(st.failure).toBeUndefined()
  })

  it('对照：未卸载 → 探测结果照常落弹窗、busy 复位（armed 不误伤）', async () => {
    apiMocks.fetchModels.mockResolvedValue({ models: ['m1', 'm2'] })
    wrapper = mount(ModelListEditor, { props: PROPS })
    await wrapper.find('.chip-btn').trigger('click')
    await flushPromises()
    const st = setupState(wrapper)
    expect(st.busy).toBe(false)
    expect(st.showPicker).toBe(true)
    expect(st.candidates).toEqual(['m1', 'm2'])
  })
})

describe('R1010b-FTC-P3-2: AiServicePanel refreshAll 卸载不写回', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiMocks.getProviders.mockReset()
    apiMocks.getRagProviders.mockReset()
  })

  it('refreshAll 在途卸载 → 迟到刷新不写回死实例档位草稿', async () => {
    const req = pending<Record<string, unknown>>()
    apiMocks.getProviders.mockReturnValue(req.promise)
    apiMocks.getRagProviders.mockResolvedValue({ ragProviders: [], revision: 0 })
    wrapper = mount(AiServicePanel)
    await nextTick() // onMounted refreshAll 已发起（getProviders 在途）
    wrapper.unmount() // armed 置 false
    req.resolve({
      providers: [],
      currentId: 'p1',
      currentModel: 'gpt-5',
      tiers: { creative: { model: 'gpt-5', effort: 'xhigh' }, assistant: null, chat: null },
      revision: 0,
    })
    await flushPromises()

    const st = setupState(wrapper)
    expect((st.tierForm as { creative: { model: string } }).creative.model).toBe('') // syncTierForm 未触达（初值空模型）
    expect(st.assistantEnabled).toBe(false)
  })

  it('对照：未卸载 → 刷新后档位草稿照常同步（armed 不误伤）', async () => {
    apiMocks.getProviders.mockResolvedValue({
      providers: [],
      currentId: 'p1',
      currentModel: 'gpt-5',
      tiers: { creative: { model: 'gpt-5', effort: 'xhigh' }, assistant: null, chat: null },
      revision: 0,
    })
    apiMocks.getRagProviders.mockResolvedValue({ ragProviders: [], revision: 0 })
    wrapper = mount(AiServicePanel)
    await flushPromises()
    expect((setupState(wrapper).tierForm as { creative: { model: string } }).creative.model).toBe('gpt-5')
  })
})
