// @vitest-environment happy-dom
/**
 * Y-9（第五十七轮）回归——版本恢复在本地 dirty 时先存后恢复。
 *
 * 缺陷：restore 后 doc.refresh 走 dirty 分支（fm 取服务端、正文保留本地、基线重指
 * 快照），随后 autosave 用本地旧正文把刚恢复的版本静默覆盖，toast 却报「已恢复」；
 * 确认弹窗「当前内容会自动留一份底」的承诺对未保存编辑是假的（留底只留磁盘态）。
 * 修复：onRestore 前对 dirty 文档先 doc.save（本地编辑落盘并入「恢复前」留底）；
 * 保存失败（冲突等）则中止恢复并提示。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const SNAP = { id: 'snap-1', time: Date.now() - 60_000, origin: 'manual', words: 100, pinned: false }
vi.mock('../../../src/studio/web-next/src/api/snapshots', () => ({
  listSnapshots: vi.fn(async () => [SNAP]),
  restoreSnapshot: vi.fn(async () => undefined),
}))
// doc mock 单例：entry ref + save/refresh spy 全局共享（工厂每调返回新对象会让
// 断言侧取到的 spy 与组件内不是同一个——Y-31 同坑）
const docEntryRef = ref<{ path: string; content: string; dirty: boolean; baselineRevision: string; saving?: boolean } | undefined>(undefined)
const docSaveMock = vi.fn(async () => true)
const docRefreshMock = vi.fn(async () => {})
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({
    get: (id: string) => (id === 'doc_1' ? docEntryRef.value : undefined),
    save: docSaveMock, // Y-9 修复点观察口：save 先于 restoreSnapshot 被调用
    refresh: docRefreshMock,
  })),
  __setEntry: (e: typeof docEntryRef.value) => { docEntryRef.value = e },
}))
// activeDocId 用普通字符串（普通对象无 pinia reactive 解包，ref 在 script 侧不解包
// 会让 doc.get(ref) miss → onRestore 前置守卫早退）
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => ({ activeDocId: 'doc_1', openTab: vi.fn() })),
}))
const uiAskMock = vi.fn(async () => true)
const uiToastMock = vi.fn()
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ ask: uiAskMock, toast: uiToastMock })),
}))

import { restoreSnapshot } from '../../../src/studio/web-next/src/api/snapshots'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import HistoryPanel from '../../../src/studio/web-next/src/components/panels/HistoryPanel.vue'

const restoreMock = restoreSnapshot as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('Y-9: dirty 先存后恢复', () => {
  it('dirty 文档 → save 先于 restoreSnapshot 调用（本地编辑落盘入留底）', async () => {
    const docMod = await import('../../../src/studio/web-next/src/stores/doc')
    ;(docMod as unknown as { __setEntry: (e: unknown) => void }).__setEntry({
      path: '写作/正文/0001-开篇.md',
      content: '本地未保存编辑',
      dirty: true,
      baselineRevision: 'rev-0',
    })
    const wrapper = mount(HistoryPanel, { props: { bookName: '书A' } })
    await flushPromises()
    await wrapper.find('.restore-btn').trigger('click')
    await flushPromises()
    expect(docSaveMock).toHaveBeenCalledWith('doc_1', 'manual')
    expect(restoreMock).toHaveBeenCalledTimes(1)
    // 顺序：save 的调用序号必须小于 restoreSnapshot 的
    expect(docSaveMock.mock.invocationCallOrder[0]).toBeLessThan(restoreMock.mock.invocationCallOrder[0]!)
    wrapper.unmount()
  })

  it('非 dirty 文档 → 不触发额外 save（既有行为保持）', async () => {
    const docMod = await import('../../../src/studio/web-next/src/stores/doc')
    ;(docMod as unknown as { __setEntry: (e: unknown) => void }).__setEntry({
      path: '写作/正文/0001-开篇.md',
      content: '已保存内容',
      dirty: false,
      baselineRevision: 'rev-0',
    })
    const wrapper = mount(HistoryPanel, { props: { bookName: '书A' } })
    await flushPromises()
    await wrapper.find('.restore-btn').trigger('click')
    await flushPromises()
    expect(docSaveMock).not.toHaveBeenCalled()
    expect(restoreMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('dirty 且保存失败 → 中止恢复（不调 restoreSnapshot）并 toast 提示', async () => {
    const docMod = await import('../../../src/studio/web-next/src/stores/doc')
    ;(docMod as unknown as { __setEntry: (e: unknown) => void }).__setEntry({
      path: '写作/正文/0001-开篇.md',
      content: '本地编辑',
      dirty: true,
      baselineRevision: 'rev-0',
    })
    docSaveMock.mockResolvedValueOnce(false)
    const wrapper = mount(HistoryPanel, { props: { bookName: '书A' } })
    await flushPromises()
    await wrapper.find('.restore-btn').trigger('click')
    await flushPromises()
    expect(restoreMock).not.toHaveBeenCalled()
    expect(uiToastMock).toHaveBeenCalledWith(expect.stringContaining('未保存'), 'error')
    wrapper.unmount()
  })
})
