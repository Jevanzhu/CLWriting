/**
 * R28-4（二十八轮）回归：401/403 响应体 cancel 时机。
 *
 * 缺陷（R26-81 的连带回归）：apiFetch 收到 401/403 时无条件 `r.body?.cancel()`，
 * 但仅 token 变化才重放——不重放路径（token 未变/为 null：Origin/权限类 403、
 * 离线 boot 失败）把响应体已废的 Response 透传调用方 → apiJson 的 `r.json()`
 * 抛 TypeError → 落入「无信封」分支，服务端真实 {code,error} 信封被伪造成
 * 「本地服务未连接/LOCAL_API_DOWN」，误导排查方向。
 * 修法：cancel 只在**确定重放**的分支执行（R26-81 连接池动机保留——re-boot 窗口
 * 内的并发未读流才是挤占面）；不重放路径响应体完整返回，信封正常解析。
 *
 * token 为 client 模块级变量：每例 vi.resetModules + 动态 import 取干净实例（同 e2-client-reboot）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

function jsonRes(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function freshClient(): Promise<
  typeof import('../../../src/studio/web-next/src/api/client')
> {
  vi.resetModules()
  const c = await import('../../../src/studio/web-next/src/api/client')
  // R64-43（十二轮）：退避注入点换 no-op sleep（不 stubGlobal setTimeout，避免伤及
  // AbortController 计时）——boot 若走重试不垫真实墙钟等待。
  c.__testHooks.sleep = async () => {}
  return c
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('R28-4 · 不重放路径响应体完整（信封不被伪造为 LOCAL_API_DOWN）', () => {
  it('403 + token 未变（Origin/权限类）→ apiJson 抛真实信封 code，非 LOCAL_API_DOWN', async () => {
    const c = await freshClient()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') return jsonRes(200, { token: 'T-SAME' })
        return jsonRes(403, { code: 'FORBIDDEN', error: '来源不允许' })
      }),
    )
    await c.boot()
    try {
      await c.apiJson('/api/books/书A/state')
      expect.unreachable('应当抛出 ApiError')
    } catch (e) {
      expect(e).toBeInstanceOf(c.ApiError)
      const ae = e as InstanceType<typeof c.ApiError>
      expect(ae.status).toBe(403)
      // 修复点：真实信封 code 原样透出（修复前响应体已废 → 信封解析失败 → 被伪造为
      // LOCAL_API_DOWN + 「本地服务未连接」文案，掩盖服务端真实错误）
      expect(ae.code).toBe('FORBIDDEN')
      expect(ae.message).toBe('来源不允许')
      expect(ae.message).not.toContain('本地服务未连接')
    }
  })

  it('401 + token 变化 → 仍走重放且最终成功（既有行为回归锚）', async () => {
    const c = await freshClient()
    let bootCalls = 0
    let bizCalls = 0
    let issued = 'OLD'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/boot') {
          bootCalls++
          return jsonRes(200, { token: issued })
        }
        bizCalls++
        const t = new Headers(init?.headers).get('x-studio-token')
        if (t !== issued) return jsonRes(401, { code: 'UNAUTHORIZED', error: 'token 失效' })
        return jsonRes(200, { ok: true })
      }),
    )
    await c.boot() // 持有 OLD
    issued = 'NEW' // 模拟 dev:api 重启换 token（OLD 从此失效）
    const data = await c.apiJson<{ ok: boolean }>('/api/books/书A/state')
    expect(data).toEqual({ ok: true }) // re-boot 换新枚后重放成功
    expect(bizCalls).toBe(2) // 失败一次 + 恰一次重放
    expect(bootCalls).toBe(2) // re-boot 取到 NEW
    expect(c.getToken()).toBe('NEW')
  })
})
