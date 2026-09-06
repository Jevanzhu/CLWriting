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
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  apiFetch: mocks.apiFetch,
  getToken: mocks.getToken,
  rebootstrap: mocks.rebootstrap,
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  apiJson: vi.fn(),
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
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock }
})
vi.mock('../../../src/studio/web-next/node_modules/vue-router', async () => {
  const { reactive } = await import('vue')
  routeHolder.route = routeHolder.route ?? reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock }
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
/** 泵微任务链：doConnect「换票（404 回退）→ new EventSource」与心跳 beat 走到位 */
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
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 }))) // 换票 404 → ?token= 回退
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
    // 首载链尾 resync（r29 既有口径）：即时连接 + resync 重连，存活 1 条指向书A
    expect(MockES.instances).toHaveLength(2)
    MockES.instances.at(-1)!.onopen?.()
    const wb = useWorkbenchStore()
    expect(wb.connected).toBe(true)
    // 进书首拍已在 mount 即发且失败：streak=1，未达阈值不触发
    expect(heartbeatFailStreak.value).toBe(1)

    await vi.advanceTimersByTimeAsync(20_000) // 第 2 拍失败 → streak=2 → 看门狗 resync
    await settle()
    expect(MockES.instances).toHaveLength(3) // 修复点：resync 断开重连
    expect(MockES.instances[1]!.closed).toBe(true) // 旧连接已断
    expect(live()).toHaveLength(1)
    expect(decodeURIComponent(live()[0]!.url)).toContain('书A')
    w.unmount()
  })

  it('去抖：resync 触发即复位计数；恢复（成功拍）后再连败 2 拍才可再触发', async () => {
    const w = mount(Book)
    await settle()
    MockES.instances.at(-1)!.onopen?.()

    await vi.advanceTimersByTimeAsync(20_000) // streak 1→2 → resync + 复位
    await settle()
    expect(MockES.instances).toHaveLength(3)
    expect(heartbeatFailStreak.value).toBe(0) // 去抖：触发即复位

    // resync 出的新连接恢复在线 + 心跳恢复成功拍 → streak 保持 0
    MockES.instances.at(-1)!.onopen?.()
    mocks.apiFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    await vi.advanceTimersByTimeAsync(20_000)
    await settle()
    expect(MockES.instances).toHaveLength(3) // 成功拍不触发
    expect(heartbeatFailStreak.value).toBe(0)

    // 再连续失败：第 1 拍不触发，第 2 拍才触发（不能连发/不能 1 拍就触发）
    mocks.apiFetch.mockRejectedValue(new TypeError('network down'))
    await vi.advanceTimersByTimeAsync(20_000)
    await settle()
    expect(MockES.instances).toHaveLength(3) // streak=1 未达阈值
    await vi.advanceTimersByTimeAsync(20_000)
    await settle()
    expect(MockES.instances).toHaveLength(4) // streak=2 → 再次 resync
    w.unmount()
  })

  it('SSE 非 connected（退避自愈通道已接管）→ 连败不触发 resync', async () => {
    const w = mount(Book)
    await settle()
    MockES.instances.at(-1)!.onopen?.()
    const wb = useWorkbenchStore()
    wb.setConnected(false) // SSE 已知断开：重连由 useSse 退避链负责，看门狗不插手

    await vi.advanceTimersByTimeAsync(20_000) // streak 1→2
    await settle()
    expect(MockES.instances).toHaveLength(2) // 未触发
    await vi.advanceTimersByTimeAsync(40_000) // streak 3、4 也不触发
    await settle()
    expect(MockES.instances).toHaveLength(2)
    w.unmount()
  })
})
