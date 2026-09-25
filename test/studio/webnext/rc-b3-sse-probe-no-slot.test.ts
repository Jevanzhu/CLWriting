// @vitest-environment happy-dom
/**
 * RC 源码重审 B-3（Opus-5.5 轮）回归：SSE 忙碌探测不建流、不占名额（前端面）。
 *
 * 形态（修复前）：probeSseBusy 以 GET 探 /stream 取状态码——服务端 200 路径在响应头之前
 * 即登记 connHandle（占一个 per-book 名额）、推 sync 快照、ensureSession，客户端 abort 前
 * 名额一直被占。与 fail-closed 首档 0ms 重连（R42-1）并发时探测会抢走最后一个名额，
 * 正式 EventSource 吃 429 → 再等一档退避 4s。
 *
 * 修复：探测改 HEAD（服务端 books.stream.probe，同路径同闸：三凭据预检 + 名额判定），
 * 只判定不建流。本文件用「带名额账的假服务端」双向钉住：
 * ① HEAD 探测零占用：末位名额留给正式流，0ms 首拍重连的 EventSource 直接建成；
 * ② 探测的失败/超时/被拒语义零回退：429 仍出指引、失败静默、退避阶梯不变、
 *    重连不被探测阻塞（未串行化）。
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
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

/** 服务端每本书的 SSE 名额上限（与 MAX_SSE_PER_BOOK 同值；本文件只做前端侧记账模型）。 */
const MAX_SSE = 5

/** 假服务端名额账：HEAD 只判定；GET/EventSource 建流才占名额。 */
const slots = { live: 0, refused: 0 }

/**
 * EventSource 桩：构造即「建流」——按名额账判准入，满额则不占（真实世界即 429
 * → 浏览器 fail-closed，不再自连）。
 */
class SlotES {
  static instances: SlotES[] = []
  static readonly CLOSED = 2
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  url = ''
  readyState = 0
  closed = false
  /** 服务端准入结果（false = 满额被拒） */
  admitted: boolean
  constructor(url: string) {
    this.url = url
    if (slots.live < MAX_SSE) {
      slots.live += 1
      this.admitted = true
    } else {
      slots.refused += 1
      this.admitted = false
    }
    SlotES.instances.push(this)
  }
  close(): void {
    this.closed = true
    this.readyState = 2
  }
}

/** 探测请求记录（形态断言用） */
const probeCalls: Array<{ url: string; method: string; headers: Record<string, string> }> = []

type HeadMode = 'auto' | 'reject' | 'hang'

/**
 * fetch 桩：/api/stream-ticket 200 {ticket}（R0916-7-P3-19 起 404 桩即换票失败、不再
 * 回退 ?token= 开连）；/stream 按 method 分流——
 * HEAD = 探测（只判定，**不改名额账**，回退成 GET 探测即被抓）、GET = 真建流（占名额）。
 */
function stubFetch(mode: HeadMode = 'auto'): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.endsWith('/api/stream-ticket')) return new Response(JSON.stringify({ ticket: 'tk' }), { status: 200 })
    if (url.includes('/stream')) {
      probeCalls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> })
      if (method === 'HEAD') {
        if (mode === 'reject') throw new TypeError('network down')
        if (mode === 'hang') {
          // 半开连接：永不回包，abort 到达才 reject（超时通道可观察）
          return new Promise<Response>((_, rej) => {
            init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
          })
        }
        return new Response(null, { status: slots.live >= MAX_SSE ? 429 : 200 })
      }
      // 旧探测形（GET）走这里：真占名额——「探测挤掉正式流」若回退即被本分支记账抓到
      if (slots.live >= MAX_SSE) return new Response('busy', { status: 429 })
      slots.live += 1
      return new Response(null, { status: 200 })
    }
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getToken.mockReturnValue('T0')
  SlotES.instances = []
  probeCalls.length = 0
  slots.live = 0
  slots.refused = 0
  vi.stubGlobal('EventSource', SlotES)
  vi.useFakeTimers()
})

