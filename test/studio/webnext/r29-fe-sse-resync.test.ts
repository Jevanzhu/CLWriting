// @vitest-environment happy-dom
/**
 * R29-10（二十九轮）回归：切书窗口新书 SSE sync 快照被 workbench.clear() 吞掉。
 *
 * sync 是连接级一次性快照：切书时 useSse 立即连新书，其 sync(running=true) 若在
 * Book.vue 切书 watch 的弹窗（Z-8）/flushDirty await 链期间到达，链首的 clear() 会把
 * running 复位，此后连接常驻不再有新 sync → 假空闲。修复：useSse 暴露 resync()
 * （disconnect + doConnect，服务端对新连接重发权威快照），Book.vue 在 await 链收尾
 * （gen 守卫通过、bookName 仍等于 n）时调用。
 *
 * 挂载脚手架沿 book-watch-reentry 先例（视图全 stub，只测切书编排）；SSE 用真实
 * useSse + MockES（沿 n3-sse-reboot 的 mock 方式）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'

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
  rebootstrap: vi.fn(async () => {}),
}))

// 子视图全部 stub（只测切书 watch 与 SSE 编排）
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
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({
  useChatTier: vi.fn(() => ({ refresh: vi.fn() })),
}))

// 可变路由 mock（沿 book-watch-reentry：必须经 reactive 代理改值才触发 watch）
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
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

/** SSE 桩（沿 n3-sse-reboot 的 MockES） */
class MockES {
  static instances: MockES[] = []
  static readonly CLOSED = 2
  static readonly CONNECTING = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  url = ''
  readyState = 0
  closed = false
  constructor(url: string) {
    this.url = url
    MockES.instances.push(this)
  }
  close(): void {
    this.closed = true
    this.readyState = 2
  }
  /** 测试内推送一条 SSE 消息（useSse onmessage → JSON.parse → store 分流）。 */
  emit(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent)
  }
}

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

