// @vitest-environment happy-dom
/**
 * R1010c-FE2-P3-2（2026-09-10 全量独立复审修复批）回归：SSE 层 401 自愈接线。
 *
 * useSse 的 fetchStreamTicket（换票）与 probeSseBusy（429 探测）原为裸 fetch，不走
 * api/client 的 401→rebootstrap 链——token 失效（dev 重启 dev:api 换 token 等）时 SSE
 * 层无直接自愈，只能靠同挂载点心跳（Book.vue 的 useHeartbeat→apiFetch→E-2）20s 拍间
 * 接换新 token，该耦合此前无测试钉住。修复后两处 401 触发 client 同款 re-boot 通道
 * （promise 去重防风暴）。R0916-7-P3-19：换票失败不再回退 ?token= 开连（回退通道
 * 两端同删），本轮不开连并入既有退避重连。
 *
 * 另含 Book.vue 源码锚定：useHeartbeat 与 useSse 必须同处一个挂载点（同组件 setup、
 * 同 bookName 源）且心跳连败看门狗→sse.resync() 接线保留——防未来挂载点分离静默断链
 * （对齐 confirm-esc.test.ts 的源码锚定先例）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => string | null>(() => 'T-stale'),
  rebootstrap: vi.fn<() => Promise<void>>(async () => {}),
}))

vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  getToken: mocks.getToken,
  rebootstrap: mocks.rebootstrap,
}))

import { useSse } from '../../../src/studio/web-next/src/composables/useSse'

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

/** 按 URL/方法给响应：换票（POST /api/stream-ticket）与探测/流（/stream）可分别设状态码 */
function stubFetch(ticketStatus: number, streamStatus: number, ticketBody = ''): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url)
      if (u.includes('/api/stream-ticket')) {
        return new Response(ticketBody, { status: ticketStatus })
      }
      void init
      return new Response('', { status: streamStatus })
    }),
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getToken.mockReturnValue('T-stale')
  mocks.rebootstrap.mockImplementation(async () => {})
  MockES.instances = []
  vi.stubGlobal('EventSource', MockES)
  stubFetch(401, 401)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 泵微任务链：让 doConnect 的「换票 → 开连 / 探测 fetch」异步链走到位 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
}

describe('R1010c-FE2-P3-2: fetchStreamTicket 401 → 触发 re-boot 通道', () => {
  it('token 非空但失效（换票 401）→ 触发 rebootstrap；本轮不开连（无回退通道），并入退避重连', async () => {
    vi.useFakeTimers()
    stubFetch(401, 401)
    useSse(ref('书A'))
    await nextTick()
    await settle()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1) // 本轮恰一次（client promise 去重防风暴）
    expect(MockES.instances).toHaveLength(0) // R0916-7-P3-19：不再回退 ?token= 开连

    // 退避首档 0ms 重连：换票再 401 → strike 连记再自愈（截断面见 sse-reboot-401-cap）
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2)
    expect(MockES.instances).toHaveLength(0)
  })

  it('换票 403（非 401）→ 不触发 rebootstrap（只认 401）；本轮不开连并入退避', async () => {
    vi.useFakeTimers() // 换票失败轮自 perpetuate 退避链——fake timers 下随用例丢弃，不泄漏真实定时器
    stubFetch(403, 403)
    useSse(ref('书A'))
    await nextTick()
    await settle()
    expect(mocks.rebootstrap).not.toHaveBeenCalled()
    expect(MockES.instances).toHaveLength(0) // R0916-7-P3-19：无回退通道，不开连
  })

  it('换票 200（ticket 通道健康）→ 不触发 rebootstrap（守卫不误伤正常路径）', async () => {
    stubFetch(200, 200, '{"ticket":"TK"}')
    useSse(ref('书A'))
    await nextTick()
    await settle()
    expect(mocks.rebootstrap).not.toHaveBeenCalled()
    expect(MockES.instances[0]!.url).toContain('ticket=TK')
  })
})

describe('R1010c-FE2-P3-2: probeSseBusy 401 → 触发 re-boot 通道', () => {
  it('fail-closed 探测拿到 401 → 触发 rebootstrap（与换票侧同源自愈）', async () => {
    vi.useFakeTimers()
    stubFetch(200, 401, '{"ticket":"TK"}') // 换票健康，探测 401 = token 失效
    useSse(ref('书A'))
    await nextTick()
    await settle()
    expect(mocks.rebootstrap).not.toHaveBeenCalled() // 连接期未触发
    const es0 = MockES.instances[0]!
    es0.readyState = MockES.CLOSED // fail-closed（X-P1-3：非 2xx EventSource 规范即 CLOSED）
    es0.onerror?.()
    await settle()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1) // 探测 401 → re-boot
  })

  it('探测 403 不触发 rebootstrap（Origin/权限类 re-boot 无解，只认 401）', async () => {
    stubFetch(200, 403, '{"ticket":"TK"}') // 换票健康（探测面单独设 403；票体必带——空体即换票失败）
    useSse(ref('书A'))
    await nextTick()
    await settle()
    expect(mocks.rebootstrap).not.toHaveBeenCalled() // 连接期未触发
    const es0 = MockES.instances[0]!
    es0.readyState = MockES.CLOSED
    es0.onerror?.()
    await settle()
    expect(mocks.rebootstrap).not.toHaveBeenCalled() // 探测 403 同样不触发
  })
})

describe('R1010c-FE2-P3-2: useHeartbeat 与 useSse 同挂载点（Book.vue 源码锚定）', () => {
  it('两 composable 同处 Book.vue setup、同 bookName 源，心跳连败看门狗→resync 接线保留', () => {
    // 断链路径 = 挂载点分离（如 useSse 上移 App.vue）：心跳 20s 拍的 401→apiFetch→E-2
    // re-boot 只能间接救 SSE，分离后该自愈通道静默消失——故对源文本锚定同处挂载。
    const src = readFileSync(resolve(__dirname, '../../../src/studio/web-next/src/pages/Book.vue'), 'utf-8')
    expect(src).toContain('useHeartbeat(() => bookName.value)')
    expect(src).toContain('useSse(() => bookName.value)')
    // 看门狗耦合保留：心跳连败信号被消费，且驱动 SSE 强制重连重取 sync 快照
    expect(src).toContain('heartbeatFailStreak')
    expect(src).toContain('sse.resync()')
  })
})
