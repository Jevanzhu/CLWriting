// @vitest-environment happy-dom
/**
 * R51-H-5（五十一轮）回归：useSse 换票失败回退通道的 console.warn 去重。
 *
 * ticket 通道持续故障时退避重连每轮 doConnect 都重新换票——原实现每连接一条
 * console.warn（分钟级刷屏）。修复后同连接纪元只 warn 一次；onopen 成功 / 切书
 * connect 复位（恢复后再故障可再告，观测口不丢新事件）。
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
  // 换票端点持续故障（500）：每轮 doConnect 都回退 ?token= 旧通道
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/stream-ticket')) return new Response('boom', { status: 500 })
    return new Response('{}') // probeSseBusy 探测：非 429 静默
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 泵微任务链：让 doConnect 的「换票（失败）→ new EventSource」链走到位 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
}

/** 模拟 fail-closed（EventSource 非 2xx 断连）：onerror 触发退避链第一档 0ms 立即重连 */
async function failClosed(es: MockES): Promise<void> {
  es.readyState = MockES.CLOSED
  es.onerror?.()
  await new Promise((r) => setTimeout(r, 20)) // 首档 delay 0：泵到 reconnectTimer 回调
  await settle()
}

describe('R51-H-5: 换票失败回退告警去重', () => {
  // useSse 在组件外直调会带出一条 Vue onUnmounted 的 dev warning（同样走 console.warn），
  // 断言按文案过滤只计换票告警
  function ticketWarnCount(spy: ReturnType<typeof vi.spyOn>): number {
    return spy.mock.calls.filter((c) => String(c[0]).includes('换票失败')).length
  }

  it('同连接纪元退避重连多轮换票失败 → console.warn 只一条；onopen 成功复位后再故障可再告', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const book = ref('书A')
    useSse(book)
    await settle()

    // 第 1 轮：首次失败告警
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('token=')
    expect(ticketWarnCount(warnSpy)).toBe(1)

    // 第 2 轮（fail-closed 退避立即重连，仍失败）：不重复告警（修复点）
    await failClosed(MockES.instances[0]!)
    expect(MockES.instances).toHaveLength(2)
    expect(ticketWarnCount(warnSpy)).toBe(1)

    // 连接成功（onopen）→ 复位；再故障可再告（观测口不丢新事件；复位后首档仍 0ms 立即重连）
    MockES.instances[1]!.onopen?.()
    await failClosed(MockES.instances[1]!)
    expect(MockES.instances).toHaveLength(3)
    expect(ticketWarnCount(warnSpy)).toBe(2)
    const ticketWarn = warnSpy.mock.calls.find((c) => String(c[0]).includes('换票失败'))
    expect(String(ticketWarn![0])).toContain('?token=')
  })

  it('切书（新连接纪元）→ 告警可再提示；每次回退连接仍带 ?token=（R50-D2-2 回退行为不变）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const book = ref('书A')
    useSse(book)
    await settle()
    expect(ticketWarnCount(warnSpy)).toBe(1)

    book.value = '书B' // 切书 → connect() 新纪元
    await settle()
    expect(MockES.instances).toHaveLength(2)
    expect(ticketWarnCount(warnSpy)).toBe(2)
    expect(MockES.instances[1]!.url).toContain('/api/books/' + encodeURIComponent('书B') + '/stream?token=')
  })
})
