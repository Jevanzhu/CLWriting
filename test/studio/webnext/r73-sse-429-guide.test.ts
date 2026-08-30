// @vitest-environment happy-dom
/**
 * R73-67（二十一轮批 E，D 域移交前端面）回归：per-book SSE 连接数上限（第 6 个标签页
 * 429 BUSY）的前端指引。
 *
 * EventSource 不暴露状态码/body——429 与 403/404 一样只表现为 fail-closed（onerror 一次，
 * readyState=CLOSED），作者此前只见「连接断开」毫无指引。修复后 fail-closed 接管退避前
 * 发一次探测请求（?token= 旧通道：服务端只比对凭据不消费 ticket；429 判定在连接登记前，
 * 不占连接槽）拿状态码：429 → 中文指引 toast「关闭多余标签页」；一次连接纪元只提示一次
 * （onopen 成功/切书复位）；非 429 不提示。
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

/** fetch 桩：按 URL 分流——ticket 端点 404（EventSource 回退通道），stream 端点按指定状态回 */
function stubFetch(streamStatus: number): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/stream-ticket')) return new Response('Not Found', { status: 404 })
    if (url.includes('/stream')) {
      probeUrls.push(url)
      probeHeaders.push(init?.headers as Record<string, string> | undefined)
      return new Response('busy', { status: streamStatus })
    }
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
const probeUrls: string[] = []
const probeHeaders: Array<Record<string, string> | undefined> = []

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getToken.mockReturnValue('T0')
  MockES.instances = []
  probeUrls.length = 0
  vi.stubGlobal('EventSource', MockES)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 泵微任务链：换票 → 开连 / 探测 fetch → toast 全部落定 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function failClose(inst: MockES): void {
  inst.readyState = 2
  inst.onerror?.()
}

describe('R73-67: SSE 429（per-book 连接上限）→ 中文指引 toast', () => {
  it('fail-closed + 探测命中 429 → toast「标签页开太多」指引；探测走 ?token= 且不烧票', async () => {
    const fetchFn = stubFetch(429)
    useSse(ref('书A'))
    await settle()
    expect(MockES.instances).toHaveLength(1)

    failClose(MockES.instances[0]!)
    await settle()

    const ui = useUiStore()
    const toast = ui.toasts.find((t) => t.msg.includes('标签页'))
    expect(toast).toBeDefined() // 修复点：429 有中文指引
    expect(toast!.msg).toContain('关闭多余的标签页')
    expect(toast!.kind).toBe('error')
    // 探测请求形态：GET stream 端点带 token 旧通道（不带 ticket——不消费一次性票）
    expect(probeUrls).toHaveLength(1)
    expect(probeUrls[0]).toContain('/api/books/%E4%B9%A6A/stream')
    // R31-32（三十一轮）：探测是 fetch（可带头）——token 走 x-studio-token 头不再进 URL；
    // 不带 ticket（不消费一次性票）的既有语义不变
    expect(probeUrls[0]).not.toContain('token=')
    expect(probeHeaders[0]).toMatchObject({ 'x-studio-token': 'T0' })
    // endsWith 防误吞 /api/stream-ticket（其 URL 同含 '/stream' 子串）
    expect(fetchFn.mock.calls.filter(([u]) => String(u).endsWith('/stream'))).toHaveLength(1)
  })

  it('非 429（403 凭据失效族）→ 不出指引 toast（维持原退避重连）', async () => {
    stubFetch(403)
    useSse(ref('书A'))
    await settle()
    failClose(MockES.instances[0]!)
    await settle()
    expect(useUiStore().toasts).toHaveLength(0)
  })

  it('一次连接纪元只提示一次；onopen 成功后复位（再遇 429 可再提示）', async () => {
    vi.useFakeTimers()
    stubFetch(429)
    useSse(ref('书A'))
    await settle()
    const ui = useUiStore()

    failClose(MockES.instances[0]!) // 第 1 次 fail-closed：提示 + 2s 退避
    await settle()
    expect(ui.toasts.filter((t) => t.msg.includes('标签页'))).toHaveLength(1)

    // 退避到点重连（重连协议本身由 sse-reconnect.test 覆盖，这里只为造同纪元下一次 429）
    vi.advanceTimersByTime(2_000)
    await settle()
    expect(MockES.instances).toHaveLength(2)

    failClose(MockES.instances[1]!) // 同纪元再次 fail-closed（重连仍 429）→ 探测仍发但不重复提示
    await settle()
    expect(ui.toasts.filter((t) => t.msg.includes('标签页'))).toHaveLength(1) // 修复点：不重复打扰

    // 再退避重连成功（onopen）→ 纪元复位；再 fail-closed → 可再提示
    vi.advanceTimersByTime(4_000) // 第 2 阶退避 4s（累计 6s：toast 1 的 5s 自动消失定时器随之回收）
    await settle()
    expect(MockES.instances).toHaveLength(3)
    const baseCount = ui.toasts.filter((t) => t.msg.includes('标签页')).length // toast 1 已自动消失，基线归零
    MockES.instances[2]!.onopen?.() // 连接成功：errorCount/backoffStep/busy429Notified 复位
    failClose(MockES.instances[2]!)
    await settle()
    // 修复点：复位后同书再遇 429 能再次提示（若未复位，这里应为 baseCount 不变）
    expect(ui.toasts.filter((t) => t.msg.includes('标签页')).length).toBe(baseCount + 1)
  })

  it('切书 → 纪元复位：新书 429 可再提示，探测 URL 指向新书', async () => {
    stubFetch(429)
    const name = ref('书A')
    useSse(name)
    await settle()
    const ui = useUiStore()

    failClose(MockES.instances[0]!)
    await settle()
    expect(ui.toasts.filter((t) => t.msg.includes('标签页'))).toHaveLength(1)

    name.value = '书B'
    await settle()
    failClose(MockES.instances[MockES.instances.length - 1]!)
    await settle()
    expect(ui.toasts.filter((t) => t.msg.includes('标签页'))).toHaveLength(2) // 切书复位后再提示
    expect(probeUrls.at(-1)).toContain('/api/books/%E4%B9%A6B/stream')
  })
})

