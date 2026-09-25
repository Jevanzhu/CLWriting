// @vitest-environment happy-dom
/**
 * R1010c-FE2-P3-2（2026-09-10 全量独立复审修复批）回归：SSE 层 401 自愈接线。
 *
 * useSse 的 fetchStreamTicket（换票）与 probeSseBusy（429 探测）原为裸 fetch，不走
 * api/client 的 401→rebootstrap 链——token 失效（dev 重启 dev:api 换 token 等）时 SSE
 * 层无直接自愈，只能靠同挂载点心跳（useHeartbeat→apiFetch→E-2）20s 拍间接换新 token，
 * 该耦合此前无测试钉住。修复后两处 401 触发 client 同款 re-boot 通道（promise 去重
 * 防风暴）。R0916-7-P3-19：换票失败不再回退 ?token= 开连（回退通道两端同删），本轮
 * 不开连并入既有退避重连。
 *
 * 另含 useSseSelfHeal 挂载接线的行为面：心跳与 SSE 同处单一挂载点、半开看门狗→resync
 * 接线（原对 Book.vue 源码文本锚定——P3-5 指其「测试决定代码位置」；看门狗与重启广播
 * 接线已抽入 composables/useSseSelfHeal.ts，同挂载点由结构保证，本处改挂载行为断言；
 * 看门狗全臂与重启广播面另见 heartbeat-watchdog-resync / server-restarted-resync）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => string | null>(() => 'T-stale'),
  rebootstrap: vi.fn<() => Promise<void>>(async () => {}),
  apiFetch: vi.fn<(...args: unknown[]) => unknown>(),
}))

vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  getToken: mocks.getToken,
  rebootstrap: mocks.rebootstrap,
  apiFetch: mocks.apiFetch,
}))

import { useSse } from '../../../src/studio/web-next/src/composables/useSse'
import { useSseSelfHeal } from '../../../src/studio/web-next/src/composables/useSseSelfHeal'
import { heartbeatFailStreak } from '../../../src/studio/web-next/src/composables/useHeartbeat'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

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

describe('R1010c-FE2-P3-2: useSseSelfHeal 挂载接线（行为面）', () => {
  /** 最小挂载面：useSseSelfHeal 单点挂载（心跳 + SSE 同源由 composable 结构保证） */
  function mountSelfHeal(): VueWrapper {
    return mount(
      defineComponent({
        setup() {
          return useSseSelfHeal(() => '书A')
        },
        template: '<div />',
      }),
    )
  }

  it('单一挂载点同时起心跳与 SSE——心跳 401 自愈通道与 SSE 连接不可分离（结构保证的行为面）', async () => {
    stubFetch(200, 200, '{"ticket":"TK"}')
    const w = mountSelfHeal()
    await nextTick()
    await settle()
    // SSE 侧：换票成功即开连
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('ticket=TK')
    // 心跳侧：挂载即首拍（401→re-boot 自愈的间接通道，与 SSE 同挂载点才可达）
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('heartbeat'),
      expect.objectContaining({ method: 'POST' }),
    )
    w.unmount()
  })

  it('半开看门狗接线在 composable 内生效：连败 2 拍且 SSE connected → resync 断旧连新 + 去抖复位', async () => {
    stubFetch(200, 200, '{"ticket":"TK"}')
    const w = mountSelfHeal()
    await nextTick()
    await settle()
    const es0 = MockES.instances[0]!
    es0.onopen?.() // SSE connected（看门狗插手的前提）
    heartbeatFailStreak.value = 2
    await nextTick()
    await settle()
    expect(es0.closed).toBe(true) // resync 断旧连
    expect(heartbeatFailStreak.value).toBe(0) // 触发即复位去抖
    w.unmount()
  })
})
