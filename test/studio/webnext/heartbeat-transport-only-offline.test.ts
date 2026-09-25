// @vitest-environment happy-dom
/**
 * 0918二轮修复批（E104）回归：心跳只由传输层失败（网络异常/超时 abort）驱动离线与
 * 连败——业务 4xx（404 书已删 / 401 / 5xx）服务进程仍在线，收到响应即 online=true
 * 且清零连败。原实现按 r.ok 计离线连败，业务 4xx 误报离线徽章并驱动 SSE 看门狗
 * 误 resync。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { defineComponent, type Ref } from 'vue'

const { fetchMock, tokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  tokenMock: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  apiFetch: fetchMock,
  getToken: tokenMock,
}))

import { useHeartbeat, serverOnline, heartbeatFailStreak } from '../../../src/studio/web-next/src/composables/useHeartbeat'

/** 挂一个调用 useHeartbeat 的组件（沿 heartbeat-lifecycle 手法） */
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
  heartbeatFailStreak.value = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('E104: 业务 4xx ≠ 离线（传输层判定）', () => {
  it('404 响应（书已删）→ online=true、连败清零（修复前：误报离线+连败累计）', async () => {
    const book = ref<string | null>('b1')
    heartbeatFailStreak.value = 2 // 预置连败：有响应应清零
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    mountHeartbeat(book)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(serverOnline.value).toBe(true) // 修复点：服务进程在线
    expect(heartbeatFailStreak.value).toBe(0) // 修复点：连败清零
  })

  it('401 响应（token 失效）→ online=true、连败清零（re-boot 留给 apiFetch 内自愈）', async () => {
    const book = ref<string | null>('b1')
    fetchMock.mockResolvedValue(new Response('', { status: 401 }))
    mountHeartbeat(book)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(serverOnline.value).toBe(true)
    expect(heartbeatFailStreak.value).toBe(0)
  })

  it('网络错误（fetch 抛错）→ online=false、连败 +1（离线信号不回归）', async () => {
    const book = ref<string | null>('b1')
    fetchMock.mockRejectedValue(new TypeError('network down'))
    mountHeartbeat(book)
    await vi.waitFor(() => expect(serverOnline.value).toBe(false))
    expect(heartbeatFailStreak.value).toBe(1)
  })

  it('连续网络错误累计连败（SSE 看门狗消费面语义保留）', async () => {
    vi.useFakeTimers()
    try {
      const book = ref<string | null>('b1')
      fetchMock.mockRejectedValue(new TypeError('network down'))
      const w = mountHeartbeat(book)
      await vi.advanceTimersByTimeAsync(0) // 首拍失败
      await vi.advanceTimersByTimeAsync(20_000) // 第二拍失败
      expect(heartbeatFailStreak.value).toBe(2) // 看门狗阈值形态（R55-F-2 ≥2 触发 resync）
      expect(serverOnline.value).toBe(false)
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
