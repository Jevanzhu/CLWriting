// @vitest-environment happy-dom
/**
 * R59 清偿批（R55-F-8）回归：dev 双基址失配的最小诊断面。
 *
 * dev 下 boot/apiFetch 走 Vite proxy，SSE/ticket 走 DEV_API_BASE（VITE_DEV_API_BASE
 * 可覆盖）直连——两处指向不同实例（多实例/代理命中旧进程）时 SSE 侧 token 对不上，
 * 恒 401/403 fail-closed 退避且无任何诊断。修复：借 probeSseBusy 的 fetch 探测状态码，
 * dev 下连续 3 次 401/403 → console.warn 提示一次双基址可能失配；非 401/403 计数复位，
 * onopen / 切书复位计数与已告位（对齐 busy429Notified/ticketFallbackWarned「同纪元
 * 一次」惯例）。
 *
 * 桩结构对齐 r51-h5-sse-ticket-warn-dedupe（MockES + fetch stub + settle/failClosed 泵）。
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

/** 探测端点状态（按用例切换）：默认恒 401（失配形态）。 */
let probeStatus = 401

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.getToken.mockReturnValue('T0')
  MockES.instances = []
  probeStatus = 401
  vi.stubGlobal('EventSource', MockES)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/stream-ticket')) return new Response(JSON.stringify({ ticket: 'tk' }))
    if (url.includes('/stream')) return new Response('no', { status: probeStatus })
    return new Response('{}')
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 泵微任务链：让 doConnect 的「换票（成功）→ new EventSource」与探测链走到位 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
}

/**
 * 模拟 fail-closed（EventSource 非 2xx 断连）：onerror 触发退避重连 + 探测。
 * 退避链首档 0ms、其后 4s/8s/16s…（R42-1 档位）——连打多轮必进秒级档，r51-h5
 * 先例的「20ms 真实泵」只够首档；这里统一用 fake timers 推 61s 覆盖任意档
 * （探测 fetch 桩即返、8s abort timer 在 finally 清掉，被推无副作用）。
 */
async function failClosed(es: MockES): Promise<void> {
  es.readyState = MockES.CLOSED
  es.onerror?.()
  await vi.advanceTimersByTimeAsync(61_000)
  await settle()
}

/** 只计双基址失配告警（过滤 Vue onUnmounted 直调的 dev warning 等噪音） */
function mismatchWarnCount(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter((c) => String(c[0]).includes('双基址')).length
}

describe('R59 清偿批（R55-F-8）: dev 双基址失配诊断', () => {
  it('连续 3 次 401/403 fail-closed → warn 恰一次；持续 401 不再刷；onopen 复位后再连续可再告', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const book = ref('书A')
    useSse(book)
    await settle()
    expect(MockES.instances).toHaveLength(1)

    // 第 1、2 次连续 401：未达阈值，不告警
    await failClosed(MockES.instances[0]!)
    await failClosed(MockES.instances[1]!)
    expect(MockES.instances).toHaveLength(3)
    expect(mismatchWarnCount(warnSpy)).toBe(0)

    // 第 3 次连续 401：达阈值 → 恰告一次
    await failClosed(MockES.instances[2]!)
    expect(MockES.instances).toHaveLength(4)
    expect(mismatchWarnCount(warnSpy)).toBe(1)

    // 持续 401（第 4 次）：已告位，不再刷屏
    await failClosed(MockES.instances[3]!)
    expect(mismatchWarnCount(warnSpy)).toBe(1)
    const warnText = warnSpy.mock.calls.find((c) => String(c[0]).includes('双基址'))!
    expect(String(warnText[0])).toContain('VITE_DEV_API_BASE')

    // onopen 成功 → 复位；再连续 3 次 401 → 可再告（观测口不丢新事件）
    MockES.instances[4]!.onopen?.()
    await failClosed(MockES.instances[4]!)
    await failClosed(MockES.instances[5]!)
    await failClosed(MockES.instances[6]!)
    expect(mismatchWarnCount(warnSpy)).toBe(2)
  })

  it('非连续（401、401、200、401、401）→ 计数被非 401/403 复位，不告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const book = ref('书A')
    useSse(book)
    await settle()

    probeStatus = 401
    await failClosed(MockES.instances[0]!)
    await failClosed(MockES.instances[1]!)
    probeStatus = 200 // 探测通过（基址其实没失配）→ 计数复位
    await failClosed(MockES.instances[2]!)
    probeStatus = 401
    await failClosed(MockES.instances[3]!)
    await failClosed(MockES.instances[4]!)
    expect(MockES.instances).toHaveLength(6)
    expect(mismatchWarnCount(warnSpy)).toBe(0)
  })

  it('切书（新连接纪元）→ 已告位复位，新书再连续 3 次 401 可再告', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const book = ref('书A')
    useSse(book)
    await settle()
    await failClosed(MockES.instances[0]!)
    await failClosed(MockES.instances[1]!)
    await failClosed(MockES.instances[2]!)
    expect(mismatchWarnCount(warnSpy)).toBe(1)

    book.value = '书B' // 切书 → connect() 新纪元（disconnect + doConnect → 新实例 idx4）
    await settle()
    expect(MockES.instances).toHaveLength(5)
    await failClosed(MockES.instances[4]!)
    await failClosed(MockES.instances[5]!)
    await failClosed(MockES.instances[6]!)
    expect(mismatchWarnCount(warnSpy)).toBe(2)
    expect(MockES.instances[4]!.url).toContain('/api/books/' + encodeURIComponent('书B') + '/stream')
  })
})
