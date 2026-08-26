// @vitest-environment happy-dom
/**
 * R63-10（十一轮）：WorkbenchView onOutline/onLeadUpdates 的书名入口捕获 + await 后复检。
 *
 * 修复前两函数直取 props.bookName 且 await 后不复检——生成期间切书，成功/失败 toast
 * 落到切换后的书（兄弟函数 onSpawn/onAutoWrite/onSaveDraft 均已有 FE-9/L-F1 守卫，
 * 此处漏网）。写入本身按调用时书名正确落原书，仅提示误导——本测试锚 toast 不落错书。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

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

/** 起一个手动放行的 Promise（模拟在途生成请求） */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  streamMocks.getState.mockResolvedValue({ nextChapter: 3 })
  traceMocks.getTraceStats.mockResolvedValue({ ruleHits: [] })
  vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
  vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
})

function mountView() {
  return mount(WorkbenchView, {
    props: { bookName: '书A' },
    global: {
      stubs: { ChatPanel: true, WbStateCard: true, WbDraftCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true },
    },
  })
}

describe('R63-10: 生成细纲在途切书 → toast 不落到切换后的书', () => {
  it('generateOutline 在途切书 A→B → 成功 toast 不出现（请求按入口书名照发原书）', async () => {
    const ui = useUiStore()
    const req = pending<void>()
    streamMocks.generateOutline.mockReturnValue(req.promise)
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('button[title*="细纲"]').trigger('click')
    expect(streamMocks.generateOutline).toHaveBeenCalledWith('书A', 3)
    await wrapper.setProps({ bookName: '书B' })
    req.resolve(undefined)
    await flushPromises()

    // 修复前：「第 3 章细纲已生成」落在 B 书工作台（误导作者以为 B 书生成了细纲）
    expect(ui.toasts.some((t) => t.msg.includes('细纲已生成'))).toBe(false)
  })

  it('未切书 → 成功 toast 照常（守卫不误伤）', async () => {
    const ui = useUiStore()
    streamMocks.generateOutline.mockResolvedValue(undefined)
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('button[title*="细纲"]').trigger('click')
    await flushPromises()
    expect(ui.toasts.some((t) => t.msg.includes('细纲已生成'))).toBe(true)
  })
})

describe('R63-10: 生成账本推进在途切书 → toast 不落到切换后的书', () => {
  it('generateLeadUpdates 在途切书 A→B → 成功 toast 不出现', async () => {
    const ui = useUiStore()
    const req = pending<{ count: number }>()
    streamMocks.generateLeadUpdates.mockReturnValue(req.promise)
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('button[title*="账本推进"]').trigger('click')
    expect(streamMocks.generateLeadUpdates).toHaveBeenCalledWith('书A', 3)
    await wrapper.setProps({ bookName: '书B' })
    req.resolve({ count: 4 })
    await flushPromises()

    expect(ui.toasts.some((t) => t.msg.includes('账本推进'))).toBe(false)
  })

  it('未切书 → 成功 toast 照常带条数', async () => {
    const ui = useUiStore()
    streamMocks.generateLeadUpdates.mockResolvedValue({ count: 4 })
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('button[title*="账本推进"]').trigger('click')
    await flushPromises()
    expect(ui.toasts.some((t) => t.msg.includes('已生成 4 条账本推进'))).toBe(true)
  })
})
