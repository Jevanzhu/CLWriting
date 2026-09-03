// @vitest-environment happy-dom
/**
 * R42-32（四十二轮）最小面组件回归（前端组件 P3 组）：
 * - ModelEffortBar（R42-28）：fitSelect 测宽取选中项显示文本——value 与 label 不同时
 *   （value=模型 id slug、label=显示名），测量 span 的文本应为 label。
 * - TooltipHost（R42-29）：估宽按码位分类累加——同长度 ASCII 文案估宽 < 同长度 CJK
 *   文案。happy-dom 零矩形下 top 翻 bottom、left = 估宽/2 + 8，估宽经 left 可观察。
 * - Shelf 页（R42-31）：书架独立窗口 openBook IPC reject 被 catch——console.warn 留痕，
 *   不产生 unhandledrejection 抛穿。
 * mount 手法对齐既有组件直测（r29-components-zero-coverage / r36-23-shelf-keyboard）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── 模块 mock（对齐 focus-mode / book-watch-reentry 手法）──
// api/providers：useChatTier 单例首建即 refresh()，mock 掉防 happy-dom 真发网络请求
const providerMocks = vi.hoisted(() => ({ getProviders: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/providers', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/studio/web-next/src/api/providers')
  >()
  return { ...actual, getProviders: providerMocks.getProviders }
})

// api/shelf：Shelf 页 onMounted → shelf.load()，mock listBooks 供书卡渲染
const shelfMocks = vi.hoisted(() => ({
  listBooks: vi.fn(),
  deleteBook: vi.fn(),
  routerPush: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/shelf', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/studio/web-next/src/api/shelf')
  >()
  return { ...actual, listBooks: shelfMocks.listBooks, deleteBook: shelfMocks.deleteBook }
})
// vue-router 双注册（R61-20）：web-next 组件解析自己的 node_modules/vue-router，
// 别名钉同份；此处 mock 供 Shelf.vue 的 useRouter
vi.mock('vue-router', () => ({ useRouter: () => ({ push: shelfMocks.routerPush }) }))
vi.mock('../../../src/studio/web-next/node_modules/vue-router', () => ({
  useRouter: () => ({ push: shelfMocks.routerPush }),
}))

import ModelEffortBar from '../../../src/studio/web-next/src/components/ui/ModelEffortBar.vue'
import TooltipHost from '../../../src/studio/web-next/src/components/ui/TooltipHost.vue'
import Shelf from '../../../src/studio/web-next/src/pages/Shelf.vue'
import ShelfGrid from '../../../src/studio/web-next/src/components/ui/ShelfGrid.vue'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import type { ProvidersResponse } from '../../../src/studio/web-next/src/api/providers'
import type { BookEntry } from '../../../src/studio/web-next/src/api/shelf'

// ── R42-28：ModelEffortBar ─────────────────────────────────────────────

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

// ── R42-29：TooltipHost ────────────────────────────────────────────────

describe('R42-29 TooltipHost：估宽按码位分类（ASCII < CJK）', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  /** 悬停 data-tip → 250ms 延迟后返回 tip 的 left。
   *  happy-dom 零矩形：top 方向空间不足翻 bottom，x = 估宽/2 + 8（边缘检测收边），
   *  left 随估宽单调——估宽差异可观察。 */
  async function hoverTipLeft(text: string): Promise<number> {
    const trigger = document.createElement('button')
    trigger.dataset.tip = text
    document.body.appendChild(trigger)
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await nextTick()
    vi.advanceTimersByTime(250)
    await nextTick()
    const tip = document.querySelector('.tip-host')
    expect(tip, `悬停「${text}」后 tooltip 应显示`).not.toBeNull()
    return parseFloat((tip as HTMLElement).style.left)
  }

  it('同长度文案：ASCII 估宽 < CJK 估宽（left 有限且可观察）', async () => {
    wrapper = mount(TooltipHost, { attachTo: document.body })
    const ascii = await hoverTipLeft('ABCDEFGHIJ') // 10 半角 ≈ 10×7 + padding
    const cjk = await hoverTipLeft('十个汉字组成句子呀') // 10 全角 ≈ 10×13 + padding
    expect(Number.isFinite(ascii)).toBe(true) // 不抛错 + 尺寸有限
    expect(Number.isFinite(cjk)).toBe(true)
    expect(ascii).toBeGreaterThan(0)
    expect(ascii).toBeLessThan(cjk)
  })
})

// ── R42-31：Shelf 页 openBook IPC catch ────────────────────────────────

describe('R42-31 Shelf 页：openBook IPC reject 不抛穿', () => {
  const BOOK: BookEntry = {
    name: '我的书',
    title: '我的书',
    kind: 'long',
    chapters: 3,
    words: 12000,
    lastEdited: '2026-09-01T00:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
  }

  /** win=shelf 查询参数（书架独立窗口形态）：replaceState 优先；happy-dom 不生效时
   *  defineProperty 兜底（openBook 的 IPC 分支判据） */
  function forceShelfWinParam(): void {
    try {
      window.history.replaceState(null, '', '/shelf?win=shelf')
    } catch {
      /* 走下行兜底 */
    }
    if (window.location.search !== '?win=shelf') {
      Object.defineProperty(window.location, 'search', { value: '?win=shelf', configurable: true })
    }
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).clwritingDesktop
    try {
      window.localStorage.clear()
    } catch {
      /* happy-dom 差异下不可用则跳过 */
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('openBook reject → console.warn 留痕，无 unhandledrejection 抛穿', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    shelfMocks.listBooks.mockReset().mockResolvedValue({ books: [BOOK], workDir: true })
    shelfMocks.routerPush.mockReset()
    forceShelfWinParam()

    const openBook = vi.fn().mockRejectedValue(new Error('ipc down'))
    ;(window as unknown as Record<string, unknown>).clwritingDesktop = { openBook }
    const unhandled: unknown[] = []
    window.addEventListener('unhandledrejection', (e) => unhandled.push(e))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const wrapper = mount(Shelf, { global: { plugins: [pinia] } })
    await flushPromises() // onMounted shelf.load() → 书卡渲染
    const grid = wrapper.findComponent(ShelfGrid)
    expect(grid.exists()).toBe(true)

    grid.vm.$emit('open', BOOK.name) // ShelfGrid @open → Shelf.openBook → IPC 分支
    await flushPromises()
    await new Promise((r) => setTimeout(r, 0)) // 等一拍 macrotask（rejection 微任务链结算）

    expect(openBook).toHaveBeenCalledWith(BOOK.name)
    expect(shelfMocks.routerPush).not.toHaveBeenCalled() // 独立窗口走 IPC，不落路由分支
    expect(warnSpy).toHaveBeenCalledWith('openBook IPC 失败', expect.any(Error)) // catch 留痕
    expect(unhandled).toEqual([]) // 无 unhandledrejection 抛穿
    wrapper.unmount()
  })
})
