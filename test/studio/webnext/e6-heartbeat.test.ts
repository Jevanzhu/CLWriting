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
      expect(fetchMock).toHaveBeenCalledWith('/api/books/b1/heartbeat', { method: 'POST' }),
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
