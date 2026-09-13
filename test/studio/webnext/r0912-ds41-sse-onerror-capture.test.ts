/**
 * @vitest-environment happy-dom
 *
 * R0912-ds41（重评-deepseek-v4.1-flash P3-12）回归：useSse onerror 改读闭包捕获的
 * 当前实例（sock）——原实现读外层可变绑定 es，若回调触发前外层绑定已被重连逻辑
 * 换成新实例，readyState 判定读到的是新连的状态（CONNECTING → fail-closed 误判
 * false，退避接管失真）。本文件模拟「旧实例（已 CLOSED）的 onerror 迟到触发、
 * 外层绑定已指向 CONNECTING 新连」的失真面：修复后判定取 sock（es0，CLOSED）→
 * 立即按 fail-closed 接管；修复前读外层 es1.readyState=0 → 永不接管（实例数停在
 * 2，钉死两实现的分界）。标准路径（首错即接管/退避阶梯/切书断连）由
 * sse-reconnect.test.ts 既有覆盖锁死，此处不重复。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => string | null>(() => 'T0'),
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getToken.mockReturnValue('T0')
  MockES.instances = []
  vi.stubGlobal('EventSource', MockES)
  // ticket 端点 404 → 回退 ?token= 旧通道（本文件不关心 ticket 形态）
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  )
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 泵微任务链：让 doConnect 的「换票 → new EventSource」链走到位 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('R0912-ds41：onerror 判定取闭包捕获实例', () => {
  it('外层绑定已换新连（CONNECTING）时，旧 CLOSED 实例的迟到 onerror 仍按 fail-closed 立即接管', async () => {
    useSse(ref('书A'))
    await settle()
    const es0 = MockES.instances[0]!
    es0.readyState = 2 // 非 2xx fail-closed
    es0.onerror?.() // 首错即接管：close es0 + R42-1 首档 0ms 重连
    expect(es0.closed).toBe(true)
    vi.advanceTimersByTime(0)
    await settle()
    expect(MockES.instances).toHaveLength(2)
    const es1 = MockES.instances[1]! // 新连在途（CONNECTING，onopen 未触发：errorCount=1、backoffStep=1）
    expect(es1.readyState).toBe(0)
    // 失真面注入：旧实例的 onerror 迟到触发（真实浏览器在断线瞬间事件可能已入队，
    // 触发时外层绑定已被重连逻辑换成新实例）——判定必须读捕获的 es0 而非外层 es1
    es0.onerror?.()
    expect(es1.closed).toBe(false) // close 目标是捕获实例（es0），不误杀在途新连
    // 修复后：fail-closed 接管（backoffStep 1→2）→ 第 2 档 4s 退避重连
    vi.advanceTimersByTime(3_999)
    await settle()
    expect(MockES.instances).toHaveLength(2) // 4s 未到不连
    vi.advanceTimersByTime(1)
    await settle()
    expect(MockES.instances).toHaveLength(3) // 到点重连＝迟到错误被判为 fail-closed
    // 修复前（读外层绑定）：failClosed=false 且 errorCount 2≤5 → 不接管、无退避定时器，
    // 任意推进后实例数停在 2——上面最后一步断言即两实现分界
  })
})
