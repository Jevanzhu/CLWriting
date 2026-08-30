/**
 * E-2（第五十三轮）回归：apiFetch 的 boot 恢复通道。
 *
 * boot 一次性取 token 失败（API 慢就绪超 ~21s）后 token 永久 null，写请求持续
 * 401/403 只能刷新页面——修复后 apiFetch 在 401/403 且 token null 时触发一次防抖
 * 去重的 re-boot，成功则重放原请求（单请求最多一次），失败原样透传。
 *
 * token 为 client 模块级变量：每例 vi.resetModules + 动态 import 取干净实例。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

const BOOT_ATTEMPTS = 4 // 首次 + 3 重试

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
  // R64-43（十二轮）：退避注入——真实退避 300+600+1200ms × 5 用例 ≈10s 纯墙钟等待。
  // 换 no-op sleep（不 stubGlobal setTimeout，避免伤及 AbortController 计时）。
  c.__testHooks.sleep = async () => {}
  return c
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('E-2 · apiFetch 401/403 恢复通道', () => {
  it('boot 失败 token null → 写请求 401 触发 re-boot 成功 → 重放原请求并带新 token', async () => {
    const c = await freshClient()
    let bootOk = false
    let bootCalls = 0
    const pathCalls: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/boot') {
          bootCalls++
          if (!bootOk) return jsonRes(503)
          return jsonRes(200, { token: 'T1' })
        }
        pathCalls.push(new Headers(init?.headers).get('x-studio-token') ?? null)
        if (pathCalls.length === 1) return jsonRes(401, { error: '未授权' })
        return jsonRes(200, { ok: true })
      }),
    )
    // 先让 boot 全部尝试失败（退避 300+600+1200ms 真实等待）
    await c.boot()
    expect(bootCalls).toBe(BOOT_ATTEMPTS)

    bootOk = true // API 慢就绪：此后 boot 可成功
    const r = await c.apiFetch('/api/books/x/heartbeat', { method: 'POST' })
    expect(r.status).toBe(200)
    expect(bootCalls).toBe(BOOT_ATTEMPTS + 1) // 恰好一次 re-boot
    expect(pathCalls).toEqual([null, 'T1']) // 首次无 token → 重放带新 token
  })

  it('re-boot 仍失败 → 不重放，原样透传 401（不无限空转）', async () => {
    const c = await freshClient()
    let bootCalls = 0
    let pathCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/boot') {
          bootCalls++
          return jsonRes(503)
        }
        pathCalls++
        return jsonRes(401, { error: '未授权' })
      }),
    )
    await c.boot()
    const before = bootCalls
    const r = await c.apiFetch('/api/books/x/heartbeat', { method: 'DELETE' })
    expect(r.status).toBe(401)
    expect(pathCalls).toBe(1) // 未重放
    expect(bootCalls).toBe(before + BOOT_ATTEMPTS) // 只多了一轮 re-boot 尝试
  })

  it('重试后仍 401 → 单请求最多重试一次，防死循环', async () => {
    const c = await freshClient()
    let bootCalls = 0
    let pathCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/boot') {
          bootCalls++
          return bootCalls > BOOT_ATTEMPTS
            ? jsonRes(200, { token: 'T2' })
            : jsonRes(503)
        }
        pathCalls++
        return jsonRes(403, { error: 'token 无效' }) // 拿到 token 也始终 403
      }),
    )
    await c.boot()
    const r = await c.apiFetch('/api/books/x/heartbeat', { method: 'POST' })
    expect(r.status).toBe(403)
    expect(pathCalls).toBe(2) // 原请求 + 恰一次重试
    expect(bootCalls).toBe(BOOT_ATTEMPTS + 1) // re-boot 首次尝试即拿到 token
  })

  it('并发多个 401 请求 → re-boot 防抖去重只触发一次', async () => {
    const c = await freshClient()
    let rebootCalls = 0
    let pathCalls = 0
    let releaseBoot: ((v: void) => void) | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/boot') {
          rebootCalls++
          if (rebootCalls <= BOOT_ATTEMPTS) return jsonRes(503)
          // re-boot 悬挂：确认并发请求在等同一个 promise
          await new Promise<void>((r) => (releaseBoot = r))
          return jsonRes(200, { token: 'T3' })
        }
        pathCalls++
        return pathCalls <= 3 ? jsonRes(401, { error: '未授权' }) : jsonRes(200, { ok: 1 })
      }),
    )
    await c.boot()
    const reqs = [1, 2, 3].map(() => c.apiFetch('/api/prefs/b', { method: 'PUT', body: '{}' }))
    await new Promise((r) => setTimeout(r, 10)) // 让三个请求都打到 401 分支并挂起等 re-boot
    releaseBoot!()
    const rs = await Promise.all(reqs)
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200])
    expect(rebootCalls).toBe(BOOT_ATTEMPTS + 1) // 三个并发只触发一次 re-boot
    expect(pathCalls).toBe(6) // 各重放一次
  })

  it('Y-30：token 已存在 401 → re-boot 一次；拿回同一枚（未变）→ 不重放原样返回', async () => {
    const c = await freshClient()
    let bootCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') {
          bootCalls++
          return jsonRes(200, { token: 'T4' })
        }
        return jsonRes(401, { error: 'token 被吊销' })
      }),
    )
    await c.boot()
    expect(bootCalls).toBe(1)
    const r = await c.apiFetch('/api/books/x/heartbeat', { method: 'POST' })
    expect(r.status).toBe(401)
    // Y-30（第五十七轮）：401 一律走一次防抖 re-boot（旧口径「有 token 不触发」废止——
    // dev 重启换 token 的失效形态靠此通道恢复）；本例 re-boot 拿回同一枚 T4（401 另有
    // 原因）→ token 未变不重放，原样透传不空转
    expect(bootCalls).toBe(2)
  })

  it('R26-81/R28-4：仅确定重放时 cancel 首响应体；不重放路径响应体完整留给调用方', async () => {
    // 场景 A：re-boot 拿回新枚 → 确定重放 → 旧响应体不再需要，重放前 cancel 一次
    const c = await freshClient()
    const cancel = vi.fn(() => Promise.resolve())
    let bootCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') {
          bootCalls++
          return jsonRes(200, { token: `T${bootCalls}` }) // 每次发新枚 → token 必变
        }
        // 受控 body 桩：观测 cancel 是否被调（真实 Response 体在 Node 侧不可注入 spy）
        return { status: 401, ok: false, body: { cancel } } as unknown as Response
      }),
    )
    await c.boot()
    await c.apiFetch('/api/books/x/heartbeat', { method: 'POST' })
    expect(cancel).toHaveBeenCalledTimes(1) // 重放分支：未读旧流释放，不占连接池

    // 场景 B：token 未变 → 不重放 → 不 cancel——响应体须完整返回调用方
    // （R28-4：原先无条件 cancel 把信封作废，apiJson 误判「本地服务未连接」）
    const c2 = await freshClient()
    const cancel2 = vi.fn(() => Promise.resolve())
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') return jsonRes(200, { token: 'T9' })
        return { status: 401, ok: false, body: { cancel: cancel2 } } as unknown as Response
      }),
    )
    await c2.boot()
    const r2 = await c2.apiFetch('/api/books/x/heartbeat', { method: 'POST' })
    expect(cancel2).not.toHaveBeenCalled() // 不重放：调用方仍要读信封
    expect(r2.status).toBe(401) // token 未变（T9 同枚）→ 不重放，原样透传
  })
})
