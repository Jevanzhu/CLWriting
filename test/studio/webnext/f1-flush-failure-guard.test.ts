// @vitest-environment happy-dom
/**
 * F1（五十九轮）回归：切书时「保存失败（非冲突）」的 dirty 文档不再被静默丢弃。
 *
 * 数据面：flushDirty 返回未落盘（失败仍 dirty）的 docId 列表。
 * 组件面：Book.vue 切书守卫拓宽——conflict（Z-8）之外，flush 失败同样走 ui.ask 决断：
    expect(routerMock.replace).toHaveBeenCalledWith('/book/' + encodeURIComponent('书A')) // 回退路由
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  fetchChatHistory: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: mocks.updateChapterMetaDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
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

// 子视图全部 stub（本测试只关心切书守卫编排，不渲染任何视图内容）
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

// 可变路由 mock：params.name 即「当前书」。reactive 代理经 hoisted 持有者暴露——
// 测试必须通过代理改值（直改原始对象不触发 Vue 依赖收集，Book.vue 的 watch 不感知）
const routeHolder = vi.hoisted(() => ({ route: null as { params: { name: string } } | null }))
const routerMock = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue')
  routeHolder.route = reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock }
})
vi.mock('../../../src/studio/web-next/node_modules/vue-router', async () => {
  const { reactive } = await import('vue')
  // 同一 reactive 代理（首个 mock 已建则复用，保证两路径读到同一路由对象）
  routeHolder.route = routeHolder.route ?? reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock }
})

import Book from '../../../src/studio/web-next/src/pages/Book.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

function makeNode(docId: string): TreeNode {
  return {
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  routeHolder.route!.params.name = '书A'
  mocks.getContent.mockResolvedValue('内容')
  mocks.fetchChatHistory.mockResolvedValue({ messages: [] })
})

// ── 数据面：flushDirty 返回未落盘列表 ────────────────────────

describe('F1: flushDirty 返回未落盘文档列表', () => {
  it('全部保存成功 → 空列表', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    mocks.getContent.mockResolvedValueOnce('a')
    await doc.open(makeNode('d1'))
    doc.patch('d1', '改')
    mocks.saveContent.mockResolvedValueOnce({ ok: true, revision: 'sha256:x', superseded: false })
    expect(await doc.flushDirty()).toEqual([])
    expect(doc.get('d1')!.dirty).toBe(false)
  })

  it('保存失败（仍 dirty）→ 列表含该 docId；成功后窗口内新键入不误报', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    mocks.getContent.mockResolvedValueOnce('a')
    await doc.open(makeNode('d1'))
    doc.patch('d1', '改')
    mocks.saveContent.mockRejectedValueOnce(new Error('网络断了'))
    const failed = await doc.flushDirty()
    expect(failed).toEqual(['d1']) // 修复点：失败未落盘可见（此前返回 void，切书即静默丢）
    expect(doc.get('d1')!.dirty).toBe(true)
  })
})

// ── 组件面：Book.vue 切书守卫拓宽 ────────────────────────

describe('F1: Book.vue 切书守卫——flush 失败统一走确认弹窗', () => {
  async function openDirty(doc: ReturnType<typeof useDocStore>): Promise<void> {
    mocks.getContent.mockResolvedValueOnce('内容')
    await doc.open(makeNode('d1'))
    doc.patch('d1', '未落盘的编辑')
  }

  it('flush 失败 + 确认丢弃 → 弹窗（文案区分冲突）后照常切书', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(true)
    const w = mount(Book)
    await flushPromises()
    await openDirty(doc)
    mocks.saveContent.mockRejectedValue(new Error('网络断了'))

    routeHolder.route!.params.name = '书B'
    await flushPromises()

    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(askSpy.mock.calls[0]![0].title).toContain('保存失败') // 文案区分（非冲突口径）
    expect(doc.bookName).toBe('书B') // 确认丢弃 → 照常切换
    w.unmount()
  })

  it('flush 失败 + 拒绝 → 回退路由留在原书（可重试保存），缓存不清', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(false)
    const w = mount(Book)
    await flushPromises()
    await openDirty(doc)
    mocks.saveContent.mockRejectedValue(new Error('网络断了'))

    routeHolder.route!.params.name = '书B'
    await flushPromises()

    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(routerMock.replace).toHaveBeenCalledWith('/book/' + encodeURIComponent('书A')) // 回退路由
    expect(doc.bookName).toBe('书A') // 留在原书
    expect(doc.get('d1')).toBeDefined() // dirty 文档未被 setBook 清缓存
    w.unmount()
  })

  it('flush 全部成功 → 不弹窗直接切书（守卫不误伤）', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(true)
    const w = mount(Book)
    await flushPromises()
    await openDirty(doc)
    mocks.saveContent.mockResolvedValue({ ok: true, revision: 'sha256:x', superseded: false })

    routeHolder.route!.params.name = '书B'
    await flushPromises()

    expect(askSpy).not.toHaveBeenCalled()
    expect(doc.bookName).toBe('书B')
    w.unmount()
  })
})
