// @vitest-environment happy-dom
/**
 * R29 二十九轮批 E（E-9）回归：draftSaved 徽标随 wb.textOut 再生成清空而清零
 * （正文没了徽标不留）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  saveDraft: vi.fn(),
  getState: vi.fn(async () => ({ nextChapter: 3 })),
  getConfig: vi.fn(async () => ({})),
  getTraceStats: vi.fn(async () => ({ ruleHits: [] })),
  getTree: vi.fn(async () => ({ nodes: [], revision: 'r0' })),
}))
vi.mock('../../../src/studio/web-next/src/api/workbench', () => ({
  getState: mocks.getState,
  spawnRole: vi.fn(),
  interrupt: vi.fn(),
  saveDraft: mocks.saveDraft,
  autoWrite: vi.fn(),
  getDraftPrompt: vi.fn(),
  generateOutline: vi.fn(),
  generateLeadUpdates: vi.fn(),
  acknowledgeJournalPending: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => ({ getTraceStats: mocks.getTraceStats }))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: mocks.getTree,
}))

import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import WbDraftCard from '../../../src/studio/web-next/src/components/workbench/WbDraftCard.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
  vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
})

describe('E-9: textOut 清空 → draftSaved 徽标随清', () => {
  it('存草稿后再次生成（textOut 复位空）→ 「N 字已存」徽标消失', async () => {
    const wb = useWorkbenchStore()
    wb.textOut = '正文若干字'
    mocks.saveDraft.mockResolvedValue({
      ok: true,
      path: '写作/正文/0003-x.md',
      words: 5,
      docId: 'doc_9',
      snapshotted: false,
    })

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