/** 存活（未 close）的连接 */
function live(): MockES[] {
  return MockES.instances.filter((e) => !e.closed)
}
/** 泵微任务链：doConnect 的「换票（404 回退）→ new EventSource」走到位 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  routeHolder.route!.params.name = '书A'
  mocks.getContent.mockResolvedValue('内容')
  mocks.saveContent.mockResolvedValue({ ok: true, revision: 'sha256:x' })
  mocks.fetchChatHistory.mockResolvedValue({ messages: [] })
  MockES.instances = []
  vi.stubGlobal('EventSource', MockES)
  // 契约②换票统一 404 → 回退 ?token= 旧通道
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('R29-10: 切书链尾 resync 强制重取 sync 快照', () => {
  it('正常切书 A→B → 链尾 resync 断开重连同一本书（末两个连接都是新书）', async () => {
    const w = mount(Book)
    await flushPromises()
    await settle()
    // 首载链尾也会 resync 一次（重连后服务端重发快照）——存活连接恰一条，指向书A
    expect(live().length).toBe(1)
    expect(live()[0]!.url).toContain(encodeURIComponent('书A'))

    routeHolder.route!.params.name = '书B'
    await flushPromises()
    await settle()
    // 修复点：切书完成后末两个连接都是书B（useSse watch 的即时连接 + 链尾 resync 重连）
    const urls = MockES.instances.map((e) => decodeURIComponent(e.url))
    expect(urls.at(-1)).toContain('书B')
    expect(urls.at(-2)).toContain('书B')
    expect(live().length).toBe(1)
    expect(live()[0]!.url).toContain(encodeURIComponent('书B'))
    w.unmount()
  })

  it('Z-8 弹窗窗口内新书 sync 到达被 clear 吞掉 → 链尾 resync 后新连接重发权威快照纠正假空闲', async () => {
    const w = mount(Book)
    await flushPromises()
    await settle()

    // 书A 造「冲突 + dirty」文档（Z-8 形态）→ 切书先弹确认
    mocks.getContent.mockResolvedValueOnce('盘上内容')
    const doc = useDocStore()
    const wb = useWorkbenchStore()
    const ui = useUiStore()
    await doc.open(makeNode('d1'))
    doc.patch('d1', '本地未落盘编辑')
    doc.get('d1')!.conflict = true

    let releaseAsk!: (v: boolean) => void
    const askSpy = vi.spyOn(ui, 'ask').mockImplementation(
      () => new Promise<boolean>((r) => { releaseAsk = r }),
    )
    routeHolder.route!.params.name = '书B'
    await nextTick()
    await settle()
    expect(askSpy).toHaveBeenCalledTimes(1)
    // 弹窗挂起期间：新书连接已建立，连接级 sync(running=true) 先到 → running 翻真
    const esDuringAsk = live()[0]!
    expect(decodeURIComponent(esDuringAsk.url)).toContain('书B')
    esDuringAsk.emit({ type: 'sync', running: true })
    expect(wb.running).toBe(true)

    // 作者选择「丢弃并切换」→ 链继续：workbench.clear() 把先到的 sync 复位（假空闲），
    // 链尾 resync 重连 → 新连接重发权威快照
    releaseAsk(true)
    await flushPromises()
    await settle()
    expect(wb.running).toBe(false) // clear 吞掉了弹窗窗口内的快照（修复前终点即此，假空闲）
    expect(askSpy).toHaveBeenCalledTimes(1)
    const esAfterResync = live()[0]!
    expect(esAfterResync).not.toBe(esDuringAsk) // resync 确实断开重连（新连接对象）
    expect(decodeURIComponent(esAfterResync.url)).toContain('书B')
    esAfterResync.emit({ type: 'sync', running: true })
    expect(wb.running).toBe(true) // 修复点：权威快照经 resync 重取到位（假空闲被纠正）
    w.unmount()
  })

  it('切书 await 链挂起期间书名又变（B→C）→ 旧链中止不 resync B，只有 C 链尾 resync', async () => {
    const w = mount(Book)
    await flushPromises()
    await settle()

    // 书A dirty（非冲突）文档 + 保存挂起 → 切书 B 的 flushDirty 在途
    mocks.getContent.mockResolvedValueOnce('盘上内容')
    const doc = useDocStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask')
    await doc.open(makeNode('d1'))
    doc.patch('d1', '未落盘编辑')
    let releaseSave!: (v: { ok: true; revision: `sha256:${string}` }) => void
    mocks.saveContent.mockImplementationOnce(
      () => new Promise((r) => { releaseSave = r }),
    )

    routeHolder.route!.params.name = '书B'
    await nextTick()
    await settle() // B 链挂在 flushDirty（save 在途）；书B 连接已建立
    expect(MockES.instances.filter((e) => decodeURIComponent(e.url).includes('书B')).length).toBe(1)

    // 书名又变 → 新链（C）接管：B 链 gen 作废
    routeHolder.route!.params.name = '书C'
    await nextTick()
    await flushPromises()
    await settle()
    // C 链无阻（d1 在 saving 被 flushDirty 跳过）→ 已走完：书C 即时连接 + 链尾 resync 两条
    expect(MockES.instances.filter((e) => decodeURIComponent(e.url).includes('书C')).length).toBe(2)
    expect(askSpy).not.toHaveBeenCalled() // C 链无失败弹窗（saving 项被 flushDirty 跳过）

    // 释放挂起的保存：B 链醒来 → gen 查代不过中止（不得对 B resync，也不得弹 F1）
    releaseSave({ ok: true, revision: 'sha256:abc' })
    await flushPromises()
    await settle()
    expect(askSpy).not.toHaveBeenCalled()
    expect(MockES.instances.filter((e) => decodeURIComponent(e.url).includes('书B')).length).toBe(1) // B 无 resync 重连
    expect(MockES.instances.filter((e) => decodeURIComponent(e.url).includes('书C')).length).toBe(2)
    expect(doc.bookName).toBe('书C')
    w.unmount()
  })

  it('useSse 单元：currentName 为空（未连任何书）时 resync 安全 no-op', async () => {
    const { useSse } = await import('../../../src/studio/web-next/src/composables/useSse')
    const { ref } = await import('vue')
    const name = ref('')
    const sse = useSse(name)
    await nextTick()
    sse.resync() // 不得抛错、不得开连
    await settle()
    expect(MockES.instances).toHaveLength(0)
    // 连书后 resync 才开连（先即时连一条，resync 重连第二条）
    name.value = '书D'
    await nextTick()
    await settle()
    sse.resync()
    await settle()
    expect(decodeURIComponent(MockES.instances.at(-1)!.url)).toContain('书D')
    expect(live().length).toBe(1)
  })
})
