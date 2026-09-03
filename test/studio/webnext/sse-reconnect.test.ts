/**
 * @vitest-environment happy-dom
 *
 * X-6 · SSE 重连核心路径回归（composables/useSse.ts 退避策略）：
 * ticket 两段式与 N-3 re-bootstrap 通道已有 sse-ticket/n3-sse-reboot 各自覆盖，
 * 本文件锁死退避接管协议——①网络抖动（CONNECTING）前 5 次由浏览器自连不接管；
 * ②第 6 次起接管手动重连；③fail-closed（readyState=CLOSED，非 2xx）首次错误立即
 * 接管；④指数退避（R42-1 起首档 0ms 立即换票，第 2 档起 4s→8s→…→60s 封顶——清空对话服务端
 * 销毁在途连接后浏览器以已消费 ticket 自连必 403，首档 2s 曾让每次清空对话断流 3-5s）；
 * ⑤onopen 清零计数（重连成功后从 0ms 重新起阶）；
 * ⑥切书断旧连新且挂起的退避定时器被清（旧书不再重连）。
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
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

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
  // ticket 端点 404 → 回退 ?token= 旧通道（本文件聚焦退避，不关心 ticket 形态）
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

/** 当前活跃连接（最后一个创建的实例）置 fail-closed 并触发 onerror */
function failClose(inst: MockES): void {
  inst.readyState = 2
  inst.onerror?.()
}

/** 驱动一次「接管 → 退避到点 → 重连完成」；返回新连接 */
async function reconnectAfter(delayMs: number): Promise<MockES> {
  const before = MockES.instances.length
  vi.advanceTimersByTime(delayMs)
  await settle()
  expect(MockES.instances).toHaveLength(before + 1)
  return MockES.instances[MockES.instances.length - 1]!
}

describe('X-6 · SSE 退避接管协议', () => {
  it('网络抖动（CONNECTING）前 5 次不接管：同一连接保留，交给浏览器自连', async () => {
    useSse(ref('书A'))
    await settle()
    expect(MockES.instances).toHaveLength(1)
    const es0 = MockES.instances[0]!
    es0.readyState = 0 // CONNECTING：浏览器会自动重连
    for (let i = 0; i < 5; i++) es0.onerror?.()
    expect(MockES.instances).toHaveLength(1) // 未接管：无新连
    expect(es0.closed).toBe(false) // 原连接未被 close
    vi.advanceTimersByTime(60_000)
    await settle()
    expect(MockES.instances).toHaveLength(1) // 也未排手动重连定时器
  })

  it('第 6 次抖动错误 → 接管：close 原连 + 首档重连（R42-1 起 0ms）', async () => {
    useSse(ref('书A'))
    await settle()
    const es0 = MockES.instances[0]!
    es0.readyState = 0
    for (let i = 0; i < 5; i++) es0.onerror?.()
    es0.onerror?.() // 第 6 次：errorCount > FAST_RETRY_LIMIT(5)
    expect(es0.closed).toBe(true)
    const es1 = await reconnectAfter(0)
    expect(es1.url).toContain('/api/books/%E4%B9%A6A/stream')
  })

  it('fail-closed（CLOSED）首次错误立即接管 + R42-1 首档 0ms 换票重连（不经退避等待）', async () => {
    useSse(ref('书A'))
    await settle()
    const es0 = MockES.instances[0]!
    failClose(es0) // 首次错误即接管
    expect(es0.closed).toBe(true)
    // 修复前：首档 2s——「清空对话」销毁连接后事件流断流 3-5s；修复后 0ms 立即重连
    const before = MockES.instances.length
    vi.advanceTimersByTime(0)
    await settle()
    expect(MockES.instances.length).toBeGreaterThan(before)
  })

  it('R42-1 指数退避 0ms→4s 阶梯，6 次接管后封顶 60s（不再翻倍）', async () => {
    useSse(ref('书A'))
    await settle()
    let es = MockES.instances[0]!
    failClose(es)
    es = await reconnectAfter(0) // 第 1 阶：R42-1 起 0ms 立即换票（原 2s）
    failClose(es)
    // 第 2 阶：4s——差 1ms 不连，到点才连
    vi.advanceTimersByTime(3_999)
    await settle()
    expect(MockES.instances).toHaveLength(2)
    es = await reconnectAfter(1)
    failClose(es)
    es = await reconnectAfter(8_000) // 第 3 阶：8s
    failClose(es)
    es = await reconnectAfter(16_000) // 第 4 阶：16s
    failClose(es)
    es = await reconnectAfter(32_000) // 第 5 阶：32s
    failClose(es) // 第 6 次接管：min(2^5·2s=64s, 60s) → 60s 封顶
    vi.advanceTimersByTime(59_999)
    await settle()
    expect(MockES.instances).toHaveLength(6) // 封顶前不连
    await reconnectAfter(1)
  })

  it('onopen 清零计数：重连成功后再抖 5 次不接管，下次接管从 2s 重新起阶', async () => {
    useSse(ref('书A'))
    await settle()
    const wb = useWorkbenchStore()
    let es = MockES.instances[0]!
    failClose(es)
    es = await reconnectAfter(0) // R42-1：首档 0ms
    es.onopen?.() // 重连成功：errorCount/backoffStep 清零 + 置已连接
    expect(wb.connected).toBe(true)
    for (let i = 0; i < 5; i++) {
      es.readyState = 0
      es.onerror?.()
    }
    expect(MockES.instances).toHaveLength(2) // 抖动计数已清零：5 次内不接管
    expect(wb.connected).toBe(false) // 但连接状态如实置断
    failClose(es)
    es = await reconnectAfter(0) // backoffStep 已清零：R42-1 起从 0ms 重新起阶
    failClose(es)
    vi.advanceTimersByTime(3_999)
    await settle()
    expect(MockES.instances).toHaveLength(3) // 第 2 阶 4s 未到不连
    vi.advanceTimersByTime(1)
    await settle()
    expect(MockES.instances).toHaveLength(4)
  })

  it('切书：断旧连新（旧连 closed、新连指向新书）；挂起的旧书退避定时器被清', async () => {
    const bookRef = ref('书A')
    useSse(bookRef)
    await settle()
    const es0 = MockES.instances[0]!
    failClose(es0) // 2s 退避定时器挂起
    bookRef.value = '书B'
    await settle() // watch → connect(书B)：disconnect 清退避 + 断旧连，再连新书
    expect(es0.closed).toBe(true)
    expect(MockES.instances).toHaveLength(2)
    expect(MockES.instances[1]!.url).toContain(`/api/books/${encodeURIComponent('书B')}/stream`)
    vi.advanceTimersByTime(60_000) // 旧书退避已随 disconnect 清除：不再多连
    await settle()
    expect(MockES.instances).toHaveLength(2)
  })
})
