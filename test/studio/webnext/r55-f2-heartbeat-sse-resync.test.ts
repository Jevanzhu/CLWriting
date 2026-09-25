// @vitest-environment happy-dom
/**
 * R55-F-2（五十五轮）回归：SSE 半开连接盲窗的心跳失活看门狗。
 *
 * 现状：服务端「接受连接、回 200 头、此后不发数据也不关」时 EventSource 无 onerror，
 * useSse 的 connected 冻结在 true 直至服务端 requestTimeout（~300s），期间 AI 进度事件
 * 全丢而 UI 无感。修复：useHeartbeat 暴露连续失败拍数（heartbeatFailStreak，成功拍复位），
 * Book.vue 在「连续 2 拍失败且 SSE 仍处 connected」时调 sse.resync() 断开重连重取 sync
 * 快照；触发即复位计数（去抖防连发）。
 *
 * 挂载脚手架沿 r29-fe-sse-resync（视图全 stub + MockES），useHeartbeat / useSse 均为
 * 真实实现：apiFetch 恒拒模拟传输层失活（半开窗内心跳必超时/网络失败的形态）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getToken: vi.fn(() => 'test-token'),
  rebootstrap: vi.fn(async () => {}),
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  fetchChatHistory: vi.fn(),
}))
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    apiFetch: mocks.apiFetch,
    getToken: mocks.getToken,
    rebootstrap: mocks.rebootstrap,
    apiJson: vi.fn(),
  }
})
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

// 子视图全部 stub（只测 SSE/心跳/看门狗编排）
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
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({
  useChatTier: vi.fn(() => ({ refresh: vi.fn() })),
}))

// 可变路由 mock（沿 r29：必须经 reactive 代理改值才触发 watch）
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
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { heartbeatFailStreak } from '../../../src/studio/web-next/src/composables/useHeartbeat'

/** SSE 桩（沿 r29/n3 的 MockES） */
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
}

/** 存活（未 close）的连接 */
function live(): MockES[] {
  return MockES.instances.filter((e) => !e.closed)
}
/** 泵微任务链：doConnect「换票 → new EventSource」与心跳 beat 走到位 */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  routeHolder.route!.params.name = '书A'
  mocks.fetchChatHistory.mockResolvedValue({ messages: [] })
  mocks.apiFetch.mockRejectedValue(new TypeError('network down')) // 心跳传输层失败（半开窗形态）
  heartbeatFailStreak.value = 0
  MockES.instances = []
  vi.stubGlobal('EventSource', MockES)
  // R0916-7-P3-19：换票桩 200 {ticket}（回退通道已删，404 桩即换票失败、不再回退开连）
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ticket: 'tk' }) })))
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('R55-F-2: SSE 半开连接盲窗的心跳看门狗', () => {
  it('心跳连续 2 拍失败且 SSE connected → resync 恰触发一次（断旧连新）', async () => {
    const w = mount(Book)
    await settle()
    // 首载链尾 resync（r29 既有口径）：存活连接恰一条指向书A。实例总数不锁——换票
    // 成功路径多一次 await（读 ticket 响应体），watch 的即时连接可能被链尾 resync
    // 抢先作废（R0916-7-P3-19 换票时序），语义面是「恰一条存活 + 后续 resync 断旧连新」。
    const conn0 = live()[0]!
    expect(decodeURIComponent(conn0.url)).toContain('书A')
    conn0.onopen?.()
    const wb = useWorkbenchStore()
    expect(wb.connected).toBe(true)
    // 进书首拍已在 mount 即发且失败：streak=1，未达阈值不触发
    expect(heartbeatFailStreak.value).toBe(1)

    await vi.advanceTimersByTimeAsync(20_000) // 第 2 拍失败 → streak=2 → 看门狗 resync
    await settle()
    expect(conn0.closed).toBe(true) // 修复点：resync 断开旧连
    expect(live()).toHaveLength(1) // 且恰一条新连接
    expect(decodeURIComponent(live()[0]!.url)).toContain('书A')
    w.unmount()
  })

  it('去抖：resync 触发即复位计数；恢复（成功拍）后再连败 2 拍才可再触发', async () => {
    const w = mount(Book)
    await settle()
    live()[0]!.onopen?.()

    await vi.advanceTimersByTimeAsync(20_000) // streak 1→2 → resync + 复位
    await settle()
    const afterFirst = MockES.instances.length // resync 后基线（实例总数随微任务竞态，取相对值）
    expect(afterFirst).toBeGreaterThan(1)
    expect(heartbeatFailStreak.value).toBe(0) // 去抖：触发即复位

    // resync 出的新连接恢复在线 + 心跳恢复成功拍 → streak 保持 0
    live()[0]!.onopen?.()
    mocks.apiFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    await vi.advanceTimersByTimeAsync(20_000)
    await settle()
    expect(MockES.instances).toHaveLength(afterFirst) // 成功拍不触发
    expect(heartbeatFailStreak.value).toBe(0)

    // 再连续失败：第 1 拍不触发，第 2 拍才触发（不能连发/不能 1 拍就触发）
    mocks.apiFetch.mockRejectedValue(new TypeError('network down'))
    await vi.advanceTimersByTimeAsync(20_000)
    await settle()
    expect(MockES.instances).toHaveLength(afterFirst) // streak=1 未达阈值
    await vi.advanceTimersByTimeAsync(20_000)
    await settle()
    expect(MockES.instances).toHaveLength(afterFirst + 1) // streak=2 → 再次 resync（恰一条新连接）
    w.unmount()
  })

  it('SSE 非 connected（退避自愈通道已接管）→ 连败不触发 resync', async () => {
    const w = mount(Book)
    await settle()
    live()[0]!.onopen?.()
    const base = MockES.instances.length
    const wb = useWorkbenchStore()
    wb.setConnected(false) // SSE 已知断开：重连由 useSse 退避链负责，看门狗不插手

    await vi.advanceTimersByTimeAsync(20_000) // streak 1→2
    await settle()
    expect(MockES.instances).toHaveLength(base) // 未触发
    await vi.advanceTimersByTimeAsync(40_000) // streak 3、4 也不触发
    await settle()
    expect(MockES.instances).toHaveLength(base)
    w.unmount()
  })
})
