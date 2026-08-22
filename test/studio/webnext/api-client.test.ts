/**
 * apiJson（api/client）错误信封回归。
 *
 * dv-01：dev Vite proxy 在 7878（dev:api）未起时对 /api 返回 502 空体（无 {error, code}
 * 信封）——apiJson 应把它判为「本地 API 服务未连接」基础设施故障并给出可行动提示，
 * 而不是抛裸「HTTP 502」字符串被 friendlyError 误报成「AI 服务繁忙」。
 * 服务端正常错误仍走 {code, error} 信封原样透传（error-envelope 门禁口径不变）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { apiJson, ApiError } from '../../../src/studio/web-next/src/api/client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiJson · 本地 API 未连接（无信封 5xx）', () => {
  it('502 空体 → 抛「本地服务未连接」而非裸 HTTP 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })))
    await expect(apiJson('/api/health')).rejects.toThrow('本地服务未连接，请确认 API 服务已启动')
  })

  it('502 空体 → ApiError 带 LOCAL_API_DOWN 码与 502 状态', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })))
    try {
      await apiJson('/api/health')
      expect.unreachable('应当抛出 ApiError')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      const ae = e as ApiError
      expect(ae.status).toBe(502)
      expect(ae.code).toBe('LOCAL_API_DOWN')
    }
  })

  it('503 裸文本体 → 同样按本地未连接处理（非我们信封）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 503 })))
    await expect(apiJson('/api/health')).rejects.toThrow('本地服务未连接，请确认 API 服务已启动')
  })
})

describe('apiJson · 服务端 {code,error} 信封（回归不变）', () => {
  it('409 BUSY 信封 → 原样透出服务端 error + code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'BUSY', error: '本书正在生成，先等它跑完或中断' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    try {
      await apiJson('/api/books/x/spawn', { method: 'POST', body: '{}' })
      expect.unreachable('应当抛出 ApiError')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      const ae = e as ApiError
      expect(ae.message).toBe('本书正在生成，先等它跑完或中断')
      expect(ae.status).toBe(409)
      expect(ae.code).toBe('BUSY')
    }
  })

  it('2xx 正常响应 → 返回解析后的数据', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    await expect(apiJson('/api/health')).resolves.toEqual({ ok: true })
  })
})

// ── 低-6（第十轮）：外部 signal 的 abort 监听器生命周期（第九轮 L-4 修复残余） ──
// 旧实现 once 监听器在请求 settle 后永不移除——挂在调用方 signal 上引用着内部
// controller。修法：settle（成功/失败/超时）后 removeEventListener；abort 触发
// 路径保持 AbortError 语义，不伪装成超时。

/** 模拟 fetch 规范行为：signal abort 时以 AbortError 结束（挂起中不发真实请求） */
function fetchRejectsOnAbort() {
  return vi.fn((_path: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
    }),
  )
}

describe('apiJson · 外部 signal 监听器生命周期（低-6 第十轮）', () => {
  it('请求成功 settle 后摘除 once abort 监听器', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }))))
    const external = new AbortController()
    const addSpy = vi.spyOn(external.signal, 'addEventListener')
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener')

    await apiJson('/api/health', { signal: external.signal }, 15_000)

    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy.mock.calls[0]?.[0]).toBe('abort') // 摘的正是那条联动监听

    // settle 后再 abort 不命中任何残留监听（旧实现此处会触发闭包里的 controller.abort）
    external.abort()
    await new Promise((r) => setTimeout(r, 0))
  })

  it('超时 settle 同样摘除监听器，且超时口径不变（ApiError 408 TIMEOUT）', async () => {
    vi.stubGlobal('fetch', fetchRejectsOnAbort())
    const external = new AbortController()
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener')

    const p = apiJson('/api/health', { signal: external.signal }, 20)
    await expect(p).rejects.toMatchObject({ status: 408, code: 'TIMEOUT' })
    expect(removeSpy).toHaveBeenCalledTimes(1)
  })

  it('外部 signal 在途 abort → 原样抛 AbortError，不伪装成超时', async () => {
    vi.stubGlobal('fetch', fetchRejectsOnAbort())
    const external = new AbortController()

    const p = apiJson('/api/health', { signal: external.signal }, 5_000)
    external.abort()
    const err = await p.then(
      () => { throw new Error('应当拒绝') },
      (e: unknown) => e,
    )
    expect((err as Error).name).toBe('AbortError')
    expect(err).not.toBeInstanceOf(ApiError)
  })
})

// ── M-6（第十轮）：第九轮 L-4「预 abort signal」回归 ──
// 外部 signal 在调用前已 aborted → 预检同步补发内部 abort（abort 事件只在 abort()
// 时刻派发一次，已 abort 的 signal 不会再发），请求以已中止的 signal 进入 fetch
// （规范保证不发真实网络请求），立即以 AbortError 拒绝——预检时机无竞态窗口。

describe('apiJson · 预 abort signal（M-6 第十轮，第九轮 L-4 回归）', () => {
  it('外部 signal 调用前已 aborted → 立即 AbortError 拒绝、fetch 收到的 signal 已中止（预检无竞态窗口）', async () => {
    const seen: (AbortSignal | null | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: unknown, init?: RequestInit) => {
        seen.push(init?.signal)
        // 模拟 fetch 规范：signal 已中止 → 不发真实请求，直接 AbortError
        if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
        return new Response(JSON.stringify({ ok: true }))
      }),
    )
    const external = new AbortController()
    external.abort() // 调用前已中止

    const err = await apiJson('/api/health', { signal: external.signal }, 15_000).then(
      () => { throw new Error('预中止 signal 应立即拒绝') },
      (e: unknown) => e,
    )
    expect((err as Error).name).toBe('AbortError') // AbortError 语义，不伪装超时
    expect(err).not.toBeInstanceOf(ApiError)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true) // 预检在 fetch 前生效：signal 进入 fetch 时已中止
  })
})