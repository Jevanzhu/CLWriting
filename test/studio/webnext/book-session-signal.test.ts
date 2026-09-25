// @vitest-environment happy-dom
/**
 * R0916-7-P3-20（评审 P3-20）回归④：书会话信号接驳面（api/client.ts）。
 *
 * 被测行为 = 「API 调用带 session.signal」的接驳口径本身，不经 store/组件：
 * - 本书文档结构写（/api/books/<在册名>/documents…，POST/PATCH/DELETE）自动带会话信号，
 *   且带的**就是**会话对象的 signal（同一性，不是另造一枚）；
 * - 离书/切书 abort 会话 → 在途请求以 AbortError 收口（apiJson 不伪报 MALFORMED_RESPONSE）；
 * - 接驳面刻意收窄的三条反例（读面 GET / 保存写面 PUT / 他书路径）不接，且会话 abort
 *   不会把它们打断——这是行为不变的前提（这些面的错误面不在本批文件面内）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  beginBookSession,
  currentBookSession,
  endBookSession,
} from '../../../src/studio/web-next/src/composables/useBookSession'
import { isAbortError } from '../../../src/studio/web-next/src/api/client'
import { getContentPayload, moveDoc, saveContent } from '../../../src/studio/web-next/src/api/documents'

/** fetch 桩捕获的 init（本文件只用 signal 面）。 */
interface CapturedInit {
  signal?: AbortSignal
  method?: string
}
const fetchMock = vi.fn()
const initOf = (callIndex: number): CapturedInit => fetchMock.mock.calls[callIndex]![1] as CapturedInit
const lastInit = (): CapturedInit => initOf(fetchMock.mock.calls.length - 1)

/** 默认桩：按真实 fetch 语义挂 signal 监听——请求保持挂起，signal abort 时 reject AbortError。 */
function installFetch(): void {
  fetchMock.mockImplementation((_url: string, init?: CapturedInit) => {
    const signal = init?.signal
    if (signal?.aborted) return Promise.reject(new DOMException('This operation was aborted', 'AbortError'))
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true })
    })
  })
}

/** 请求结局（本文件只关心「是否以 AbortError 收口」）。 */
const settle = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e)

beforeEach(() => {
  vi.clearAllMocks()
  installFetch()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  endBookSession()
  vi.unstubAllGlobals()
})

describe('R0916-7-P3-20: 会话信号接驳面（本书结构写接、读/保存/他书不接）', () => {
  it('本书文档结构写（PATCH /documents/:id）接会话信号；离书即中止 → AbortError', async () => {
    const session = beginBookSession('书A')!
    const p = moveDoc('书A', 'd1', '写作/正文/第二卷')
    const init = lastInit()
    expect(init.signal).toBeDefined() // apiJson 转发 fetch 的恒是内部 signal（与外部联动）
    expect(init.signal!.aborted).toBe(false)
    endBookSession()
    // 接驳判定用行为而非同一性：会话 abort → 本请求的 signal 随之中止（外部 signal 联动）
    expect(session.signal.aborted).toBe(true)
    expect(init.signal!.aborted).toBe(true)
    expect(isAbortError(await settle(p))).toBe(true)
  })

  it('DELETE / POST（定稿族）同样接（章节树动作族全覆盖）', async () => {
    const { batchFinalizeDocs, deleteDoc } = await import('../../../src/studio/web-next/src/api/documents')
    beginBookSession('书A')
    const d = deleteDoc('书A', 'd1')
    const dInit = lastInit()
    const f = batchFinalizeDocs('书A', ['d1'])
    const fInit = lastInit()
    endBookSession()
    expect(dInit.signal!.aborted).toBe(true)
    expect(fInit.signal!.aborted).toBe(true)
    expect(isAbortError(await settle(d))).toBe(true)
    expect(isAbortError(await settle(f))).toBe(true)
  })

  it('读面不接（GET /file）：会话 abort 不打断在读请求', async () => {
    const session = beginBookSession('书A')!
    void settle(getContentPayload('书A', '写作/正文/0001-第一章.md'))
    const init = lastInit()
    expect(init.signal).toBeDefined() // 内部超时 controller（apiJson 自有）
    endBookSession()
    expect(session.signal.aborted).toBe(true)
    expect(init.signal!.aborted).toBe(false) // 读面不受切书 abort 影响
  })

  it('保存写面不接（PUT /documents/:id/content）：会话 abort 不打断保存', async () => {
    const session = beginBookSession('书A')!
    void settle(saveContent('书A', 'd1', { content: '正文', expectedRevision: null, operationId: 'op-1' }))
    const init = lastInit()
    endBookSession()
    expect(session.signal.aborted).toBe(true)
    expect(init.signal!.aborted).toBe(false)
  })

  it('他书路径不接：B 书的请求不会挂在 A 的会话上', async () => {
    const session = beginBookSession('书A')!
    void settle(moveDoc('书B', 'd1', '写作/正文/第二卷'))
    const init = lastInit()
    endBookSession()
    expect(session.signal.aborted).toBe(true)
    expect(init.signal!.aborted).toBe(false)
  })

  it('切书顶替（begin 新会话）中止在途旧书请求；新请求不被旧信号牵连', async () => {
    beginBookSession('书A')
    const p = moveDoc('书A', 'd1', '写作/正文/第二卷')
    const stale = lastInit().signal!
    beginBookSession('书A') // A → B → A 回环里的同名重进也是新会话
    expect(isAbortError(await settle(p))).toBe(true)
    void settle(moveDoc('书A', 'd1', '写作/正文/第二卷'))
    const fresh = lastInit().signal!
    expect(stale.aborted).toBe(true)
    expect(fresh.aborted).toBe(false) // 新会话自己的内部 signal，未被上一段作废牵连
  })

  it('无在册会话时不接（未进书窗口：请求照常发，与接驳前逐位一致）', () => {
    void settle(moveDoc('书A', 'd1', '写作/正文/第二卷'))
    const init = lastInit()
    expect(init.signal).toBeDefined()
    expect(init.signal!.aborted).toBe(false)
    expect(currentBookSession()).toBeNull()
  })

  it('会话已 abort 后新发的请求不再被接驳（免把新请求立刻打断）', () => {
    const session = beginBookSession('书A')!
    endBookSession()
    void settle(moveDoc('书A', 'd1', '写作/正文/第二卷'))
    const init = lastInit()
    expect(init.signal!.aborted).toBe(false)
    expect(session.signal.aborted).toBe(true)
  })
})
