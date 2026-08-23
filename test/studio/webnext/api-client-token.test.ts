/**
 * 鉴权契约①回归：GET /api/* 同样注入 x-studio-token（原先仅写方法注入）。
 *
 * 服务端将要求所有 /api/* 请求带 x-studio-token 头（/api/boot 自身免鉴权返回 token）。
 * 覆盖：GET/POST/PATCH/DELETE 注入、/api/boot 豁免、非 /api 路径不注入、
 * GET 的 401 → re-boot 重取重放（恢复通道对 GET 同样生效）。
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
  return import('../../../src/studio/web-next/src/api/client')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('契约① · /api/* 请求 token 注入', () => {
  it('boot 成功后 GET /api/* 请求带 x-studio-token 头（修复前 GET 不带）', async () => {
    const c = await freshClient()
    const seen: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/boot') return jsonRes(200, { token: 'T1' })
        seen.push(new Headers(init?.headers).get('x-studio-token') ?? null)
        return jsonRes(200, { ok: true })
      }),
    )
    await c.boot()
    await c.apiFetch('/api/books/书A/state') // GET（缺省 method）
    await c.apiFetch('/api/prefs/b', { method: 'GET' }) // 显式 GET
    expect(seen).toEqual(['T1', 'T1'])
  })

  it('POST / PATCH / DELETE 照旧注入（回归不回退）', async () => {
    const c = await freshClient()
    const seen: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/boot') return jsonRes(200, { token: 'T1' })
        seen.push(new Headers(init?.headers).get('x-studio-token') ?? null)
        return jsonRes(200, { ok: true })
      }),
    )
    await c.boot()
    await c.apiFetch('/api/books/书A/chat', { method: 'POST', body: '{}' })
    await c.apiFetch('/api/documents/x', { method: 'PATCH', body: '{}' })
    await c.apiFetch('/api/documents/x', { method: 'DELETE' })
    expect(seen).toEqual(['T1', 'T1', 'T1'])
  })

  it('/api/boot 自身免鉴权：不注入 token（它是取 token 的端点）', async () => {
    const c = await freshClient()
    const bootHeaders: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/boot') {
          bootHeaders.push(new Headers(init?.headers).get('x-studio-token') ?? null)
          return jsonRes(200, { token: 'T1' })
        }
        return jsonRes(200, { ok: true })
      }),
    )
    await c.boot()
    // 二次手动调 boot 同样不得带 token（boot 端点鉴权后若误带头会形成鸡生蛋死锁）
    await c.boot()
    expect(bootHeaders).toEqual([null, null])
  })

  it('非 /api/* 路径不注入（静态资源等与鉴权无关的请求）', async () => {
    const c = await freshClient()
    const seen: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/boot') return jsonRes(200, { token: 'T1' })
        seen.push(new Headers(init?.headers).get('x-studio-token') ?? null)
        return jsonRes(200, { ok: true })
      }),
    )
    await c.boot()
    await c.apiFetch('/assets/some.css')
    expect(seen).toEqual([null])
  })

  it('boot 未成功（token null）→ GET 401 触发 re-boot 成功后重放原 GET 并带新 token', async () => {
    const c = await freshClient()
    let bootOk = false
    const pathHeaders: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/boot') {
          if (!bootOk) return jsonRes(503)
          return jsonRes(200, { token: 'T2' })
        }
        pathHeaders.push(new Headers(init?.headers).get('x-studio-token') ?? null)
        if (pathHeaders.length === 1) return jsonRes(401, { error: '未授权' })
        return jsonRes(200, { ok: true })
      }),
    )
    await c.boot() // 全部尝试失败（真实退避等待），token 留 null
    bootOk = true
    const r = await c.apiFetch('/api/books/书A/tree') // GET 请求
    expect(r.status).toBe(200)
    expect(pathHeaders).toEqual([null, 'T2']) // 首次无 token 401 → re-boot 后重放带新 token
  })

  it('GET 重试后仍 401 → 单请求最多重试一次（防死循环口径对 GET 同样生效）', async () => {
    const c = await freshClient()
    let bootCalls = 0
    let pathCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') {
          bootCalls++
          return bootCalls > 4 ? jsonRes(200, { token: 'T3' }) : jsonRes(503)
        }
        pathCalls++
        return jsonRes(401, { error: 'token 无效' })
      }),
    )
    await c.boot()
    const r = await c.apiFetch('/api/books/书A/state')
    expect(r.status).toBe(401)
    expect(pathCalls).toBe(2) // 原请求 + 恰一次重试
  })
})
