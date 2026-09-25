/**
 * @vitest-environment happy-dom
 *
 * 鉴权契约②回归：SSE 连接先 POST /api/stream-ticket 换一次性 ticket，再以 ?ticket= 开流。
 *
 * 覆盖：ticket 成功换得 → ?ticket= 连接；fail-closed 退避重连每轮重取新 ticket（一次性
 * 短时效）；token null 的 re-bootstrap 通道（N-3）不受影响。
 * R0916-7-P3-19：换票失败（404/网络/5xx/超时）不再回退 ?token= 旧通道（回退通道两端
 * 同删——长期 token 拼进 URL 与契约「token 不进 URL」相悖，前后端同包同版发布无过渡
 * 兼容对象）——本轮不开连，并入既有 fail-closed 退避重连（同档位公式、同调度点）。
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

/** ticket 端点的 fetch 桩：默认返回 200 {ticket} */
function stubTicketFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | never) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getToken.mockReturnValue('T0')
  MockES.instances = []
  vi.stubGlobal('EventSource', MockES)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 泵微任务链：让 doConnect 的「re-boot（如需）→ 换票 → new EventSource」链走到位 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
}

describe('契约② · SSE ticket 化', () => {
  it('连接前 POST /api/stream-ticket（带 x-studio-token 头）→ EventSource 用 ?ticket= 连接', async () => {
    const fetchFn = stubTicketFetch((url, init) => {
      // R62-49：dev 下 ticket 走 DEV_API_BASE 直连同实例（base 前缀）→ 桩改为 endswith 匹配
      // 兼容相对与 base 前缀两种形态（生产同源仍为相对路径）
      if (url.endsWith('/api/stream-ticket')) {
        expect(init?.method).toBe('POST')
        expect(new Headers(init?.headers).get('x-studio-token')).toBe('T0')
        return new Response(JSON.stringify({ ticket: 'K1' }), { status: 200 })
      }
      return new Response('{}')
    })
    useSse(ref('书A'))
    await settle()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('?ticket=K1')
    expect(MockES.instances[0]!.url).not.toContain('token=')
  })

  // R0916-7-P3-19：换票失败三形态（404 / 网络错 / 5xx 信封）统一断言——不回退 ?token=
  // 开连，并入既有退避（首档 0ms 立即换票重试）；恢复后连接只带一次性 ticket。
  it('换票 404 → 不回退 ?token=：本轮不开连，退避 0ms 重试换票成功后 ?ticket= 开连', async () => {
    vi.useFakeTimers()
    let healthy = false
    const fetchFn = stubTicketFetch((url) => {
      if (url.endsWith('/api/stream-ticket')) {
        return healthy
          ? new Response(JSON.stringify({ ticket: 'K1' }), { status: 200 })
          : new Response('Not Found', { status: 404 })
      }
      return new Response('{}')
    })
    useSse(ref('书A'))
    await settle()
    expect(fetchFn).toHaveBeenCalledTimes(1) // 仅换票一次
    expect(MockES.instances).toHaveLength(0) // 修复点：不再回退 ?token= 开连

    healthy = true
    await vi.advanceTimersByTimeAsync(0) // 退避首档 0ms：立即换票重试
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('?ticket=K1')
    expect(MockES.instances[0]!.url).not.toContain('token=') // 长期 token 不进 URL
  })

  it('换票网络异常 → 同样并入退避重连（ticket 层故障不单独打断 SSE 节奏）', async () => {
    vi.useFakeTimers()
    let healthy = false
    stubTicketFetch((url) => {
      if (url.endsWith('/api/stream-ticket')) {
        if (!healthy) throw new TypeError('fetch failed')
        return new Response(JSON.stringify({ ticket: 'K2' }), { status: 200 })
      }
      return new Response('{}')
    })
    useSse(ref('书A'))
    await settle()
    expect(MockES.instances).toHaveLength(0) // 不回退开连

    healthy = true
    await vi.advanceTimersByTimeAsync(0)
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('?ticket=K2')
    expect(MockES.instances[0]!.url).not.toContain('token=')
  })

  it('换票 500（无 ticket 字段信封）→ 并入退避重连', async () => {
    vi.useFakeTimers()
    let healthy = false
    stubTicketFetch((url) => {
      if (url.endsWith('/api/stream-ticket')) {
        return healthy
          ? new Response(JSON.stringify({ ticket: 'K3' }), { status: 200 })
          : new Response(JSON.stringify({ error: '内部错误' }), { status: 500 })
      }
      return new Response('{}')
    })
    useSse(ref('书A'))
    await settle()
    expect(MockES.instances).toHaveLength(0)

    healthy = true
    await vi.advanceTimersByTimeAsync(0)
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('?ticket=K3')
  })

  it('fail-closed（403，readyState=CLOSED）→ 退避重连时重取新 ticket（一次性短时效，不复用旧票）', async () => {
    vi.useFakeTimers()
    let call = 0
    stubTicketFetch((url) => {
      // R73-67：fail-closed 现在附带一次 429 探测（HEAD /stream，header 通道）——
      // 该请求不走换票端点，桩按 URL 分流只对 /api/stream-ticket 发号（生产语义）
      if (!String(url).endsWith('/api/stream-ticket')) return new Response('{}', { status: 200 })
      call++
      return new Response(JSON.stringify({ ticket: `K${call}` }), { status: 200 })
    })
    useSse(ref('书A'))
    await settle()
    expect(MockES.instances[0]!.url).toContain('?ticket=K1')

    const es0 = MockES.instances[0]!
    es0.readyState = 2
    es0.onerror?.() // ticket 失效/连接失败 → fail-closed 退避路径
    vi.advanceTimersByTime(2_000)
    await settle() // 退避重连的 doConnect 异步换票开连
    expect(MockES.instances).toHaveLength(2)
    expect(MockES.instances[1]!.url).toContain('?ticket=K2') // 重连用的是新取的 ticket
  })

  it('token null → 先走 N-3 re-bootstrap 通道，settle 后取 token 再换 ticket 连接', async () => {
    mocks.getToken.mockReturnValue(null)
    mocks.rebootstrap.mockImplementation(async () => {
      mocks.getToken.mockReturnValue('T1')
    })
    stubTicketFetch(() => new Response(JSON.stringify({ ticket: 'K9' }), { status: 200 }))
    useSse(ref('书A'))
    await settle()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1)
    expect(MockES.instances[0]!.url).toContain('?ticket=K9')
  })

  it('换 ticket 在途时切书（disconnect 推代）→ 悬挂的旧 doConnect 不再开连', async () => {
    // 两次换票请求各自挂起；resolver 存数组，按序释放
    const pending: ((r: Response) => void)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            pending.push(r)
          }),
      ),
    )
    const name = ref('书A')
    useSse(name)
    await nextTick()
    expect(MockES.instances).toHaveLength(0) // ticket 未归来，未开连
    name.value = '书B' // 在途切书：disconnect 推代 + 新一轮 doConnect（再次挂起换 ticket）
    await nextTick()
    expect(pending).toHaveLength(2)
    const [r1, r2] = pending
    r2!(new Response(JSON.stringify({ ticket: 'K-B' }), { status: 200 })) // 书B 的换票先归来
    r1!(new Response(JSON.stringify({ ticket: 'K-A' }), { status: 200 })) // 书A 的也 settle
    await settle()
    const urls = MockES.instances.map((e) => decodeURIComponent(e.url))
    expect(urls).toHaveLength(1) // 旧 doConnect（书A）被代守卫拦下
    expect(urls[0]).toContain('书B')
    expect(urls[0]).toContain('ticket=K-B')
  })
})