afterEach(async () => {
  // R42-1：fail-closed 首档 0ms 立即重连——卸桩前多轮排干「宏任务定时器 → doConnect
  // 异步链（换票 fetch → new EventSource）」级联，防 unstub 后触发 new EventSource 抛
  // unhandled rejection（同 r73-sse-429-guide 惯例）
  vi.runOnlyPendingTimers()
  await settle()
  vi.runOnlyPendingTimers()
  await settle()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 泵微任务链：换票 → 开连 / 探测 fetch → toast 全部落定 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** fail-closed（X-P1-3：非 2xx EventSource 规范即 CLOSED）并触发 onerror */
function failClose(inst: SlotES): void {
  inst.readyState = 2
  inst.onerror?.()
}

describe('RC 源码重审 B-3: 探测不建流（不占名额）', () => {
  it('探测走 HEAD：末位名额不被探测占用，fail-closed 首档 0ms 重连的正式流直接建成', async () => {
    stubFetch()
    slots.live = MAX_SSE - 1 // 另 4 个标签页在途：本标签页手里是最后一个名额
    useSse(ref('书A'))
    await settle()
    expect(SlotES.instances).toHaveLength(1)
    expect(SlotES.instances[0]!.admitted).toBe(true)
    expect(slots.live).toBe(MAX_SSE)

    // 服务端销毁本标签页连接（如清空对话 S2 / 读超时）→ 浏览器 fail-closed → 探测 + 0ms 重连并发
    slots.live -= 1
    failClose(SlotES.instances[0]!)
    await settle()
    expect(probeCalls).toHaveLength(1)
    expect(probeCalls[0]!.method).toBe('HEAD') // 修复点：探测不建流
    expect(probeCalls[0]!.url).toContain('/api/books/%E4%B9%A6A/stream')
    expect(probeCalls[0]!.url).not.toContain('token=') // R31-32 语义保持：token 走 header
    expect(probeCalls[0]!.headers['x-studio-token']).toBe('T0')
    // 关键断言：探测未占名额（回退成 GET 探测时此处为 MAX_SSE，下面正式流必被拒）
    expect(slots.live).toBe(MAX_SSE - 1)

    vi.advanceTimersByTime(0) // R42-1 首档 0ms 立即重连（重连语义不变）
    await settle()
    expect(SlotES.instances).toHaveLength(2)
    expect(SlotES.instances[1]!.admitted).toBe(true) // 正式流拿到末位名额，不被探测挤掉
    expect(slots.refused).toBe(0)
    expect(useUiStore().toasts).toHaveLength(0) // 探测 200：无 429 指引
  })

  it('探测被拒（429）→ 指引 toast 与既有退避阶梯零回退', async () => {
    stubFetch()
    slots.live = MAX_SSE // 6 个标签页：名额已满，本标签页首连即被拒
    useSse(ref('书A'))
    await settle()
    expect(SlotES.instances[0]!.admitted).toBe(false)

    failClose(SlotES.instances[0]!)
    await settle()
    const ui = useUiStore()
    const toast = ui.toasts.find((t) => t.msg.includes('标签页'))
    expect(toast).toBeDefined() // R73-67 指引不回退
    expect(toast!.kind).toBe('error')
    expect(probeCalls[0]!.method).toBe('HEAD')

    // 既有退避阶梯：首档 0ms（立即重连）→ 仍满额（第二次被拒）→ 第二档 4s
    vi.advanceTimersByTime(0)
    await settle()
    expect(SlotES.instances).toHaveLength(2)
    expect(SlotES.instances[1]!.admitted).toBe(false)
    failClose(SlotES.instances[1]!)
    await settle()
    expect(probeCalls).toHaveLength(2) // 探测仍逐轮退避触发（在途锁不吞）
    expect(ui.toasts.filter((t) => t.msg.includes('标签页'))).toHaveLength(1) // 同纪元只提示一次
    vi.advanceTimersByTime(3_999)
    await settle()
    expect(SlotES.instances).toHaveLength(2) // 第二档未到不连
    vi.advanceTimersByTime(1)
    await settle()
    expect(SlotES.instances).toHaveLength(3)
  })

  it('探测网络失败（fetch reject）→ 静默：无指引 toast、无 re-boot，0ms 首拍重连照常完成', async () => {
    stubFetch('reject')
    slots.live = MAX_SSE - 1
    useSse(ref('书A'))
    await settle()
    slots.live -= 1
    failClose(SlotES.instances[0]!)
    await settle()
    expect(probeCalls).toHaveLength(1)
    expect(useUiStore().toasts).toHaveLength(0) // 探测失败不提示（既有降级语义）
    expect(mocks.rebootstrap).not.toHaveBeenCalled() // 无状态码 → 不触发任何自愈分支
    vi.advanceTimersByTime(0)
    await settle()
    expect(SlotES.instances).toHaveLength(2) // 重连不被探测失败阻塞
  })

  it('探测挂死（8s 超时 abort）→ 静默且不阻塞重连（探测/重连未串行化）', async () => {
    stubFetch('hang')
    slots.live = MAX_SSE - 1
    useSse(ref('书A'))
    await settle()
    slots.live -= 1
    failClose(SlotES.instances[0]!)
    await settle()
    expect(probeCalls).toHaveLength(1)
    // 探测在途（挂死）：0ms 首拍重连不等待探测，照常建成
    vi.advanceTimersByTime(0)
    await settle()
    expect(SlotES.instances).toHaveLength(2)
    expect(SlotES.instances[1]!.admitted).toBe(true)
    vi.advanceTimersByTime(8_000) // 探测超时 abort → catch
    await settle()
    expect(useUiStore().toasts).toHaveLength(0) // 超时按「非 429」：既有语义不变
  })
})
