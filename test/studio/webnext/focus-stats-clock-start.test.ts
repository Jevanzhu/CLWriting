// @vitest-environment happy-dom
/**
 * FocusStatsBar 专注速度会话口径行为族（happy-dom）。
 * （原 r34d-e2-panels 的 R34D-28 节，按行为单拆；原第三例的 170ms 真实 sleep 已改
 * 假时钟推进防抖窗——确定性等待，不再依赖真实时长。）
 *
 * R34D-28（三十四轮批 E2）：切章误置 firstChangeAt（起算提前摊薄速度）+ 空章首笔锁进
 * baseline（首字 +0 且钟不起）；修复 = 会话重开盯 entry 身份 + reset 快照吞置位跳变 +
 * 空章基线按旧值 0 锁。
 * 契约随迁：R46-5（四十六轮）字数 150ms 防抖；R47-3（四十七轮）基线快照直读现算。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  createDoc: vi.fn(),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
  getGlobalPrefs: vi.fn(async () => ({})),
  putGlobalPrefs: vi.fn(async () => ({})),
}))
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})

import FocusStatsBar from '../../../src/studio/web-next/src/components/shell/FocusStatsBar.vue'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { DocEntry } from '../../../src/studio/web-next/src/stores/doc'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getConfig.mockResolvedValue({})
})
afterEach(() => {
  vi.useRealTimers()
})

/** 造一个已加载的文档 entry（FocusStatsBar 消费 doc store 缓存） */
function docEntry(docId: string, content: string): DocEntry {
  return {
    docId,
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    role: 'chapter',
    mode: 'text',
    content,
    baselineRevision: 'sha256:test',
    dirty: false,
    saving: false,
    savedAt: null,
    error: null,
    conflict: false,
  }
}

describe('R34D-28: FocusStatsBar 切章不起钟 + 空章首笔计入 delta', () => {
  it('切章后 60s 才动笔——速度按动笔时刻起算（修复前从切章时刻起算被摊薄）', async () => {
    vi.useFakeTimers()
    const ws = useWorkspaceStore()
    const doc = useDocStore()
    ws.bookName = '书A'
    doc.docs.set('d1', docEntry('d1', '一二三四五')) // 5 字
    doc.docs.set('d2', docEntry('d2', '一二三四五六七八')) // 8 字
    ws.activeDocId = 'd1'
    const w = mount(FocusStatsBar)
    await flushPromises()
    expect(w.text()).toContain('+0 字') // d1 基线 5

    // 切到已缓存的 d2（entry 立即换对象；旧实现此时误置 firstChangeAt）
    ws.activeDocId = 'd2'
    await nextTick()
    await nextTick()

    // 切章后 60s 才动笔 +10 字：修复后钟自动笔时刻起算（0 分钟 → 速度 —），
    // 修复前钟自切章时刻起算（10 字/1 分 = 10 字/分）
    vi.advanceTimersByTime(60_000)
    doc.patch('d2', '一二三四五六七八九十一二三四五六十七') // 8+10=18 字
    // R46-5（四十六轮）契约演进：字数 150ms 防抖——先 nextTick 让 watcher 排定
    // 防抖定时器，再假时钟推进 200ms 冲刷后断言（行为语义不变）
    await nextTick()
    vi.advanceTimersByTime(200)
    await nextTick()
    expect(w.text()).toContain('+10 字')
    expect(w.text()).not.toContain('字/分') // 修复点：切章不起钟
    w.unmount()
  })

  it('空章首笔计入 delta（修复前首字被锁进基线显示 +0）', async () => {
    const ws = useWorkspaceStore()
    const doc = useDocStore()
    ws.bookName = '书A'
    doc.docs.set('e1', docEntry('e1', '')) // 空章
    ws.activeDocId = 'e1'
    const w = mount(FocusStatsBar)
    await flushPromises()
    expect(w.text()).toContain('+0 字')

    doc.patch('e1', '好') // 首笔 1 字
    // R46-5（四十六轮）契约演进：字数 150ms 防抖（本用例真时钟）——断言改 waitFor
    await vi.waitFor(() => expect(w.text()).toContain('+1 字')) // 修复点：基线按旧值 0 锁，首字计入
    w.unmount()
  })

  it('守恒：文档迟到加载不算动笔（不误起钟、不误锁基线）', async () => {
    vi.useFakeTimers()
    const ws = useWorkspaceStore()
    const doc = useDocStore()
    ws.bookName = '书A'
    ws.activeDocId = 'd9' // 尚未加载（无 entry）
    const w = mount(FocusStatsBar)
    await flushPromises()
    expect(w.text()).toContain('+0 字')

    doc.docs.set('d9', docEntry('d9', '一二三')) // 加载到位：0→3 是置位非动笔
    await nextTick()
    await nextTick()
    // R47-3（四十七轮）：基线快照直读现算（置位当拍即锁 3），防抖 words 稳定窗口后
    // 跳到同值——按置位跳变跳过，delta 归 0、钟不起（假时钟推进 200ms 冲刷防抖窗）
    await vi.advanceTimersByTimeAsync(200)
    await nextTick()
    expect(w.text()).toContain('+0 字')
    expect(w.text()).not.toContain('字/分')
    w.unmount()
  })
})
