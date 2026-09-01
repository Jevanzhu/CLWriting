// @vitest-environment happy-dom
/**
 * R35-31（三十五轮）回归：SSE 退避阶数随连接纪元复位（connect/disconnect 一并
 * backoffStep=0，对齐 busy429Notified 复位点）。修复前：上本书积累的退避（阶数 3+）
 * 带入新书——新书首次 fail-closed 重连最长等 60s。
 * 手法对齐 sse-reconnect.test.ts（X-6）。
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
  // ticket 端点 404 → 回退 ?token= 旧通道（本文件聚焦退避纪元，不关心 ticket 形态）
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
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

/** 当前活跃连接置 fail-closed 并触发 onerror */
function failClose(inst: MockES): void {
  inst.readyState = 2
  inst.onerror?.()
}

/** 驱动一次「接管 → 退避到点 → 重连完成」 */
async function reconnectAfter(delayMs: number): Promise<void> {
  const before = MockES.instances.length
  vi.advanceTimersByTime(delayMs)
  await settle()
  expect(MockES.instances).toHaveLength(before + 1)
}

describe('R35-31: 退避阶数随连接纪元复位', () => {
  it('A 书积累退避（3 阶）后切 B 书 → B 首次 fail-closed 2s 即重连（修复前 16s）', async () => {
    const name = ref('书A')
    useSse(name)
    await settle()
    expect(MockES.instances).toHaveLength(1)

    // A 书 fail-closed 三轮：2s → 4s → 8s（backoffStep 推到 3）
    for (const delay of [2_000, 4_000, 8_000]) {
      failClose(MockES.instances[MockES.instances.length - 1]!)
      await reconnectAfter(delay)
    }

    // 切书：立即断旧连新（disconnect 清退避定时器 + 复位阶数）
    name.value = '书B'
    await settle()
    const countAfterSwitch = MockES.instances.length
    expect(MockES.instances[countAfterSwitch - 1]!.url).toContain(encodeURIComponent('书B'))

    // 修复点：B 首次 fail-closed 的首试退避 = 2s（修复前阶数残留 3 → 2s×2³ = 16s）
    failClose(MockES.instances[countAfterSwitch - 1]!)
    vi.advanceTimersByTime(2_000)
    await settle()
    expect(MockES.instances).toHaveLength(countAfterSwitch + 1)
  })

  it('切书立即建连（不等上本书积累的退避定时器走完）', async () => {
    const name = ref('书A')
    useSse(name)
    await settle()
    // A 首次 fail-closed：接管后挂在 2s 退避定时器上
    failClose(MockES.instances[0]!)
    await settle()
    expect(MockES.instances).toHaveLength(1) // 重连尚未到点

    // 不推时钟直接切书：新书连接立即建立
    name.value = '书B'
    await settle()
    expect(MockES.instances).toHaveLength(2)
    expect(MockES.instances[1]!.url).toContain(encodeURIComponent('书B'))
  })
})
