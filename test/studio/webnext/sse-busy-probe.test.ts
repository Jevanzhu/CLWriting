// @vitest-environment happy-dom
/**
 * SSE 忙碌探测（per-book 连接上限 429 指引）行为族——按行为合并三散落文件
 * （原 r73-sse-429-guide / rc-b3-sse-probe-no-slot / r0910-w-sse-probe-switch，
 * 装置同构：EventSource/fetch 桩 + settle 泵 + fail-close）。
 *
 * - R73-67（二十一轮批 E，D 域移交前端面）：EventSource 不暴露状态码——429 与
 *   403/404 一样只表现为 fail-closed，作者只见「连接断开」毫无指引。修复后 fail-closed
 *   接管退避前发一次探测请求拿状态码：429 → 中文指引 toast「关闭多余标签页」；一次
 *   连接纪元只提示一次（onopen 成功/切书复位）；非 429 不提示。
 * - R26-78（二十六轮）：probeSseBusy 探测超时——探测 fetch 挂死时 probing429 恒 true，
 *   后续 fail-closed 的探测全被在途锁吞掉；超时 8s 按「非 429」收场，锁释放后恢复。
 * - RC-B-3（Opus-5.5 轮源码重审）：探测不建流、不占名额——GET 探测会在响应头之前占
 *   per-book 名额，与 fail-closed 首档 0ms 重连并发时挤掉正式流。修复后探测改 HEAD
 *   （只判定不建流），本文件用「带名额账的假服务端」双向钉住：HEAD 零占用 + 失败/
 *   超时/被拒语义零回退。
 * - R0910-W（2026-09-10 修复批）：在途探测不跨书切换——disconnect 中止在途探测
 *   （AbortSignal）+ 探测起始捕获 connectGen 代闸，切书后迟到的 429 不为旧书补发指引
 *   （双保险，即使 fetch 忽略 abort）。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
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

/**
 * fetch 桩（状态码族，R73-67/R26-78 用）：/api/stream-ticket 200 {ticket}（R0916-7-P3-19
 * 起 404 桩即换票失败、不再回退 ?token= 开连）；/stream 探测按指定状态回（R31-32 起
 * 探测走 header 通道，URL 不带凭据）。
 */
function stubProbeStatus(streamStatus: number): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/stream-ticket')) return new Response(JSON.stringify({ ticket: 'tk' }), { status: 200 })
    if (url.includes('/stream')) {
      probeCalls.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return new Response('busy', { status: streamStatus })
    }
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type HeadMode = 'auto' | 'reject' | 'hang'

/**
 * fetch 桩（名额账族，RC-B-3 用）：/stream 按 method 分流——HEAD = 探测（只判定，
 * **不改名额账**，回退成 GET 探测即被抓）、GET = 真建流（占名额）。
 */
function stubHeadProbe(mode: HeadMode = 'auto'): ReturnType<typeof vi.fn> {
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
})

afterEach(async () => {
  // R42-1（四十二轮）：fail-closed 首档退避 2s→0ms 立即换票重连——卸桩前多轮排干
  // 「宏任务定时器 → doConnect 异步链（换票 fetch → new EventSource）」级联，防 unstub
  // 后触发 new EventSource 抛 unhandled rejection（此前首档 2s 在测试生命周期内不触发）
  if (vi.isFakeTimers()) {
    vi.runOnlyPendingTimers()
    await settle()
    vi.runOnlyPendingTimers()
    await settle()
  } else {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 10))
      await settle()
    }
  }
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

// ── R73-67：429 中文指引 ────────────────────────

