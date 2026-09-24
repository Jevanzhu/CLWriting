// @vitest-environment happy-dom
/**
 * 历史恢复读 dirty 前先冲刷正文回写窗（源码锚 src/studio/web-next/src/components/panels/HistoryPanel.vue
 * onRestore；标脏机制 src/studio/web-next/src/shared/body-writeback.ts）。
 *
 * 修复前：正文回写有 ≤200ms 尾随节流，窗口内的键入只在待写槽里、entry.dirty 仍 false。
 * 恢复流程直接读 dirty 决定「先存不存」——窗内点恢复读到 false，跳过先存；确认弹窗期间
 * 定时器到点把条目标脏，服务端把快照版本写上，随后 refresh 因 dirty 保留本地旧稿并推进
 * 基线，toast 报「已恢复」，编辑器里仍是旧稿。
 * 修复后：恢复决策前先 flushBodyWriteback，槽内正文落回条目、dirty 置位，走「先存后恢复」。
 *
 * 本文件用真 doc store + 真 body-writeback 槽构造窗口态（history-restore-dirty.test.ts 用
 * mock 条目的 dirty 布尔值，覆盖不到这个窗口）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const SNAP = { id: 'snap-1', time: Date.now() - 60_000, origin: 'manual', words: 100, pinned: false }
vi.mock('../../../src/studio/web-next/src/api/snapshots', () => ({
  listSnapshots: vi.fn(async () => [SNAP]),
  restoreSnapshot: vi.fn(async () => undefined),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContentPayload: vi.fn(async () => ({ content: '盘上旧稿', revision: 'sha256:base' })),
  saveContent: vi.fn(async () => ({ ok: true, revision: 'sha256:saved', superseded: false })),
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getToken: vi.fn(() => 'test-token') }
})

import { restoreSnapshot } from '../../../src/studio/web-next/src/api/snapshots'
import { saveContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import {
  registerBodyWriteback,
  scheduleBodyWriteback,
  flushBodyWriteback,
} from '../../../src/studio/web-next/src/shared/body-writeback'
import HistoryPanel from '../../../src/studio/web-next/src/components/panels/HistoryPanel.vue'

const restoreMock = restoreSnapshot as ReturnType<typeof vi.fn>
const saveMock = saveContent as ReturnType<typeof vi.fn>

const DOC = 'doc_1'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  registerBodyWriteback(null)
  vi.useRealTimers()
})

describe('历史恢复覆盖正文回写窗口', () => {
  it('窗内键入（dirty 尚未置位）点恢复 → 先把槽内正文落盘再恢复，不报假成功', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    // 直造条目：open 会拉网络，这里只需要一个干净条目作为恢复对象
    doc.docs.set(DOC, {
      docId: DOC,
      path: '写作/正文/0001-开篇.md',
      name: '0001-开篇.md',
      role: 'chapter',
      mode: 'text',
      content: '盘上旧稿',
      baselineRevision: 'sha256:base',
      dirty: false,
      saving: false,
      savedAt: null,
      error: null,
      conflict: false,
    })
    useWorkspaceStore().activeDocId = DOC
    // 回写执行体复刻 EditorView：落回即 patch（置脏 + 换内容）
    registerBodyWriteback((id, body) => doc.patch(id, body))

    const wrapper = mount(HistoryPanel, { props: { bookName: '书A' } })
    await flushPromises()

    // 窗口内键入：内容只在待写槽（脏位已由首笔标脏置上，但内容未落回——
    // 修复前恢复决策既读不到 dirty 也读不到这段正文）
    scheduleBodyWriteback(DOC, '窗内新键入的正文')
    expect(doc.get(DOC)!.content).not.toContain('窗内新键入的正文')

    useUiStore().ask = vi.fn(async () => true)
    await wrapper.find('.restore-btn').trigger('click')
    await flushPromises()

    // 决策前已冲刷：保存的是槽内最新正文，且先于恢复
    expect(saveMock).toHaveBeenCalledTimes(1)
    const savedBody = saveMock.mock.calls[0]?.[2] as { content: string }
    expect(savedBody.content).toContain('窗内新键入的正文')
    expect(restoreMock).toHaveBeenCalledTimes(1)
    expect(saveMock.mock.invocationCallOrder[0]).toBeLessThan(restoreMock.mock.invocationCallOrder[0]!)
    wrapper.unmount()
    flushBodyWriteback()
  })
})
