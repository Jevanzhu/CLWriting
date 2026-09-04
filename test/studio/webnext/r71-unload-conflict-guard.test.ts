// @vitest-environment happy-dom
/**
 * R71-6（七十一轮）→ R44-2（四十四轮）契约演进回归：关窗/刷新对未保存工作的兜底。
 *
 * R71-6 原契约：第二个 beforeunload 监听对「冲突未决 + dirty」preventDefault（浏览器
 * 原生确认留住一念），与 flush 同步 XHR 兜底监听共存。
 * R44-2 新契约（单监听统一编排）：Chromium ≥M80 页面卸载路径整体禁同步 XHR（双
 * Electron 实验实证零字节），监听合并为一个 flushOnUnload——preventDefault 挡下 →
 * 异步 flushDirty → 全部落净后带一次性 sessionStorage 标记重放刷新；未落净（冲突未决
 * /保存失败）toast 告知不自动重放（Electron 不渲染 Leave-site 确认框，静默挡下＝无
 * 反馈死刷新，R44-19）。关窗路径由主进程 executeJavaScript 钩子兜底（见
 * r44-close-flush-electron / main.test.ts R44-2），不在本文件范围。
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
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

/** 脏文档 entry（conflict 形态由用例覆盖） */
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
  mocks.saveContent.mockResolvedValue({ ok: true, revision: `sha256:${'b'.repeat(64)}`, superseded: false })
  sessionStorage.clear()
})

describe('R71-6→R44-2: Book.vue 关窗/刷新统一兜底（异步 flush + 落净重放）', () => {
  it('conflict + dirty → preventDefault 挡下；flush 跳过冲突项不盲写，toast 告知不重放', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'toast')
    const w = mount(Book)
    await flushPromises()
    doc.docs.set('d1', seedEntry()) // mount 后注入（setBook 已清过缓存）
    expect(doc.conflictedDirtyDocs()).toEqual(['d1'])
    const ev = fireBeforeUnload()
    expect(ev.defaultPrevented).toBe(true) // 冲突未决：放行即不可恢复丢失
    await flushPromises()
    expect(mocks.saveContent).not.toHaveBeenCalled() // 盲写只会再 409（flushDirty 跳过 conflict）
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('已阻止刷新'), 'warning')
    w.unmount()
  })

  it('仅 dirty（无冲突）→ preventDefault 挡下 + 异步 flush 落净 → 标记一次性 + 重放刷新', async () => {
    const doc = useDocStore()
    const reloadSpy = vi.spyOn(location, 'reload').mockImplementation(() => {})
    const w = mount(Book)
    await flushPromises()
    doc.docs.set('d2', seedEntry({ docId: 'd2', path: '写作/正文/d2.md', name: 'd2.md', conflict: false }))
    const ev = fireBeforeUnload()
    expect(ev.defaultPrevented).toBe(true) // R44-2 契约：先挡下再异步落盘（同步 XHR 已不可用）
    await flushPromises()
    expect(mocks.saveContent).toHaveBeenCalledTimes(1) // 异步保存链全通（主进程钩子同面）
    expect(sessionStorage.getItem('clw:reload-after-flush')).toBeTruthy() // 一次性标记
    expect(reloadSpy).toHaveBeenCalledTimes(1) // 落净后自动重放刷新
    w.unmount()
  })

  it('conflict 但非 dirty（已决断残留态）→ 不 preventDefault（无可丢失面，不拦刷新）', async () => {
    const doc = useDocStore()
    const w = mount(Book)
    await flushPromises()
    doc.docs.set('d3', seedEntry({ docId: 'd3', path: '写作/正文/d3.md', name: 'd3.md', dirty: false }))
    const ev = fireBeforeUnload()
    expect(ev.defaultPrevented).toBe(false)
    w.unmount()
  })

  it('全 clean → 不 preventDefault 不发请求（重放标记新鲜时放行刷新不循环）', async () => {
    const doc = useDocStore()
    const w = mount(Book)
    await flushPromises()
    const ev = fireBeforeUnload()
    expect(ev.defaultPrevented).toBe(false)
    // 重放标记（10s 内新鲜）：即便又有脏文档，当拍放行——flush 落定后的 location.reload()
    // 会再触发 beforeunload，无标记即死循环
    sessionStorage.setItem('clw:reload-after-flush', String(Date.now()))
    doc.docs.set('d5', seedEntry({ docId: 'd5', path: '写作/正文/d5.md', name: 'd5.md', conflict: false }))
    const ev2 = fireBeforeUnload()
    expect(ev2.defaultPrevented).toBe(false) // 标记一次性：consume 后即失效
    const ev3 = fireBeforeUnload()
    expect(ev3.defaultPrevented).toBe(true) // 下一拍恢复正常兜底
    await flushPromises()
    w.unmount()
  })

  it('卸载后监听移除（泄漏即误拦）', async () => {
    const doc = useDocStore()
    const w = mount(Book)
    await flushPromises()
    doc.docs.set('d1', seedEntry())
    w.unmount()
    doc.docs.set('d4', seedEntry({ docId: 'd4', path: '写作/正文/d4.md', name: 'd4.md' }))
    const ev = fireBeforeUnload()
    expect(ev.defaultPrevented).toBe(false) // 组件卸载 → 监听已移除
  })
})