describe('R73-67: SSE 429（per-book 连接上限）→ 中文指引 toast', () => {
  it('fail-closed + 探测命中 429 → toast「标签页开太多」指引；探测走 header 且不烧票', async () => {
    const fetchFn = stubProbeStatus(429)
    useSse(ref('书A'))
    await settle()
    expect(SlotES.instances).toHaveLength(1)

    failClose(SlotES.instances[0]!)
    await settle()

    const ui = useUiStore()
    const toast = ui.toasts.find((t) => t.msg.includes('标签页'))
    expect(toast).toBeDefined() // 修复点：429 有中文指引
    expect(toast!.msg).toContain('关闭多余的标签页')
    expect(toast!.kind).toBe('error')
    // 探测请求形态：GET stream 端点带 token 旧通道（不带 ticket——不消费一次性票）
    expect(probeCalls).toHaveLength(1)
    expect(probeCalls[0]!.url).toContain('/api/books/%E4%B9%A6A/stream')
    // R31-32（三十一轮）：探测是 fetch（可带头）——token 走 x-studio-token 头不再进 URL；
    // 不带 ticket（不消费一次性票）的既有语义不变
    expect(probeCalls[0]!.url).not.toContain('token=')
    expect(probeCalls[0]!.headers).toMatchObject({ 'x-studio-token': 'T0' })
    // endsWith 防误吞 /api/stream-ticket（其 URL 同含 '/stream' 子串）
    expect(fetchFn.mock.calls.filter(([u]) => String(u).endsWith('/stream'))).toHaveLength(1)
  })

  it('非 429（403 凭据失效族）→ 不出指引 toast（维持原退避重连）', async () => {
    stubProbeStatus(403)
    useSse(ref('书A'))
    await settle()
    failClose(SlotES.instances[0]!)
    await settle()
    expect(useUiStore().toasts).toHaveLength(0)
  })

  it('一次连接纪元只提示一次；onopen 成功后复位（再遇 429 可再提示）', async () => {
    vi.useFakeTimers()
    stubProbeStatus(429)
    useSse(ref('书A'))
    await settle()
    const ui = useUiStore()

    failClose(SlotES.instances[0]!) // 第 1 次 fail-closed：提示 + 2s 退避
    await settle()
    expect(ui.toasts.filter((t) => t.msg.includes('标签页'))).toHaveLength(1)

    // 退避到点重连（重连协议本身由 sse-reconnect.test 覆盖，这里只为造同纪元下一次 429）
    vi.advanceTimersByTime(2_000)
    await settle()
    expect(SlotES.instances).toHaveLength(2)

    failClose(SlotES.instances[1]!) // 同纪元再次 fail-closed（重连仍 429）→ 探测仍发但不重复提示
    await settle()
    expect(ui.toasts.filter((t) => t.msg.includes('标签页'))).toHaveLength(1) // 修复点：不重复打扰

    // 再退避重连成功（onopen）→ 纪元复位；再 fail-closed → 可再提示
    vi.advanceTimersByTime(4_000) // 第 2 阶退避 4s（累计 6s：toast 1 的 5s 自动消失定时器随之回收）
    await settle()
    expect(SlotES.instances).toHaveLength(3)
    const baseCount = ui.toasts.filter((t) => t.msg.includes('标签页')).length // toast 1 已自动消失，基线归零
    SlotES.instances[2]!.onopen?.() // 连接成功：errorCount/backoffStep/busy429Notified 复位
    failClose(SlotES.instances[2]!)
    await settle()
    // 修复点：复位后同书再遇 429 能再次提示（若未复位，这里应为 baseCount 不变）
    expect(ui.toasts.filter((t) => t.msg.includes('标签页')).length).toBe(baseCount + 1)
  })

  it('切书 → 纪元复位：新书 429 可再提示，探测 URL 指向新书', async () => {
    stubProbeStatus(429)
    const name = ref('书A')
    useSse(name)
    await settle()
    const ui = useUiStore()

    failClose(SlotES.instances[0]!)
    await settle()
    expect(ui.toasts.filter((t) => t.msg.includes('标签页'))).toHaveLength(1)

    name.value = '书B'
    await settle()
    failClose(SlotES.instances[SlotES.instances.length - 1]!)
    await settle()
    // R32-34（三十二轮）：同文案 toast 合并——切书复位后的再提示把仍可见的上一条
    // 429 指引刷新（计数维持 1，消失计时重置），不再第二条堆叠；「可再提示」（notify
    // 路径确实重跑）由探测 URL 指向新书佐证
    expect(ui.toasts.filter((t) => t.msg.includes('标签页'))).toHaveLength(1)
    expect(probeCalls.at(-1)!.url).toContain('/api/books/%E4%B9%A6B/stream')
  })
})

// ── R26-78：探测超时 ────────────────────────

