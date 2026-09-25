// @vitest-environment happy-dom
/**
 * WorkbenchView 中断动作两组守卫：在途锁（连点防重）与 await 后切书复检。
 *
 * R35-39（三十五轮批 E）：中断按钮在途锁——修复前 onInterrupt 无本地锁，在途窗口内
 * 双击/连点会重复 POST /interrupt；修复后对齐 R69-29 家族（生成/全自动/细纲同款收口）：
 * 函数级 interruptPending 锁 + 按钮 :disabled 双保险。
 *
 * R51-I-1（五十一轮）：onInterrupt 书名捕获 + await 后复检（R70-10 家族收口）——
 * 原实现是「书名捕获+await 后复检」家族唯一漏网：裸用 props.bookName，A 书中断 POST
 * 在途期间切到 B 书，失败 err/toast 落 B 书工作台且无清除路径。修复后同 onSpawn/
 * onAutoWrite 口径：入口捕获书名、await 后 props.bookName !== book 即中止（成功
 * toast 同样不落新书界面）。
 *
 * mock 面与 mount 手法照 workbench-view-actions.test.ts；ui/tree/provider 为真件
 * store（动作 spy，见 helpers/real-stores 纪律）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { recordToasts } from './helpers/real-stores'

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
vi.mock('../../../src/studio/web-next/src/api/workbench', () => streamMocks)
const traceMocks = vi.hoisted(() => ({ getTraceStats: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => traceMocks)
const costMocks = vi.hoisted(() => ({ getCostStats: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/cost-stats', () => costMocks)
const providerMocks = vi.hoisted(() => ({ getProviders: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/providers', () => providerMocks)
const booksMocks = vi.hoisted(() => ({ getConfig: vi.fn() }))
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

/** 挂载并置 wb.running（genBusy 分支才渲染「中断」按钮，:386 v-else） */
async function mountWithGenBusy(bookName: string) {
  const wb = useWorkbenchStore()
  wb.textOut = '正文若干字'
  wb.running = true
  const wrapper = mount(WorkbenchView, {
    props: { bookName },
    global: {
      stubs: { ChatPanel: true, WbStateCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true },
    },
  })
  await flushPromises()
  return { wrapper, wb }
}

function interruptBtn(w: ReturnType<typeof mount>) {
  const b = w.findAll('button').find((x) => x.text().includes('中断'))
  if (!b) throw new Error('中断按钮未渲染（wb.running 未生效？）')
  return b
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  streamMocks.getState.mockResolvedValue({
    identity: { kind: 'long', name: '书A', title: '', genre: '', created_at: '', wordsTarget: null },
    progress: { chapters: 1, words: 100, percent: 1, targetWords: null },
    nextChapter: 3,
    timeline: [],
    streak: 1,
  })
  traceMocks.getTraceStats.mockResolvedValue({ ruleHits: [], byTask: [] })
  costMocks.getCostStats.mockResolvedValue({ today: { calls: 0, cost: 0 }, recent: [] })
  providerMocks.getProviders.mockResolvedValue({ providers: [], tiers: null, currentModel: null })
  vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
  vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
})

describe('R35-39: WorkbenchView 中断在途锁', () => {
  it('在途窗口双击 → interrupt 只发一次；期间按钮 disabled；完成后解锁 + toast', async () => {
    const toastSpy = recordToasts(useUiStore())
    let resolveInterrupt!: () => void
    streamMocks.interrupt.mockImplementationOnce(() => new Promise<void>((r) => { resolveInterrupt = r }))
    const w = (await mountWithGenBusy('书A')).wrapper

    const click = interruptBtn(w).trigger('click')
    await nextTick()
    // 在途窗口：按钮禁用 + 函数锁生效——再点不重复发
    expect(interruptBtn(w).attributes('disabled')).toBeDefined()
    await interruptBtn(w).trigger('click')
    expect(streamMocks.interrupt).toHaveBeenCalledTimes(1)
    expect(streamMocks.interrupt).toHaveBeenCalledWith('书A')

    resolveInterrupt()
    await click
    await flushPromises()
    expect(toastSpy).toHaveBeenCalledWith('已中断', 'info')
    expect(interruptBtn(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('中断失败 → 锁释放（finally）、错误入 err 不致未处理拒绝', async () => {
    streamMocks.interrupt.mockRejectedValueOnce(new Error('stream down'))
    const w = (await mountWithGenBusy('书A')).wrapper
    await interruptBtn(w).trigger('click')
    await flushPromises()
    expect(streamMocks.interrupt).toHaveBeenCalledTimes(1)
    // 锁已释放：按钮可再点（可重试）
    expect(interruptBtn(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})

describe('R51-I-1: onInterrupt 在途切书守卫', () => {
  it('中断失败在途切书 A→B → 错误不落 B 书工作台', async () => {
    const ui = useUiStore()
    const req = pending<never>()
    streamMocks.interrupt.mockReturnValue(req.promise)
    const { wrapper } = await mountWithGenBusy('书A')

    const btn = wrapper.findAll('button').find((b) => b.text() === '中断')
    expect(btn, 'genBusy 态应有「中断」按钮').toBeTruthy()
    await btn!.trigger('click')
    expect(streamMocks.interrupt).toHaveBeenCalledWith('书A')

    await wrapper.setProps({ bookName: '书B' })
    req.reject(new Error('interrupt failed'))
    await flushPromises()

    expect(useUiStore().toasts.some((t) => t.msg.includes('interrupt failed'))).toBe(false)
    // B 书工作台无残留错误横幅（原实现 err 写入后无清除路径——回归红）
    expect(wrapper.text()).not.toContain('interrupt failed')
    void ui
  })

  it('中断成功但 await 后已切书 → 成功 toast 不落新书界面', async () => {
    const ui = useUiStore()
    let resolveInterrupt!: (v: { ok: boolean }) => void
    streamMocks.interrupt.mockReturnValue(new Promise<{ ok: boolean }>((res) => (resolveInterrupt = res)))
    const { wrapper } = await mountWithGenBusy('书A')

    const btn = wrapper.findAll('button').find((b) => b.text() === '中断')
    await btn!.trigger('click')
    await wrapper.setProps({ bookName: '书B' })
    resolveInterrupt({ ok: true })
    await flushPromises()

    expect(ui.toasts.some((t) => t.msg.includes('已中断'))).toBe(false)
  })

  it('对照：未切书 → 成功 toast「已中断」照常', async () => {
    const ui = useUiStore()
    streamMocks.interrupt.mockResolvedValue({ ok: true })
    const { wrapper } = await mountWithGenBusy('书A')
    const btn = wrapper.findAll('button').find((b) => b.text() === '中断')
    await btn!.trigger('click')
    await flushPromises()
    expect(ui.toasts.some((t) => t.msg.includes('已中断'))).toBe(true)
  })
})
