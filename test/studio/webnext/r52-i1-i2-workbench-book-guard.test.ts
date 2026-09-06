// @vitest-environment happy-dom
/**
 * R52-I-1/I-2（五十二轮）回归：WorkbenchView 切书守卫家族收口。
 *
 * I-1：onSpawn / onAutoWrite 的「成功 toast」补 await 后复检（R70-10/R51-I-1 家族
 * 最后两个漏网点）——spawn/autoWrite POST 在途切书 A→B 时，A 书的「已开始生成/
 * 已开始全自动写稿」toast（含 A 书章号的连写消息）不得落 B 书工作台。
 *
 * I-2：watch(bookName) 切书清残留扩展到 err/state——旧书错误横幅（本窗动作失败落点，
 * 无清除路径）与旧书状态卡不得带进新书；state 置空后 refreshState 立即拉新书
 * （在途慢响应由 stateGen 代守卫兜底，RB-FE-P2-4）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import WbStateCard from '../../../src/studio/web-next/src/components/workbench/WbStateCard.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

// 网络层全 mock（组件只关心编排次序）
const streamMocks = vi.hoisted(() => ({
  getState: vi.fn(),
  spawnRole: vi.fn(),
  interrupt: vi.fn(),
  saveDraft: vi.fn(),
  autoWrite: vi.fn(),
  getDraftPrompt: vi.fn(),
  generateOutline: vi.fn(),
  generateLeadUpdates: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/stream', () => streamMocks)
const traceMocks = vi.hoisted(() => ({ getTraceStats: vi.fn(async () => ({ ruleHits: [] })) }))
vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => traceMocks)
const booksMocks = vi.hoisted(() => ({ getConfig: vi.fn(async () => ({})) }))
vi.mock('../../../src/studio/web-next/src/api/books', () => booksMocks)
const docApiMocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => docApiMocks)

function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function mountAt(bookName: string) {
  const wb = useWorkbenchStore()
  wb.textOut = '正文若干字'
  const wrapper = mount(WorkbenchView, {
    props: { bookName },
    global: {
      stubs: { ChatPanel: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true },
    },
  })
  await flushPromises()
  return { wrapper, wb }
}

function btn(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(label))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  streamMocks.getState.mockResolvedValue({ nextChapter: 3 })
  streamMocks.getDraftPrompt.mockResolvedValue({ prompt: '细纲语境', files: [] })
  traceMocks.getTraceStats.mockResolvedValue({ ruleHits: [] })
  vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
  vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
})

describe('R52-I-1: onSpawn/onAutoWrite 成功 toast 的 await 后复检', () => {
  it('spawn 在途切书 A→B → 「已开始生成」toast 不落 B 书', async () => {
    const ui = useUiStore()
    const req = pending<{ ok: boolean }>()
    streamMocks.spawnRole.mockReturnValue(req.promise)
    const { wrapper } = await mountAt('书A')

    const gen = btn(wrapper, '生成')
    expect(gen, '非 busy 态应有「生成」按钮').toBeTruthy()
    await gen!.trigger('click')
    expect(streamMocks.spawnRole).toHaveBeenCalledWith('书A', expect.objectContaining({ role: 'writer' }))

    await wrapper.setProps({ bookName: '书B' })
    req.resolve({ ok: true })
    await flushPromises()

    expect(ui.toasts.some((t) => t.msg.includes('已开始生成'))).toBe(false)
  })

  it('autoWrite 在途切书 A→B → 连写消息（含 A 书章号）不落 B 书', async () => {
    const ui = useUiStore()
    streamMocks.getState.mockResolvedValue({ nextChapter: 7 })
    const req = pending<{ batchSize: number }>()
    streamMocks.autoWrite.mockReturnValue(req.promise)
    const { wrapper } = await mountAt('书A')
    await flushPromises()

    const auto = btn(wrapper, '全自动写章')
    expect(auto, '非 busy 态应有「全自动写章」按钮').toBeTruthy()
    await auto!.trigger('click')
    expect(booksMocks.getConfig).toHaveBeenCalledWith('书A')
    expect(streamMocks.autoWrite).toHaveBeenCalledWith('书A', 7, expect.any(Number))

    await wrapper.setProps({ bookName: '书B' })
    req.resolve({ batchSize: 3 })
    await flushPromises()

    expect(ui.toasts.some((t) => t.msg.includes('连写 3 章'))).toBe(false)
    expect(ui.toasts.some((t) => t.msg.includes('已开始全自动写稿'))).toBe(false)
  })

  it('对照：未切书 → 「已开始生成」toast 照常', async () => {
    const ui = useUiStore()
    streamMocks.spawnRole.mockResolvedValue({ ok: true })
    const { wrapper } = await mountAt('书A')
    await btn(wrapper, '生成')!.trigger('click')
    await flushPromises()
    expect(ui.toasts.some((t) => t.msg.includes('已开始生成'))).toBe(true)
  })
})

describe('R52-I-2: 切书清 err/state 残留', () => {
  it('A 书动作失败留下错误横幅 → 切书后横幅不带进 B 书', async () => {
    streamMocks.spawnRole.mockRejectedValue(new Error('A 书生成失败'))
    const { wrapper } = await mountAt('书A')
    await btn(wrapper, '生成')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.err-msg').exists()).toBe(true)
    expect(wrapper.find('.err-msg').text()).toContain('A 书生成失败')

    // 切书：旧书 err 必须被清（原实现残留 → 回归红）
    await wrapper.setProps({ bookName: '书B' })
    await flushPromises()
    expect(wrapper.find('.err-msg').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('A 书生成失败')
  })

  it('getState 慢响应窗口：切书瞬间 state 已置空（旧书状态卡不闪现），新书响应到达后回填', async () => {
    const bState = pending<{ nextChapter: number }>()
    streamMocks.getState.mockImplementation((name: string) =>
      name === '书A' ? Promise.resolve({ nextChapter: 3 }) : bState.promise,
    )
    const { wrapper } = await mountAt('书A')
    await flushPromises()
    expect(wrapper.findComponent(WbStateCard).props('state')).toEqual({ nextChapter: 3 })

    // 切书：state 立即置空（B 书状态未回），旧书的 nextChapter 3 不残留
    await wrapper.setProps({ bookName: '书B' })
    expect(wrapper.findComponent(WbStateCard).props('state')).toBeNull()

    bState.resolve({ nextChapter: 9 })
    await flushPromises()
    expect(wrapper.findComponent(WbStateCard).props('state')).toEqual({ nextChapter: 9 })
  })
})
