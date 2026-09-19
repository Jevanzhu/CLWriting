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
 * 桩结构对齐 sse-ticket.test.ts / backlog-sse-dev-base-mismatch.test.ts
 * （MockES + fetch stub + fake timers 泵 failClosed）。
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

/** ticket 端点状态：401（恒拒，场景 A 形态）| 200（按 x-studio-token 分流，场景 B 形态）。 */
let ticketStatus = 401
/** 探测端点状态。 */
let probeStatus = 401

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.getToken.mockReturnValue('T0')
  mocks.rebootstrap.mockImplementation(async () => {})
  MockES.instances = []
  ticketStatus = 401
  probeStatus = 401
  vi.stubGlobal('EventSource', MockES)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/stream-ticket')) {
        if (ticketStatus === 200) {
          const token = new Headers(init?.headers).get('x-studio-token')
          if (token === 'T1') return new Response(JSON.stringify({ ticket: 'K-good' }), { status: 200 })
          return new Response('no', { status: 401 })
        }
        return new Response('no', { status: ticketStatus })
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

/** fail-closed 一轮：onerror → 0ms 首档重连 + 探测；fake timers 推过全部退避档 */
async function failClosed(es: MockES): Promise<void> {
  es.readyState = MockES.CLOSED
  es.onerror?.()
  await vi.advanceTimersByTimeAsync(61_000)
  await settle()
}

/** 只计双基址失配指引（R59 与 E003 共用同一指引面；过滤 ?token= 回退留痕等噪音） */
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
    // 首连：ticket 401 → 首见自愈（armed + rebootstrap#1）→ 回退 ?token= 开连
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('token=T0')
    expect(mismatchWarns(warnSpy)).toHaveLength(0)

    // 轮 1 fail-closed：探测 401（armed → strike 1 → rebootstrap#2）；退避重连的换票再 401
    //（strike 2 达阈值）→ 指引恰一次、自愈停止
    await failClosed(MockES.instances[0]!)
    expect(MockES.instances).toHaveLength(2)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2)
    expect(mismatchWarns(warnSpy)).toHaveLength(1)
    expect(mismatchWarns(warnSpy)[0]).toContain('VITE_DEV_API_BASE')

    // 后续轮次：不再触发 rebootstrap、不再重复告警，退避重连节奏保留（连接继续重建）
    await failClosed(MockES.instances[1]!)
    await failClosed(MockES.instances[2]!)
    expect(MockES.instances).toHaveLength(4)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2) // 截断生效：不再增长
    expect(mismatchWarns(warnSpy)).toHaveLength(1) // 已告位不刷屏
  })

  it('token 正常更新场景：首见 401 自愈一次换到有效 token → 重连成功，无指引', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // re-boot 换到新 token T1；ticket 端点对 T1 发票（token 真过期→轮换的正常自愈形态）
    mocks.rebootstrap.mockImplementation(async () => {
      mocks.getToken.mockReturnValue('T1')
    })
    ticketStatus = 200 // 哨兵：按 x-studio-token 分流（T1 → 200 发票）
    probeStatus = 200 // 换到新 token 后基址可达、token 工作

    useSse(ref('书A'))
    await settle()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1) // 只自愈一次
    expect(MockES.instances[0]!.url).toContain('token=T0') // 首连用旧 token 回退通道

    await failClosed(MockES.instances[0]!)
    // 探测（新 token）200 → 连记复位解除武装 → 重连换票成功，不再 401
    expect(MockES.instances).toHaveLength(2)
    expect(MockES.instances[1]!.url).toContain('ticket=K-good')
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1) // 不二次自愈
    expect(mismatchWarns(warnSpy)).toHaveLength(0) // 正常自愈不误告

    MockES.instances[1]!.onopen?.()
    await settle()
  })

  it('onopen 成功复位：截断后恢复连接，再遇 401 重新获得完整自愈（不被上一纪元截断态压制）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useSse(ref('书A'))
    await settle()
    await failClosed(MockES.instances[0]!)
    expect(mismatchWarns(warnSpy)).toHaveLength(1)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2)

    // 连接恢复（token 重新有效）→ 全套连记复位
    MockES.instances[1]!.onopen?.()
    await settle()

    // 新纪元再遇 401：探测首见自愈（rb#3）+ 换票 strike 1 自愈（rb#4，未达阈值不再截断）
    await failClosed(MockES.instances[1]!)
    expect(MockES.instances).toHaveLength(3)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(4)
    // strike 1 未达阈值：无第二次指引
    expect(mismatchWarns(warnSpy)).toHaveLength(1)
  })
})