// R34D-23（三十四轮）：换票超时——服务端半死（接受连接不回包）时裸 fetch 永不
// settle，doConnect 悬挂在换票 await：不建 EventSource、无 onerror 退避接管，SSE
// 静默断连无自愈。修复：AbortController + 5s 超时（对齐 probeSseBusy/boot 同族手法）。
// R0916-7-P3-19：超时按换票失败处理——不回退 ?token= 开连，并入既有退避重连。
describe('R34D-23 · 换票超时自愈', () => {
  it('ticket 端点不回包 → 5s 超时 abort → 不回退开连，退避到点重试换票（不再悬挂）', async () => {
    vi.useFakeTimers()
    // 模拟真实 fetch：不回包，但 abort 信号到达即 reject（超时通道可观察）
    const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/stream-ticket')) {
        // 修复点：换票请求带超时 signal（修复前裸 fetch 无 abort 面）
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return new Promise<Response>((_, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
        })
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchFn)
    useSse(ref('书A'))
    await vi.advanceTimersByTimeAsync(0) // doConnect 链走到换票挂起
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(MockES.instances).toHaveLength(0) // 未超时：不开连

    await vi.advanceTimersByTimeAsync(5_001) // TICKET_TIMEOUT_MS 5s 到点 abort（+1ms：tick 内排程的 0ms 退避档在 sinon 下落在下一毫刻）
    expect(MockES.instances).toHaveLength(0) // 修复点：不回退 ?token= 开连（原实现此处已开）
    expect(fetchFn).toHaveBeenCalledTimes(2) // 并入退避：到点再换票（仍挂起，节奏保留）
  })
})

