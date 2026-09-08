// @vitest-environment happy-dom
/**
 * 重审-3（2026-09-07 全量代码重审 §四.3）回归：主进程「服务已自动重启/自愈成功」
 * 广播 → Book.vue 订阅 → sse.resync() 主动重连 + toast。
 *
 * 背景：崩溃自动重启（doRestart）/session-end 自愈（restartPinned）钉住端口拉回
 * 后，旧 SSE 连接已随 child 进程换代而死，EventSource 只能等自身退避重连——服务
 * 已恢复而 UI 无感。修复：preload 暴露 onServerRestarted 订阅（desktop:
 * server-restarted），Book.vue 挂载期订阅 → 回调里 resync() 断旧连新 + toast 提示，
 * 卸载期退订。
 *
 * 挂载脚手架沿 r55-f2（视图全 stub + MockES），桌面桥以 window.clwritingDesktop
 * 桩注入（浏览器版判空降级路径 = 不订阅，由 off 未挂载验证隐含覆盖）。
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

// 子视图全部 stub（只测订阅/重连编排）
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

// 可变路由 mock（沿 r55-f2：reactive 代理改值才触发 watch）
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
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

/** 桌面桥桩：捕获 onServerRestarted 订阅回调 + 退订函数（重审-3 判空订阅面） */
const desktop = vi.hoisted(() => ({
  restartedCbs: [] as Array<(port: number) => void>,
  offServerRestarted: vi.fn(),
  onServerRestarted: vi.fn((cb: (port: number) => void) => {
    desktop.restartedCbs.push(cb)
    return () => desktop.offServerRestarted()
  }),
}))

/** SSE 桩（沿 r55-f2 的 MockES） */
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

/** 泵微任务链：换票（404 回退）→ new EventSource 等走到位 */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  desktop.restartedCbs.length = 0
  routeHolder.route!.params.name = '书A'
  mocks.fetchChatHistory.mockResolvedValue({ messages: [] })
  mocks.apiFetch.mockResolvedValue(new Response('{}', { status: 200 })) // 心跳成功拍（不与看门狗交织）
  MockES.instances = []
  vi.stubGlobal('EventSource', MockES)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 }))) // 换票 404 → ?token= 回退
  ;(window as unknown as Record<string, unknown>)['clwritingDesktop'] = {
    onServerRestarted: desktop.onServerRestarted,
  }
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>)['clwritingDesktop']
  vi.useRealTimers()
})

describe('重审-3: Book.vue 订阅 desktop:server-restarted → resync + toast', () => {
  it('广播回调 → 断旧 SSE 连新（服务恢复即时可感）+ toast 提示', async () => {
    const w = mount(Book)
    await settle()
    expect(desktop.onServerRestarted).toHaveBeenCalledTimes(1) // 挂载期恰订阅一次
    // 首载链尾 resync（r29 既有口径）：即时连接 + resync 重连，存活 1 条
    expect(MockES.instances).toHaveLength(2)
    MockES.instances.at(-1)!.onopen?.()

    desktop.restartedCbs[0]!(45678) // 主进程广播：服务已在钉住端口拉回
    await settle()
    expect(MockES.instances).toHaveLength(3) // 修复点：立即 resync 断旧连新（不等退避）
    expect(MockES.instances[1]!.closed).toBe(true)
    const ui = useUiStore()
    expect(ui.toasts.some((t) => t.msg.includes('写作服务已自动恢复'))).toBe(true)
    w.unmount()
  })

  it('卸载 → 退订（Y-P2-7 监听器清理同口径）', async () => {
    const w = mount(Book)
    await settle()
    expect(desktop.offServerRestarted).not.toHaveBeenCalled()
    w.unmount()
    expect(desktop.offServerRestarted).toHaveBeenCalledTimes(1)
  })

  it('浏览器版（无 window.clwritingDesktop）→ 判空降级不订阅', async () => {
    delete (window as unknown as Record<string, unknown>)['clwritingDesktop']
    const w = mount(Book)
    await settle()
    expect(desktop.onServerRestarted).not.toHaveBeenCalled()
    w.unmount()
  })
})
