// @vitest-environment happy-dom
/**
 * E-6（第五十三轮）回归：useHeartbeat 退书复位与卸载 DELETE 守卫。
 *
 * - E-6a：退书/停止心跳时 serverOnline 复位回初始在线态——最后一次 beat 失败的
 *   假阴性不挂到下次进书（StatusBar 误显离线）。
 * - E-6b：卸载 DELETE 在 token null（boot 未成功）时跳过——必 401 徒劳且会误触发
 *   E-2 的 re-boot；让服务端过期回收。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, defineComponent, type Ref } from 'vue'
import { mount } from '@vue/test-utils'

const { fetchMock, tokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  tokenMock: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  apiFetch: fetchMock,
  getToken: tokenMock,
}))

import { useHeartbeat, serverOnline } from '../../../src/studio/web-next/src/composables/useHeartbeat'

/** 挂一个调用 useHeartbeat 的组件，返回控制 bookName 与卸载句柄 */
function mountHeartbeat(bookName: Ref<string | null>) {
  return mount(
    defineComponent({
      setup() {
        useHeartbeat(() => bookName.value)
        return () => null
      },
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  tokenMock.mockReturnValue(null)
  serverOnline.value = true
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('E-6a · serverOnline 退书复位', () => {
  it('进书 beat 失败置离线 → 退书（bookName→null）后复位为在线初始态', async () => {
    const book = ref<string | null>('b1')
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    mountHeartbeat(book)
    await vi.waitUntil(() => serverOnline.value === false)
    book.value = null // 退书：watch 停止心跳
    await vi.waitFor(() => expect(serverOnline.value).toBe(true))
  })

  it('beat 失败后组件卸载 → 同样复位为在线初始态', async () => {
    const book = ref<string | null>('b1')
    fetchMock.mockRejectedValue(new TypeError('network down'))
    const w = mountHeartbeat(book)
    await vi.waitUntil(() => serverOnline.value === false)
    w.unmount()
    expect(serverOnline.value).toBe(true)
  })

  it('进书 beat 成功 → 保持在线（回归）', async () => {
    const book = ref<string | null>('b1')
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    mountHeartbeat(book)
    await vi.waitFor(() =>
      // R26-77：beat 带 10s 超时 signal（其余形状不变）
      expect(fetchMock).toHaveBeenCalledWith('/api/books/b1/heartbeat', {
        method: 'POST',
        signal: expect.anything(),
      }),
    )
    expect(serverOnline.value).toBe(true)
  })
})

describe('E-6b · 卸载 DELETE 的 token 守卫', () => {
  it('token null → 卸载跳过 DELETE（本地放弃，服务端过期回收）', async () => {
    const book = ref<string | null>('b1')
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const w = mountHeartbeat(book)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    w.unmount()
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1) // 只有进书 beat 的 POST，无 DELETE
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true)
  })

  it('token 存在 → 卸载发出 DELETE 清除心跳（既有语义回归）', async () => {
    tokenMock.mockReturnValue('T1')
    const book = ref<string | null>('b1')
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const w = mountHeartbeat(book)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    w.unmount()
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/books/b1/heartbeat', { method: 'DELETE' }),
    )
  })
})

// R26-77（二十六轮）：beat 10s 超时 + 在途去重——原实现无超时（对端挂死 promise 永不
// settle，在线信号冻结）且每拍无条件并发（慢网叠加堆积）。
describe('R26-77 · beat 超时与在途去重', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('上一拍在途 → 下一拍跳过（不叠加并发心跳）；settle 后恢复正常节拍', async () => {
    vi.useFakeTimers()
    const book = ref<string | null>('b1')
    let release!: (v: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>((r) => (release = r))) // 悬挂
    const w = mountHeartbeat(book)
    await vi.advanceTimersByTimeAsync(0) // 首拍已发起（在途）
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(20_000) // 第二拍到点：首拍仍在途 → 跳过
    expect(fetchMock).toHaveBeenCalledTimes(1) // 修复点：在途去重

    release(new Response('{}', { status: 200 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(serverOnline.value).toBe(true)

    await vi.advanceTimersByTimeAsync(20_000) // 首拍已 settle → 节拍恢复正常发送
    expect(fetchMock).toHaveBeenCalledTimes(2)
    w.unmount()
  })

  it('beat 挂死 → 10s 超时 abort 置离线（在线信号不再冻结）', async () => {
    vi.useFakeTimers()
    // 模拟真实 fetch：从不回包，但 abort 信号到达即 reject（超时通道可观察）
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
      }),
    )
    const book = ref<string | null>('b1')
    const w = mountHeartbeat(book)
    await vi.advanceTimersByTimeAsync(0)
    expect(serverOnline.value).toBe(true) // 未超时前维持在线

    await vi.advanceTimersByTimeAsync(10_000)
    expect(serverOnline.value).toBe(false) // 修复点：超时 → catch → 离线（此前永久冻结）
    w.unmount()
  })
})

// R34D-24（三十四轮）：卸载 DELETE 用落拍捕获的书名——Book.vue 的 bookName 是
// route.params 派生的 computed，离开 /book/:name 后取值归空，leave() 重读
// getBookName() 拿到空串 → DELETE 实际不可达（只能靠服务端过期回收）。修复：beat
// 落拍即捕获书名，leave 用捕获值（e6 既有用例用静态 ref 掩盖了此不可达）。
describe('R34D-24 · 卸载 DELETE 用落拍捕获书名', () => {
  it('进书落拍后 getBookName 归空（卸载时路由参数已变）再卸载 → 仍按捕获书名发 DELETE', async () => {
    tokenMock.mockReturnValue('T1')
    const book = ref<string | null>('b1')
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const w = mountHeartbeat(book)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    book.value = null // 生产时序复刻：卸载前路由参数已归空（watch 先 stop）
    w.unmount()
    // 修复点：捕获书名 b1 的 DELETE（修复前重读为 null 跳过，DELETE 不可达）
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/books/b1/heartbeat', { method: 'DELETE' }),
    )
  })

  it('未进书即卸载（无落拍）→ 不发 DELETE（对照组）', async () => {
    tokenMock.mockReturnValue('T1')
    const book = ref<string | null>(null)
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const w = mountHeartbeat(book)
    w.unmount()
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
