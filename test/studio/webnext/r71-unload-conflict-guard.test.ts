// @vitest-environment happy-dom
/**
 * R71-6（七十一轮）回归：关窗对「冲突未决 + dirty」文档静默放弃。
 *
 * 修复：Book.vue 增加第二个 beforeunload 监听——存在 conflictedDirtyDocs 时
 * preventDefault（浏览器原生确认留住作者一念），与既有 flush 兜底监听共存互不干扰。
 * doc store 的 conflictedDirtyDocs() getter 为 Z-8 既有（切书守卫同款查询）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  fetchChatHistory: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  fetchChatHistory: mocks.fetchChatHistory,
  fetchChatBranches: vi.fn(async () => ({ branches: [], activeBranchId: null })),
  regenerateChat: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => 'test-token'),
}))

// 子视图全部 stub（只关 beforeunload 编排，不渲染视图内容——照 f1-flush-failure-guard 惯例）
const stub = vi.hoisted(() => ({ template: '<div />' }))
vi.mock('../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/EditorView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/WorkbenchView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/OnboardView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/OverviewView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/RelationsView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/LearnView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/StyleView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/AuditView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/composables/useHeartbeat', () => ({ useHeartbeat: vi.fn() }))
// R29-10：Book.vue 现持有 useSse 返回值并在切书链尾调 resync()——mock 返回带 resync 的句柄
vi.mock('../../../src/studio/web-next/src/composables/useSse', () => ({ useSse: vi.fn(() => ({ resync: vi.fn() })) }))
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({ useChatTier: vi.fn(() => ({ refresh: vi.fn() })) }))

const routeHolder = vi.hoisted(() => ({ route: null as { params: { name: string } } | null }))
const routerMock = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue')
  routeHolder.route = reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock }
})
vi.mock('../../../src/studio/web-next/node_modules/vue-router', async () => {
  const { reactive } = await import('vue')
  routeHolder.route = routeHolder.route ?? reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock }
})

import Book from '../../../src/studio/web-next/src/pages/Book.vue'
import { useDocStore, type DocEntry } from '../../../src/studio/web-next/src/stores/doc'

/** 冲突未决脏文档 entry（Z-8 同形态：conflict && dirty） */
function seedEntry(over: Partial<DocEntry> = {}): DocEntry {
  return {
    docId: 'd1',
    path: '写作/正文/d1.md',
    name: 'd1.md',
    role: 'chapter',
    mode: 'text',
    content: '未落盘的编辑',
    baselineRevision: `sha256:${'a'.repeat(64)}`,
    dirty: true,
    saving: false,
    savedAt: null,
    error: null,
    conflict: true,
    ...over,
  }
}

/** 派发 beforeunload（cancelable 才可断言 defaultPrevented） */
function fireBeforeUnload(): Event {
  const ev = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(ev)
  return ev
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  routeHolder.route!.params.name = '书A'
  mocks.getContent.mockResolvedValue('内容')
  mocks.fetchChatHistory.mockResolvedValue({ messages: [] })
})

describe('R71-6: Book.vue 关窗守卫——冲突未决脏文档 preventDefault', () => {
  it('conflict + dirty → beforeunload 被 preventDefault（关窗前浏览器原生确认）', async () => {
    const doc = useDocStore()
    const w = mount(Book)
    await flushPromises()
    doc.docs.set('d1', seedEntry()) // mount 后注入（setBook 已清过缓存）
    expect(doc.conflictedDirtyDocs()).toEqual(['d1'])
    const ev = fireBeforeUnload()
    expect(ev.defaultPrevented).toBe(true) // 修复点：此前全程静默放弃
    w.unmount()
  })

  it('仅 dirty（无冲突）→ 不 preventDefault（flush 兜底照常处理，守卫不误伤）', async () => {
    const doc = useDocStore()
    const w = mount(Book)
    await flushPromises()
    doc.docs.set('d2', seedEntry({ docId: 'd2', path: '写作/正文/d2.md', name: 'd2.md', conflict: false }))
    const ev = fireBeforeUnload()
    expect(ev.defaultPrevented).toBe(false)
    w.unmount()
  })

  it('conflict 但非 dirty（已决断残留态）→ 不 preventDefault', async () => {
    const doc = useDocStore()
    const w = mount(Book)
    await flushPromises()
    doc.docs.set('d3', seedEntry({ docId: 'd3', path: '写作/正文/d3.md', name: 'd3.md', dirty: false }))
    const ev = fireBeforeUnload()
    expect(ev.defaultPrevented).toBe(false)
    w.unmount()
  })

  it('卸载后监听移除 + 既有 flush 兜底监听共存（两监听互不干扰）', async () => {
    const doc = useDocStore()
    const w = mount(Book)
    await flushPromises()
    doc.docs.set('d1', seedEntry())
    w.unmount()
    doc.docs.set('d4', seedEntry({ docId: 'd4', path: '写作/正文/d4.md', name: 'd4.md' }))
    const ev = fireBeforeUnload()
    expect(ev.defaultPrevented).toBe(false) // 组件卸载 → 守卫监听已移除（泄漏即误拦）
  })
})