// R26-78（二十六轮）：probeSseBusy 探测超时——探测 fetch 挂死（半开连接/对端不回包）
// 时 probing429 恒 true，后续 fail-closed 的探测全被在途锁吞掉；超时 8s 按「非 429」
// 收场（不出指引 toast、交回退避节奏），锁释放后后续探测恢复。
describe('R26-78: probeSseBusy 探测超时', () => {
  it('探测挂死 → 8s 超时 abort 不出指引；锁释放后后续 fail-closed 可再探测', async () => {
    vi.useFakeTimers()
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/stream-ticket')) return new Response(JSON.stringify({ ticket: 'tk' }), { status: 200 })
      if (url.endsWith('/stream')) { // R31-32：探测走 header 通道，URL 不带凭据
        // 模拟真实 fetch：永不回包，但 abort 信号到达即 reject（超时通道可观察）
        return new Promise<Response>((_, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
        })
      }
      return new Response('{}')
    })
    vi.stubGlobal('fetch', fn)
    useSse(ref('书A'))
    await settle()

    failClose(SlotES.instances[0]!) // 探测 #1 发出（挂死）+ 2s 退避排定
    await settle()
    expect(useUiStore().toasts).toHaveLength(0) // 未确认 429，不出指引

    vi.advanceTimersByTime(2_000) // 退避到点重连
    await settle()
    failClose(SlotES.instances[1]!) // 探测 #1 仍在途 → 在途锁吞掉本次探测
    await settle()
    expect(fn.mock.calls.filter(([u]) => String(u).endsWith('/stream'))).toHaveLength(1) // R31-32：header 通道

    vi.advanceTimersByTime(8_000) // 探测 #1 超时 abort → catch → 锁释放（4s 退避也已重连）
    await settle()
    failClose(SlotES.instances[2]!) // 锁已释放 → 探测 #2 正常发出
    await settle()
    expect(fn.mock.calls.filter(([u]) => String(u).endsWith('/stream'))).toHaveLength(2)
    expect(useUiStore().toasts).toHaveLength(0) // 超时按「非 429」：全程无指引
  })
})

// ── RC-B-3：探测不建流（不占名额） ────────────────────────

describe('RC 源码重审 B-3: 探测不建流（不占名额）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('探测走 HEAD：末位名额不被探测占用，fail-closed 首档 0ms 重连的正式流直接建成', async () => {
    stubHeadProbe()
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
    stubHeadProbe()
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
    stubHeadProbe('reject')
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
    stubHeadProbe('hang')
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

// ── R0910-W：在途探测不跨书切换 ────────────────────────

describe('R0910-W: 在途 429 探测不跨书切换', () => {
  /** 在途探测的手动 settle + 其 AbortSignal（供中止断言） */
  let resolveProbe: ((r: Response) => void) | null = null
  let probeSignal: AbortSignal | null = null

  beforeEach(() => {
    resolveProbe = null
    probeSignal = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      // 换票桩 200 {ticket}（R0916-7-P3-19 起 404 桩即换票失败、不再回退 ?token= 开连）
      if (url.endsWith('/api/stream-ticket')) return new Response(JSON.stringify({ ticket: 'tk' }), { status: 200 })
      if (url.includes('/stream')) {
        // 探测：挂起直到用例手动 settle（忽略 abort —— 专测代闸兜底，而非 abort 通道）
        probeSignal = init?.signal ?? null
        return new Promise<Response>((res) => {
          resolveProbe = res
        })
      }
      return new Response('{}')
    }))
  })

  it('切书后在途探测 settle（429）→ 代闸丢弃，不为旧书补发指引', async () => {
    const name = ref('书A')
    useSse(name)
    await settle()
    expect(SlotES.instances).toHaveLength(1)

    failClose(SlotES.instances[0]!) // 探测 #1 发出（挂起）
    await settle()
    expect(resolveProbe).not.toBeNull()

    name.value = '书B' // 切书：disconnect（推代 + abort）→ connect B
    await settle()
    expect(SlotES.instances.at(-1)!.url).toContain('/api/books/' + encodeURIComponent('书B') + '/stream')
    expect(useUiStore().toasts).toHaveLength(0)

    // 旧探测此刻才 settle 429（模拟 fetch 忽略 abort）→ 代闸丢弃，不落旧书指引
    resolveProbe!(new Response('busy', { status: 429 }))
    await settle()
    expect(useUiStore().toasts.filter((t) => t.msg.includes('标签页'))).toHaveLength(0)
  })

  it('切书 → disconnect 中止在途探测的 AbortSignal（防悬挂探测）', async () => {
    const name = ref('书A')
    useSse(name)
    await settle()
    failClose(SlotES.instances[0]!)
    await settle()
    expect(probeSignal?.aborted).toBe(false)

    name.value = '书B'
    await settle()
    expect(probeSignal?.aborted).toBe(true)
  })
})
