// @vitest-environment happy-dom
/**
 * 低-2（第十轮）：WorkbenchView.onSaveDraft 的 draftSaved 徽标写入次序。
 *
 * 旧实现把 draftSaved 赋值放在切书守卫之前——存草稿在途切书时，watch(bookName)
 * 已把残留徽标清空，晚到的赋值又把 A 书「已存 N 字」徽标留在 B 书工作台。
 * 修法：赋值移到「书名/代数复检」之后（L-F1 同点收尾）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import WbDraftCard from '../../../src/studio/web-next/src/components/workbench/WbDraftCard.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'

// 网络层全 mock（组件只关心编排次序，不关心真实 IO）
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
// R26-17（二十六轮）：doc store 的 refresh 重拉走 api/documents——mock 控制磁盘新内容
const docApiMocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => docApiMocks)

/** 起一个手动放行的 Promise（模拟在途存草稿请求） */
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
  // provider store onMounted 会拉档位——静默 stub 掉（不打网）
  vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
  vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
})

describe('低-2（第十轮）：存草稿在途切书 → B 书工作台不残留「已存 N 字」徽标', () => {
  it('saveDraft 在途切书 A→B → 徽标不写入、成功 toast 不落在 B 书', async () => {
    const wb = useWorkbenchStore()
    const ui = useUiStore()
    wb.textOut = '正文若干字'
    const req = pending<{ ok: boolean; path: string; words: number; docId: string; snapshotted: boolean }>()
    streamMocks.saveDraft.mockReturnValue(req.promise)

    const wrapper = mount(WorkbenchView, {
      props: { bookName: '书A' },
      global: {
        // 只留 WbDraftCard 真渲染（徽标/按钮在其中），其余子卡与本缺陷无关
        stubs: { ChatPanel: true, WbStateCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true },
      },
    })
    await flushPromises()

    const saveBtn = wrapper.findComponent(WbDraftCard).find('button')
    expect((saveBtn.element as HTMLButtonElement).disabled).toBe(false)
    await saveBtn.trigger('click')
    expect(streamMocks.saveDraft).toHaveBeenCalledWith('书A', 3, '正文若干字')

    // 存草稿在途切书：watch(bookName) 清 prompt/draftSaved 残留
    await wrapper.setProps({ bookName: '书B' })
    req.resolve({ ok: true, path: '写作/正文/0003-x.md', words: 5, docId: 'doc_9', snapshotted: false })
    await flushPromises()

    // 徽标与 toast 均不得落到 B 书工作台
    expect(wrapper.findComponent(WbDraftCard).find('.draft-actions .muted').exists()).toBe(false)
    expect(ui.toasts.some((t) => t.msg.includes('草稿已存'))).toBe(false)
  })

  it('未切书 → 守卫不误伤：徽标照常显示「N 字已存」', async () => {
    const wb = useWorkbenchStore()
    wb.textOut = '正文若干字'
    streamMocks.saveDraft.mockResolvedValue({ ok: true, path: '写作/正文/0003-x.md', words: 5, docId: 'doc_9', snapshotted: false })

    const wrapper = mount(WorkbenchView, {
      props: { bookName: '书A' },
      global: {
        stubs: { ChatPanel: true, WbStateCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true },
      },
    })
    await flushPromises()

    await wrapper.findComponent(WbDraftCard).find('button').trigger('click')
    await flushPromises()

    const badge = wrapper.findComponent(WbDraftCard).find('.draft-actions .muted')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('5 字已存')
  })
})

// R26-17（二十六轮）：AI 落盘后 doc 缓存新鲜度——正文已写进磁盘，openTab 命中旧缓存
// 则编辑器显示旧内容。修复：openTab 前 clean 缓存异步 refresh 对齐磁盘（dirty 不刷，
// CC-P2-15 本地优先；未缓存走 open 全新拉取）。
describe('R26-17（二十六轮）：存草稿后同 docId 缓存命中 → refresh 对齐磁盘', () => {
  const DOC_ID = 'doc_9'
  const DOC_PATH = '写作/正文/0003-x.md'

  function seedCache(dirty: boolean): void {
    const doc = useDocStore()
    doc.bookName = '书A'
    doc.docs.set(DOC_ID, {
      docId: DOC_ID,
      path: DOC_PATH,
      name: '0003-x.md',
      role: 'chapter',
      mode: 'text',
      content: '缓存旧内容',
      baselineRevision: 'sha256:x',
      dirty,
      saving: false,
      savedAt: null,
      error: null,
      conflict: false,
    })
  }

  async function mountAndSave(): Promise<ReturnType<typeof mount>> {
    streamMocks.saveDraft.mockResolvedValue({ ok: true, path: DOC_PATH, words: 5, docId: DOC_ID, snapshotted: false })
    const wrapper = mount(WorkbenchView, {
      props: { bookName: '书A' },
      global: {
        stubs: { ChatPanel: true, WbStateCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true },
      },
    })
    await flushPromises()
    await wrapper.findComponent(WbDraftCard).find('button').trigger('click')
    await flushPromises()
    return wrapper
  }

  it('缓存命中（clean）→ openTab 前 refresh 被调，编辑器内容对齐磁盘新内容', async () => {
    const doc = useDocStore()
    seedCache(false)
    docApiMocks.getContent.mockResolvedValue('磁盘新内容')
    const wb = useWorkbenchStore()
    wb.textOut = '正文若干字'

    const wrapper = await mountAndSave()

    expect(docApiMocks.getContent).toHaveBeenCalledWith('书A', DOC_PATH) // refresh 重拉
    expect(doc.get(DOC_ID)!.content).toBe('磁盘新内容') // 响应式落进缓存 entry
    expect(doc.get(DOC_ID)!.dirty).toBe(false)
    wrapper.unmount()
  })

  it('缓存命中但 dirty（本地有未保存编辑）→ 不刷（CC-P2-15 本地优先口径）', async () => {
    const doc = useDocStore()
    seedCache(true)
    const wb = useWorkbenchStore()
    wb.textOut = '正文若干字'

    const wrapper = await mountAndSave()

    expect(docApiMocks.getContent).not.toHaveBeenCalled() // dirty 不重拉
    expect(doc.get(DOC_ID)!.content).toBe('缓存旧内容') // 本地编辑原封
    wrapper.unmount()
  })
})
