// @vitest-environment happy-dom
/**
 * R51-I-1（五十一轮）回归：onInterrupt 书名捕获 + await 后复检（R70-10 家族收口）。
 *
 * 原实现是「书名捕获+await 后复检」家族唯一漏网——裸用 props.bookName：A 书中断
 * POST 在途期间切到 B 书，失败 err/toast 落 B 书工作台且无清除路径。修复后同
 * onSpawn/onAutoWrite 口径：入口捕获书名、await 后 props.bookName !== book 即中止
 * （成功 toast 同样不落新书界面）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

// 网络层全 mock（组件只关心编排次序）
const streamMocks = vi.hoisted(() => ({
  getState: vi.fn(async () => ({ nextChapter: 3 })),
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  streamMocks.getState.mockResolvedValue({ nextChapter: 3 })
  traceMocks.getTraceStats.mockResolvedValue({ ruleHits: [] })
  vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
  vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
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
