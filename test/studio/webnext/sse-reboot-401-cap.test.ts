/**
 * @vitest-environment happy-dom
 *
 * 0918独立重评修复批（E003）回归：dev 401 自愈双基址不对称的空转截断。
 *
 * 背景：rebootstrap（boot）走相对路径经 Vite proxy，SSE/ticket 直连 DEV_API_BASE——
 * 两处指向不同实例（多实例/代理命中旧进程）时，boot 换来的新 token 对 SSE 实例依旧
 * 无效，401→reboot→重连仍 401 无限空转且无指引。修复：首见 401 照常自愈一次并武装
 * 连记；此后累计 REBOOT_401_GUIDE_STRIKES（2）次「re-boot 后仍 401」即 console.warn
 * 提前进既有 R59 双基址失配指引（共用 devMismatchWarned 已告位），且不再逐轮触发
 * rebootstrap；非 401/403 探测（token 工作）复位连记并解除武装；onopen/切书复位。
 * token 真过期场景（re-boot 换到有效 token）自愈一次成功，不进截断通道。
 *
 * 桩结构对齐 sse-ticket.test.ts / sse-dev-base-mismatch-warn.test.ts
 * （MockES + fetch stub + fake timers）。R0916-7-P3-19：换票 401 不再回退 ?token=
 * 开连——401 连记改由换票失败轮（退避节奏）驱动，探测面仅在 ES fail-closed 时参与。
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
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

/** 换票端点形态：'deny'（恒 401，场景 A 形态）| 'ok-t1'（仅 T1 发票，场景 B 形态）|
 *  'ok'（任意 token 发票，场景 C 恢复段形态）。R0916-7-P3-19：换票 401 不再回退
 *  ?token= 开连——失败轮直接进退避，故 401 连记全部经换票轮驱动（无 ES/探测参与）。 */
let ticketMode: 'deny' | 'ok-t1' | 'ok' = 'deny'
/** 探测端点状态（fail-closed 探测面；无 ES 的换票失败轮不触发探测）。 */
let probeStatus = 401
/** 换票端点被调次数（连接重建节奏的观测口：原实现数 ES 实例，现数换票轮） */
let ticketCalls = 0

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.getToken.mockReturnValue('T0')
  mocks.rebootstrap.mockImplementation(async () => {})
  MockES.instances = []
  ticketMode = 'deny'
  probeStatus = 401
  ticketCalls = 0
  vi.stubGlobal('EventSource', MockES)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/stream-ticket')) {
        ticketCalls++
        if (ticketMode === 'deny') return new Response('no', { status: 401 })
        const token = new Headers(init?.headers).get('x-studio-token')
        if (ticketMode === 'ok' || token === 'T1')
          return new Response(JSON.stringify({ ticket: 'K-good' }), { status: 200 })
        return new Response('no', { status: 401 })
      }
      if (url.includes('/stream')) return new Response('no', { status: probeStatus })
      return new Response('{}')
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 泵微任务链（doConnect 换票/开连、探测链） */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
}

/** 只计双基址失配指引（R59 与 E003 共用同一指引面） */
// vitest 5 批：ReturnType<typeof vi.spyOn> 在 v5 泛型收紧下退化为不可推断（filter 回调
// 隐式 any 红），改 MockInstance<被 spy 函数型> 显型
function mismatchWarns(spy: MockInstance<typeof console.warn>): string[] {
  return spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('双基址'))
}

describe('E003: re-boot 后仍 401 的空转截断', () => {
  it('rebootstrap 后仍 401 → 第二次即触发失配指引且不再逐轮自愈（退避重连保留）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useSse(ref('书A'))
    await settle()
    // 首连：ticket 401 → 首见自愈（armed + rebootstrap#1）→ 不回退开连，并入退避
    expect(MockES.instances).toHaveLength(0) // R0916-7-P3-19：换票失败不开连
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1)
    expect(mismatchWarns(warnSpy)).toHaveLength(0)

    // 轮 2（0ms 退避重试）：换票仍 401 → strike 1 → rebootstrap#2
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2)
    expect(mismatchWarns(warnSpy)).toHaveLength(0)

    // 轮 3（4s 退避）：strike 2 达阈值 → 指引恰一次、自愈截断
    await vi.advanceTimersByTimeAsync(4_000)
    expect(mismatchWarns(warnSpy)).toHaveLength(1)
    expect(mismatchWarns(warnSpy)[0]).toContain('VITE_DEV_API_BASE')
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2)

    // 轮 4+（8s/16s…）：不再自愈、不重复告警，退避重连节奏保留（换票持续重试）
    await vi.advanceTimersByTimeAsync(8_000)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2) // 截断生效：不再增长
    expect(mismatchWarns(warnSpy)).toHaveLength(1) // 已告位不刷屏
    expect(ticketCalls).toBeGreaterThanOrEqual(5) // 换票轮持续（原以 ES 实例数观测连接重建）
  })

  it('token 正常更新场景：首见 401 自愈一次换到有效 token → 重连成功，无指引', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // re-boot 换到新 token T1；换票端点对 T1 发票（token 真过期→轮换的正常自愈形态）
    mocks.rebootstrap.mockImplementation(async () => {
      mocks.getToken.mockReturnValue('T1')
    })
    ticketMode = 'ok-t1'
    probeStatus = 200 // 换到新 token 后基址可达、token 工作

    useSse(ref('书A'))
    await settle()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1) // 首见 401 自愈一次（T0 换票 401）
    expect(MockES.instances).toHaveLength(0) // 不回退开连（R0916-7-P3-19）

    await vi.advanceTimersByTimeAsync(0) // 退避首档 0ms：新 token T1 换票成功 → 开连
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('ticket=K-good')
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1) // 不二次自愈
    expect(mismatchWarns(warnSpy)).toHaveLength(0) // 正常自愈不误告

    MockES.instances[0]!.onopen?.()
    await settle()
  })

  it('onopen 成功复位：截断后恢复连接，再遇 401 重新获得完整自愈（不被上一纪元截断态压制）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useSse(ref('书A'))
    await settle()
    // 三轮换票 401 → 截断（指引一次、rb#2）
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(mismatchWarns(warnSpy)).toHaveLength(1)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2)

    // 换票端点恢复（对任意 token 发票）→ 下一档退避重连成功开连 → onopen 全套复位
    ticketMode = 'ok'
    await vi.advanceTimersByTimeAsync(8_000)
    await settle()
    expect(MockES.instances).toHaveLength(1)
    MockES.instances[0]!.onopen?.()
    await settle()

    // 新纪元再遇 401：探测首见自愈（rb#3）——截断态若残留，此处不再自愈
    ticketMode = 'deny' // 端点再故障：换票 401 面（恢复前的 'ok' 形态只服务重连成功一步）
    const es = MockES.instances[0]!
    es.readyState = MockES.CLOSED
    es.onerror?.()
    await settle()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(3)
    // 退避 0ms 重连：换票 401 → strike 1 自愈（rb#4，未达阈值不再告警）
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(4)
    expect(mismatchWarns(warnSpy)).toHaveLength(1)
  })
})
