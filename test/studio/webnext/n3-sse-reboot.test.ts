/**
 * @vitest-environment happy-dom
 *
 * N-3（第五十四轮）回归：SSE 连接前发现 token null 时复用 client 的 re-boot 通道。
 *
 * boot 一次性失败后 token 永久 null——SSE 连接不带 token 必 401 fail-closed，
 * 退避循环自身无法自愈（此前只能靠别的写请求触发 E-2 的 re-bootstrap）。
 * 修复后：连接前 token null → 触发一次 client 的 rebootstrap（promise 去重，
 * 不在 SSE 层另造重试风暴），settle 后重连；等待期间被 disconnect/切书接管的
 * 悬挂连接不再开。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => string | null>(() => null),
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
  static readonly CONNECTING = 0
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getToken.mockReturnValue(null)
  mocks.rebootstrap.mockImplementation(async () => {})
  MockES.instances = []
  vi.stubGlobal('EventSource', MockES)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('N-3 · SSE token null 自愈', () => {
  it('token null → 连接前触发一次 rebootstrap，settle 后带新 token 连接', async () => {
    // re-boot settle 后 token 到位（doConnect 在 rebootstrap 后重新取 token 拼 URL）
    mocks.getToken.mockReturnValue(null)
    mocks.rebootstrap.mockImplementation(async () => {
      mocks.getToken.mockReturnValue('T1')
    })
    useSse(ref('书A'))
    await nextTick()
    // rebootstrap 是 await 的——再让微任务队列走完
    await Promise.resolve()
    await nextTick()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1)
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('token=T1')
  })

  it('token 已存在 → 不触发 rebootstrap（守卫不误伤正常路径）', async () => {
    mocks.getToken.mockReturnValue('T0')
    useSse(ref('书A'))
    await nextTick()
    expect(mocks.rebootstrap).not.toHaveBeenCalled()
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('token=T0')
  })

  it('re-boot 失败（token 仍 null）→ 照常连接（不带 token）；fail-closed 退避重连时再次走 re-bootstrap 通道', async () => {
    vi.useFakeTimers()
    mocks.getToken.mockReturnValue(null)
    useSse(ref('书A'))
    await nextTick()
    await Promise.resolve()
    await nextTick()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1)
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).not.toContain('token=')

    // fail-closed（401，readyState=CLOSED）→ 2s 退避后重连 → 再次触发 re-boot
    const es0 = MockES.instances[0]!
    es0.readyState = 2
    es0.onerror?.()
    expect(es0.closed).toBe(true)
    vi.advanceTimersByTime(2_000)
    await Promise.resolve()
    await nextTick()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2) // 每轮连接恰一次，节奏受退避封顶（无自造风暴）
    expect(MockES.instances).toHaveLength(2)
  })

  it('re-bootstrap 在途时切书 → 悬挂的旧 doConnect 不再开连（connectGen 守卫）', async () => {
    // 每次调用各挂一个 pending promise，收集 resolver 便于统一/分别 settle
    const pending: (() => void)[] = []
    mocks.rebootstrap.mockImplementation(
      () => new Promise<void>((r) => pending.push(r)),
    )
    const name = ref('书A')
    useSse(name)
    await nextTick()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(1)
    expect(MockES.instances).toHaveLength(0) // re-boot 未 settle，未开连

    // re-boot 在途时切书：disconnect 推代 + 新连接（书B 的 doConnect 同样 token null 再入 re-boot）
    name.value = '书B'
    await nextTick()
    expect(mocks.rebootstrap).toHaveBeenCalledTimes(2)
    pending.splice(0).forEach((f) => f()) // 两个 re-boot 均 settle
    await Promise.resolve()
    await nextTick()
    // 旧 doConnect（书A）被代守卫拦下；书B 的 doConnect 正常开连
    const urls = MockES.instances.map((e) => decodeURIComponent(e.url))
    expect(urls).toHaveLength(1)
    expect(urls[0]!).toContain('书B')
  })
})
