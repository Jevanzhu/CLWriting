// @vitest-environment happy-dom
/**
 * 关窗/退出兜底两组契约（F3→R44-2 契约演进后的两个面）：
 *
 * ① flushBeforeClose 钩子面（F3 → R44-2，四十四轮）：关窗/退出兜底从「beforeunload
 *    内同步 XHR + 同步 re-boot」改为「主进程 close/before-quit 拦截 + 渲染层
 *    flushBeforeClose 异步钩子」。原 F3（五十九轮）修复点——token null 时同步 re-boot
 *    再 PUT——其主体（同步 XHR）经双 Electron 实验证实在 Chromium ≥M80 的卸载路径零
 *    字节到达（四十四轮报告 §3.1），已随 flushSyncOnUnload 一并移除。本组保留 token
 *    通道语义的等价断言：token 缺失现由 apiJson 的 401→rebootstrap 自动重取（R42-15），
 *    flushBeforeClose 无需自带 re-boot；钉住「钩子面不再读 getToken（旧同步通道残留
 *    即红）」与调用约定。引擎级保证（不 stub XHR/fetch 的实机回归）见
 *    electron-close-flush-delivery.test.ts。
 *
 * ② 关窗/刷新对未保存工作的兜底（R71-6 → R44-2）：R71-6 原契约：第二个 beforeunload
 *    监听对「冲突未决 + dirty」preventDefault（浏览器原生确认留住一念），与 flush 同步
 *    XHR 兜底监听共存。R44-2 新契约（单监听统一编排）：Chromium ≥M80 页面卸载路径整体
 *    禁同步 XHR（双 Electron 实验实证零字节），监听合并为一个 flushOnUnload——
 *    preventDefault 挡下 → 异步 flushDirty → 全部落净后带一次性 sessionStorage 标记
 *    重放刷新；未落净（冲突未决/保存失败）toast 告知不自动重放（Electron 不渲染
 *    Leave-site 确认框，静默挡下＝无反馈死刷新，R44-19）。关窗路径由主进程
 *    executeJavaScript 钩子兜底（见 electron-close-flush-delivery / main.test.ts
 *    R44-2），不在本文件范围。
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
  // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
  getContentPayload: vi.fn(async (...a: Parameters<typeof mocks.getContent>) => ({
    content: await mocks.getContent(...a),
  })),
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
const tokenMock = vi.fn<() => string | null>(() => 'test-token')
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: () => tokenMock(),
  }
})

// 子视图全部 stub（只关 beforeunload/flush 编排，不渲染视图内容——照 flush-dirty-switch-guard 惯例）
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
// R55-F-2（五十五轮）：useSseSelfHeal 从本模块具名导入 heartbeatFailStreak（SSE 半开
// 看门狗消费面）——mock 需同形导出（真实 ref，保证 watch 源合法）；本文件不测心跳节拍，维持 useHeartbeat 桩。
vi.mock('../../../src/studio/web-next/src/composables/useHeartbeat', async () => {
  const { ref } = await import('vue')
  return { useHeartbeat: vi.fn(), heartbeatFailStreak: ref(0) }
})
// R29-10：useSseSelfHeal 持有 useSse 返回值并在切书链尾调 resync()——mock 返回带 resync 的句柄
vi.mock('../../../src/studio/web-next/src/composables/useSse', () => ({ useSse: vi.fn(() => ({ resync: vi.fn() })) }))
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({
  useChatTier: vi.fn(() => ({ refresh: vi.fn() })),
}))

const routeHolder = vi.hoisted(() => ({ route: null as { params: { name: string } } | null }))
const routerMock = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue')
  routeHolder.route = reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock, onBeforeRouteUpdate: vi.fn() }
})
vi.mock('../../../src/studio/web-next/node_modules/vue-router', async () => {
  const { reactive } = await import('vue')
  routeHolder.route = routeHolder.route ?? reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock, onBeforeRouteUpdate: vi.fn() }
})

import Book from '../../../src/studio/web-next/src/pages/Book.vue'
import { saveContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore, type DocEntry } from '../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

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

async function openDirty(docId = 'd1'): Promise<void> {
  const doc = useDocStore()
  doc.setBook('test-book')
  mocks.getContent.mockResolvedValueOnce('a')
  await doc.open({
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode)
  doc.patch(docId, '未保存内容')
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

describe('F3→R44-2: flushBeforeClose 钩子面（token 通道语义随契约演进）', () => {
  it('dirty 文档经异步保存链落盘一次，token null 不再自带 re-boot（apiJson 401→rebootstrap 负责）', async () => {
    tokenMock.mockReturnValue(null)
    await openDirty()
    vi.mocked(saveContent).mockRejectedValueOnce(new Error('401'))
    const res = await useDocStore().flushBeforeClose()
    // token null + save 失败 → failed 上抛（真实链路里 apiJson 会先 rebootstrap 再重试，
    // 此处 mock 的是 documents 层，token 语义已不在本钩子职责内——断言零 re-boot 残留）
    expect(res.failed).toEqual(['d1'])
    expect(saveContent).toHaveBeenCalledTimes(1)
  })

  it('dirty 文档保存成功 → 钩子返回零失败零冲突（主进程据此直关不弹确认）', async () => {
    await openDirty()
    vi.mocked(saveContent).mockResolvedValueOnce({ ok: true, revision: 'sha256:r44', superseded: false })
    const res = await useDocStore().flushBeforeClose()
    expect(res).toEqual({ failed: [], conflict: [] })
  })
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
