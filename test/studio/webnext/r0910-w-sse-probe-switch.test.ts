// @vitest-environment happy-dom
/**
 * R0910-W（2026-09-10 修复批）：在途 429 探测不跨书切换。
 *
 * 修复前：probeSseBusy 用局部 AbortController（仅 8s 超时），disconnect 既不中止在途
 * 探测也不校验语境——用户切书后探测仍会 settle，并按旧书语境 toast「同一本书的标签页
 * 开太多啦」，指向用户已离开的上下文。修后：① disconnect 中止在途探测；② 探测起始
 * 捕获 connectGen 代闸，切书/断开推代后丢弃迟到的状态码（双保险，即使 fetch 忽略 abort）。
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

/** 在途探测的手动 settle + 其 AbortSignal（供中止断言） */
let resolveProbe: ((r: Response) => void) | null = null
let probeSignal: AbortSignal | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getToken.mockReturnValue('T0')
  MockES.instances = []
  resolveProbe = null
  probeSignal = null
  vi.stubGlobal('EventSource', MockES)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/stream-ticket')) return new Response('Not Found', { status: 404 })
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

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 泵微任务链：换票 → 开连 / 探测 fetch 挂起到位 */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await nextTick()
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

function failClose(inst: MockES): void {
  inst.readyState = 2
  inst.onerror?.()
}

describe('R0910-W: 在途 429 探测不跨书切换', () => {
  it('切书后在途探测 settle（429）→ 代闸丢弃，不为旧书补发指引', async () => {
    const name = ref('书A')
    useSse(name)
    await settle()
    expect(MockES.instances).toHaveLength(1)

    failClose(MockES.instances[0]!) // 探测 #1 发出（挂起）
    await settle()
    expect(resolveProbe).not.toBeNull()

    name.value = '书B' // 切书：disconnect（推代 + abort）→ connect B
    await settle()
    expect(MockES.instances.at(-1)!.url).toContain('/api/books/' + encodeURIComponent('书B') + '/stream')
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
    failClose(MockES.instances[0]!)
    await settle()
    expect(probeSignal?.aborted).toBe(false)

    name.value = '书B'
    await settle()
    expect(probeSignal?.aborted).toBe(true)
  })
})
