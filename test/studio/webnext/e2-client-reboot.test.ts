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
  return import('../../../src/studio/web-next/src/api/client')
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
})