// R0916-7-P3-19：纪元状态对象（SseEpochState）复位归零——构造 error → 重连成功（onopen）
// 后各字段无残留：退避阶数回 0ms 起阶、429 指引已告位归零、401 自愈截断连记解除武装。
describe('R0916-7-P3-19 · 纪元状态复位归零', () => {
  /** fail-closed 一轮并泵完「退避到点 → 换票 → 开连」链；返回新连接 */
  async function failClosedRound(es: MockES, delayMs: number): Promise<MockES> {
    es.readyState = MockES.CLOSED
    es.onerror?.()
    const before = MockES.instances.length
    await vi.advanceTimersByTimeAsync(delayMs)
    await settle()
    expect(MockES.instances).toHaveLength(before + 1)
    return MockES.instances[MockES.instances.length - 1]!
  }

  it('退避档位与 429 已告位复位：onopen 后再故障首档仍 0ms，429 指引可再弹', async () => {
    vi.useFakeTimers()
    const probeStatus = 429 // 探测恒 429：每轮 fail-closed 出指引（首次）
    stubTicketFetch((url) => {
      if (url.endsWith('/api/stream-ticket')) return new Response(JSON.stringify({ ticket: 'K' }), { status: 200 })
      return new Response('', { status: probeStatus })
    })
    // 直接 spy ui.toast 动作计数——ui store 对同文案同级别 toast 合并（R32-34），
    // toasts 数组长度数不出重复弹出
    const toastSpy = vi.spyOn(useUiStore(), 'toast').mockImplementation(() => {})
    useSse(ref('书A'))
    await settle()

    // 纪元内：fail-closed → 探测 429 弹指引一次；0ms 重连
    const es1 = await failClosedRound(MockES.instances[0]!, 0)
    expect(toastSpy).toHaveBeenCalledTimes(1)

    // 重连成功 = 新纪元复位
    es1.onopen?.()
    await settle()

    // 无残留①：退避阶数归零——再 fail-closed 首档仍 0ms（残留则 4s）
    await failClosedRound(es1, 0)
    // 无残留②：busy429Notified 归零——同轮探测 429 再次弹指引（已告位未复位则此处不来）
    expect(toastSpy).toHaveBeenCalledTimes(2)
  })

  it('401 自愈截断连记复位：onopen 后首见 401 重新获得完整自愈（截断态不跨纪元压制）', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probeStatus = 401
    stubTicketFetch((url) => {
      if (url.endsWith('/api/stream-ticket')) return new Response(JSON.stringify({ ticket: 'K' }), { status: 200 })
      return new Response('', { status: probeStatus })
    })
    useSse(ref('书A'))
    await settle()
    const fails = (): string[] => warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('双基址'))

    // 纪元内连续三轮探测 401：armed 自愈（rb#1）→ strike1 自愈（rb#2）→ strike2 达阈值
    // 指引一次并截断（不再逐轮自愈）
    let es = await failClosedRound(MockES.instances[0]!, 0)
    es = await failClosedRound(es, 4_000)
    es = await failClosedRound(es, 8_000)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2)
    expect(fails()).toHaveLength(1)

    // 重连成功 = 新纪元复位
    es.onopen?.()
    await settle()

    // 无残留③：armed/Guided 归零——再遇 401 重新走完整自愈（截断态残留则 rebootstrap 不再增长）
    await failClosedRound(es, 0)
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(3) // 修复点：自愈重新武装
    expect(fails()).toHaveLength(1) // strike 未达阈值：无第二次指引（Guided 已归零的正常表现）
    warnSpy.mockRestore()
  })
})
