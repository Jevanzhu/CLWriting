/**
 * @vitest-environment happy-dom
 *
 * 鉴权契约②回归：SSE 连接先 POST /api/stream-ticket 换一次性 ticket，再以 ?ticket= 开流。
 *
 * 覆盖：ticket 成功换得 → ?ticket= 连接；ticket 端点 404 / 异常 / 响应无 ticket →
 * 回退 ?token= 旧通道（过渡期兼容，服务端未上线时保 e2e 绿）；fail-closed 退避重连
 * 每轮重取新 ticket；token null 的 re-bootstrap 通道（N-3）不受影响。
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

  it('ticket 端点 404（服务端未就绪）→ 回退 ?token= 旧通道（过渡期兼容）', async () => {
    stubTicketFetch(() => new Response('Not Found', { status: 404 }))
    useSse(ref('书A'))
    await settle()
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('?token=T0')
  })

  it('ticket 请求网络异常 → 同样回退 ?token= 旧通道（ticket 层故障不单独打断 SSE）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    useSse(ref('书A'))
    await settle()
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('?token=T0')
  })

  it('ticket 响应体无 ticket 字段（500 信封等）→ 回退旧通道', async () => {
    stubTicketFetch(() => new Response(JSON.stringify({ error: '内部错误' }), { status: 500 }))
    useSse(ref('书A'))
    await settle()
    expect(MockES.instances[0]!.url).toContain('?token=T0')
  })

  it('fail-closed（403，readyState=CLOSED）→ 退避重连时重取新 ticket（一次性短时效，不复用旧票）', async () => {
    vi.useFakeTimers()
    let call = 0
    stubTicketFetch((url) => {
      // R73-67：fail-closed 现在附带一次 429 探测（GET /stream?token= 旧通道）——
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
// 静默断连无自愈。修复：AbortController + 5s 超时（对齐 probeSseBusy/boot 同族手法），
// 超时按既有失败语义回退 ?token= 旧通道开连。
describe('R34D-23 · 换票超时自愈', () => {
  it('ticket 端点不回包 → 5s 超时 abort → 回退 ?token= 旧通道开连（不再悬挂）', async () => {
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
    expect(MockES.instances).toHaveLength(0) // 未超时：不回退也不开连（修复前此后永久悬挂）

    await vi.advanceTimersByTimeAsync(5_000) // TICKET_TIMEOUT_MS 到点 abort
    for (let i = 0; i < 20; i++) await Promise.resolve() // 泵 catch→回退→开连微任务链
    expect(MockES.instances).toHaveLength(1) // 修复点：回退旧通道开连，SSE 不再静默断连
    expect(MockES.instances[0]!.url).toContain('?token=T0')
    expect(MockES.instances[0]!.url).not.toContain('ticket=')
  })
})