// R26-78（二十六轮）：probeSseBusy 探测超时——探测 fetch 挂死（半开连接/对端不回包）
// 时 probing429 恒 true，后续 fail-closed 的探测全被在途锁吞掉；超时 8s 按「非 429」
// 收场（不出指引 toast、交回退避节奏），锁释放后后续探测恢复。
describe('R26-78: probeSseBusy 探测超时', () => {
  it('探测挂死 → 8s 超时 abort 不出指引；锁释放后后续 fail-closed 可再探测', async () => {
    vi.useFakeTimers()
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/stream-ticket')) return new Response('Not Found', { status: 404 })
      if (url.endsWith('/stream')) { // R31-32：探测改 header 通道，URL 不再带 ?token=
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

    failClose(MockES.instances[0]!) // 探测 #1 发出（挂死）+ 2s 退避排定
    await settle()
    expect(useUiStore().toasts).toHaveLength(0) // 未确认 429，不出指引

    vi.advanceTimersByTime(2_000) // 退避到点重连
    await settle()
    failClose(MockES.instances[1]!) // 探测 #1 仍在途 → 在途锁吞掉本次探测
    await settle()
    expect(fn.mock.calls.filter(([u]) => String(u).endsWith('/stream'))).toHaveLength(1) // R31-32：header 通道

    vi.advanceTimersByTime(8_000) // 探测 #1 超时 abort → catch → 锁释放（4s 退避也已重连）
    await settle()
    failClose(MockES.instances[2]!) // 锁已释放 → 探测 #2 正常发出
    await settle()
    expect(fn.mock.calls.filter(([u]) => String(u).endsWith('/stream'))).toHaveLength(2)
    expect(useUiStore().toasts).toHaveLength(0) // 超时按「非 429」：全程无指引
  })
})
