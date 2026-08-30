// @vitest-environment happy-dom
/**
 * R29 二十九轮批 E 前端回归（E-8 / E-9 / E-10，组件与 localStorage 面）。
 *
 * E-8：HistoryPanel 双 watch（[activeDocId, bookName] + savedAt）合并为单 watch——
 *      一次文档切换只拉一次列表（修复前同一次切换两个 watch 各拉一次）。
 * E-9：draftSaved 徽标随 wb.textOut 再生成清空而清零（正文没了徽标不留）。
 * E-10：机检误报灰显 localStorage 键删章清理——新增按文档清理接口并接入删章动作。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  listSnapshots: vi.fn(async () => []),
  restoreSnapshot: vi.fn(async () => undefined),
  saveDraft: vi.fn(),
  getState: vi.fn(async () => ({ nextChapter: 3 })),
  getTraceStats: vi.fn(async () => ({ ruleHits: [] })),
  getConfig: vi.fn(async () => ({})),
  getTree: vi.fn(async () => ({ nodes: [], revision: 'r0' })),
  getTreeIssues: vi.fn(async () => ({ issues: {}, warning: null })),
  deleteDoc: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../../src/studio/web-next/src/api/snapshots', () => ({
  listSnapshots: mocks.listSnapshots,
  restoreSnapshot: mocks.restoreSnapshot,
}))
vi.mock('../../../src/studio/web-next/src/api/stream', () => ({
  getState: mocks.getState,
  spawnRole: vi.fn(),
  interrupt: vi.fn(),
  saveDraft: mocks.saveDraft,
  autoWrite: vi.fn(),
  getDraftPrompt: vi.fn(),
  generateOutline: vi.fn(),
  generateLeadUpdates: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => ({ getTraceStats: mocks.getTraceStats }))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: mocks.getTree,
  getWordsDiary: vi.fn(async () => ({ date: '2026-08-30', baseline: 0, delta: null })),
  postBaseline: vi.fn(async () => ({})),
}))
vi.mock('../../../src/studio/web-next/src/api/tree-issues', () => ({
  getTreeIssues: mocks.getTreeIssues,
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(async () => ''),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  deleteDoc: mocks.deleteDoc,
  createDoc: vi.fn(),
  renameDoc: vi.fn(),
  moveDoc: vi.fn(),
  copyDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  batchFinalizeDocs: vi.fn(),
}))

import HistoryPanel from '../../../src/studio/web-next/src/components/panels/HistoryPanel.vue'
import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import WbDraftCard from '../../../src/studio/web-next/src/components/workbench/WbDraftCard.vue'
import { useDocStore, type DocEntry } from '../../../src/studio/web-next/src/stores/doc'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import { clearFalsePositiveMarksForDoc } from '../../../src/studio/web-next/src/stores/check'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

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

/** 本环境 localStorage shim 残缺（无 setItem/clear）——Map 桩统一替身（沿 chapter-tree-switch-guard 先例） */
const ls = new Map<string, string>()

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  ls.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
    setItem: (k: string, v: string) => void ls.set(k, String(v)),
    removeItem: (k: string) => void ls.delete(k),
    key: (i: number) => Array.from(ls.keys())[i] ?? null,
    get length(): number {
      return ls.size
    },
  })
  vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
  vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── E-8 ──────────────────────────────────────────────────────
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

// ── E-9 ──────────────────────────────────────────────────────
describe('E-9: textOut 清空 → draftSaved 徽标随清', () => {
  it('存草稿后再次生成（textOut 复位空）→ 「N 字已存」徽标消失', async () => {
    const wb = useWorkbenchStore()
    wb.textOut = '正文若干字'
    mocks.saveDraft.mockResolvedValue({ ok: true, path: '写作/正文/0003-x.md', words: 5, docId: 'doc_9', snapshotted: false })

    const w = mount(WorkbenchView, {
      props: { bookName: '书A' },
      global: { stubs: { ChatPanel: true, WbStateCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true } },
    })
    await flushPromises()

    await w.findComponent(WbDraftCard).find('button').trigger('click')
    await flushPromises()
    expect(w.findComponent(WbDraftCard).find('.draft-actions .muted').exists()).toBe(true) // 徽标先在

    // 再生成：role_spawn / text_reset 把正文流清空
    wb.textOut = ''
    await flushPromises()
    expect(w.findComponent(WbDraftCard).find('.draft-actions .muted').exists()).toBe(false) // 修复点：徽标随清
    w.unmount()
  })
})

// ── E-10 ─────────────────────────────────────────────────────
describe('E-10: 删章清理误报灰显键（只清匹配前缀）', () => {
  it('clearFalsePositiveMarksForDoc 只删该书该文档的键', () => {
    localStorage.setItem('clw-fp:书A:d1', '["ck1"]')
    localStorage.setItem('clw-fp:书A:d2', '["ck2"]')
    localStorage.setItem('clw-fp:书B:d1', '["ck3"]')
    clearFalsePositiveMarksForDoc('书A', 'd1')
    expect(localStorage.getItem('clw-fp:书A:d1')).toBeNull()
    expect(localStorage.getItem('clw-fp:书A:d2')).toBe('["ck2"]') // 他章不动
    expect(localStorage.getItem('clw-fp:书B:d1')).toBe('["ck3"]') // 他书不动
  })

  it('删章动作接线：doDelete 成功 → 该章灰显键被清', async () => {
    localStorage.setItem('clw-fp:书A:d1', '["ck1"]')
    const ui = useUiStore()
    vi.spyOn(ui, 'ask').mockResolvedValue(true)
    const actions = useChapterTreeActions({ bookName: () => '书A', openError: ref(null) })
    const node = {
      path: '写作/正文/d1.md',
      name: 'd1.md',
      isDirectory: false,
      role: 'chapter',
      docId: 'd1',
      children: [],
    } as TreeNode
    await actions.doDelete(node)
    await flushPromises()
    expect(mocks.deleteDoc).toHaveBeenCalledWith('书A', 'd1')
    expect(localStorage.getItem('clw-fp:书A:d1')).toBeNull() // 修复点：删章即清灰显键
  })
})
