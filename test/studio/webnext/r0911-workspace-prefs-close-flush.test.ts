// @vitest-environment happy-dom
/**
 * R0911-C1-P3-3（2026-09-11 全量重评 GLM-5.3 修复批）页面级接线回归：Book.vue 的
 * 关窗钩子 __clwFlushBeforeClose 并入书级 prefs 冲刷——末次布局态（500ms 防抖窗内）
 * 此前随关窗静默丢失（R48-82 备案取舍，本批收口）。主进程 flushRendererBeforeClose
 * 经 executeJavaScript 调用本钩子（链路见 src/desktop/main.ts）；本测试真实 mount
 * Book.vue（视图全 stub，沿 book-watch-reentry 先例），在防抖计时器之外直接驱动钩子，
 * 断言 putBookPrefs 已写穿。store 级语义（不二写/不空写/失败口径）见 workspace.test。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  fetchChatHistory: vi.fn(),
  putBookPrefs: vi.fn(async () => {}),
  getBookPrefs: vi.fn(async () => ({})),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: mocks.fetchChatHistory,
  fetchChatBranches: vi.fn(async () => ({ branches: [], activeBranchId: null })),
  regenerateChat: vi.fn(),
}))
// 书级 prefs 走 api/prefs mock（getBookPrefs 空信封 → 走默认布局 + watch 挂上；put 观察口）
vi.mock('../../../src/studio/web-next/src/api/prefs', async () => {
  const actual = await vi.importActual<typeof import('../../../src/studio/web-next/src/api/prefs')>(
    '../../../src/studio/web-next/src/api/prefs',
  )
  return {
    ...actual,
    getBookPrefs: mocks.getBookPrefs,
    putBookPrefs: mocks.putBookPrefs,
  }
})
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => 'test-token'),
}))

// 子视图全 stub（沿 book-watch-reentry 先例：只测关窗钩子接线，不渲染任何视图内容）
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
vi.mock('../../../src/studio/web-next/src/composables/useHeartbeat', async () => {
  const { ref } = await import('vue')
  return { useHeartbeat: vi.fn(), heartbeatFailStreak: ref(0) }
})
vi.mock('../../../src/studio/web-next/src/composables/useSse', () => ({ useSse: vi.fn(() => ({ resync: vi.fn() })) }))
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({
  useChatTier: vi.fn(() => ({ refresh: vi.fn() })),
}))

// 可变路由 mock（params.name 即「当前书」）；双路径 mock 沿 book-watch-reentry 先例
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
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

type CloseFlushWindow = Window & {
  __clwFlushBeforeClose?: () => Promise<{ failed: string[]; conflict: string[] }>
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  routeHolder.route!.params.name = '书A'
  mocks.getContent.mockResolvedValue('内容')
  mocks.fetchChatHistory.mockResolvedValue({ messages: [] })
  mocks.getBookPrefs.mockResolvedValue({})
  mocks.putBookPrefs.mockClear()
})

describe('R0911-C1-P3-3: 关窗钩子冲刷书级 prefs（Book.vue __clwFlushBeforeClose）', () => {
  it('防抖窗内关窗 → 钩子直写穿（不等 500ms），末次布局态落盘', async () => {
    const w = mount(Book)
    await flushPromises() // 进书链：ws.setBook → loadBookPrefs（空信封）→ 持久化 watch 挂上
    const ws = useWorkspaceStore()
    ws.setLeftWidth(300) // 排定 500ms 防抖（关窗时机落在窗内）
    await flushPromises() // watch pre-flush 一拍（计时器排上，但不等 500ms）
    expect(mocks.putBookPrefs).not.toHaveBeenCalled() // 前提：此刻仍在防抖窗内

    // 模拟主进程 executeJavaScript 调关窗钩子（防抖计时器之外直接写穿）
    const hook = (window as CloseFlushWindow).__clwFlushBeforeClose
    expect(hook).toBeTypeOf('function')
    const r = await hook!()
    expect(r).toEqual({ failed: [], conflict: [] }) // 文档保存链照旧（返回形状不变）
    expect(mocks.putBookPrefs).toHaveBeenCalledTimes(1)
    expect(mocks.putBookPrefs).toHaveBeenCalledWith('书A', expect.objectContaining({ leftWidth: 300 }))
    w.unmount()
  })

  it('无待写项关窗 → 钩子不空写（防抖窗空时零 PUT）', async () => {
    const w = mount(Book)
    await flushPromises()
    const hook = (window as CloseFlushWindow).__clwFlushBeforeClose
    expect(hook).toBeTypeOf('function')
    await hook!()
    expect(mocks.putBookPrefs).not.toHaveBeenCalled()
    w.unmount()
  })

  it('卸载 → 钩子注销（离开 /book 后关窗由主进程拿不到钩子直接关，既有口径）', async () => {
    const w = mount(Book)
    await flushPromises()
    expect((window as CloseFlushWindow).__clwFlushBeforeClose).toBeTypeOf('function')
    w.unmount()
    expect((window as CloseFlushWindow).__clwFlushBeforeClose).toBeUndefined()
  })
})
