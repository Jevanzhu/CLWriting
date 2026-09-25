// @vitest-environment happy-dom
/**
 * R29 二十九轮批 E（E-8）回归：HistoryPanel 双 watch（[activeDocId, bookName] + savedAt）
 * 合并为单 watch——一次文档切换只拉一次列表（修复前同一次切换两个 watch 各拉一次）。
 * savedAt 变化（保存落盘）仍照常刷新（元组第三位生效）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  listSnapshots: vi.fn(async () => []),
}))
vi.mock('../../../src/studio/web-next/src/api/snapshots', () => ({
  listSnapshots: mocks.listSnapshots,
  restoreSnapshot: vi.fn(async () => undefined),
}))

import HistoryPanel from '../../../src/studio/web-next/src/components/panels/HistoryPanel.vue'
import { useDocStore, type DocEntry } from '../../../src/studio/web-next/src/stores/doc'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

function makeEntry(docId: string, savedAt: number | null): DocEntry {
  return {
    docId,
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    role: 'chapter',
    mode: 'text',
    content: '',
    baselineRevision: 'sha256:x',
    dirty: false,
    saving: false,
    savedAt,
    error: null,
    conflict: false,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('E-8: HistoryPanel 合并单 watch——一次切换只拉一次列表', () => {
  it('切换文档（savedAt 随变）→ listSnapshots 只多拉 1 次；savedAt 变化仍刷新', async () => {
    const ws = useWorkspaceStore()
    const doc = useDocStore()
    doc.docs.set('d1', makeEntry('d1', 1_000))
    doc.docs.set('d2', makeEntry('d2', 2_000))
    ws.activeDocId = 'd1'

    const w = mount(HistoryPanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(mocks.listSnapshots).toHaveBeenCalledTimes(1) // initial immediate

    // 修复前：activeDocId 变化触发 watch1、savedAt（1s→2s）变化触发 watch2 → 2 次重复拉取
    ws.activeDocId = 'd2'
    await flushPromises()
    expect(mocks.listSnapshots).toHaveBeenCalledTimes(2) // 修复点：恰 1 次（累计 2）

    // 保存落盘（savedAt 变化）→ 仍照常刷新（元组第三位生效）
    doc.get('d2')!.savedAt = 3_000
    await flushPromises()
    expect(mocks.listSnapshots).toHaveBeenCalledTimes(3)
    w.unmount()
  })
})
