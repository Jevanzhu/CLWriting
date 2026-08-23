/**
 * Y-30（第五十七轮）回归——token 非空但失效（dev 重启换 token）的恢复通道。
 *
 * 缺陷：401/403 只在 token === null 时触发 re-boot——dev 重启 dev:api 后服务端换
 * randomUUID，页面持有的旧 token 永久失效且不置 null，所有请求持续 401/403 直至
 * 手动刷新。修复：401/403 一律走防抖 re-boot，**token 变化才重放**（拿回同一枚
 * 说明 401/403 另有原因，透传不空转）。生产 Electron 靠持久化 token 规避（低危定级
 * 依据），本回归锁 dev 形态。
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

describe('Y-30: token 失效（非空）恢复通道', () => {
  it('旧 token 401 → re-boot 换新 token → 重放成功（共两次业务请求）', async () => {
    const c = await freshClient()
    let bootCount = 0
    let bizCount = 0
    // 「已持有旧 token」形态：boot 先发 T1，之后 tokenIssued 翻 NEW 模拟 dev:api 重启
    let tokenIssued = 'T1'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/boot') {
          bootCount++
          return jsonRes(200, { token: tokenIssued })
        }
        bizCount++
        const t = new Headers(init?.headers).get('x-studio-token')
        if (t !== tokenIssued) return jsonRes(401, { error: 'token 无效', code: 'FORBIDDEN' })
        return jsonRes(200, { ok: true })
      }),
    )
    await c.boot() // 持有 T1
    tokenIssued = 'NEW' // 模拟 dev:api 重启换 token（T1 从此失效）
    const r = await c.apiFetch('/api/books/书A/state')
    expect(r.status).toBe(200) // 修复前：T1 非空不走恢复通道 → 直接透传 401
    expect(bizCount).toBe(2) // 失败一次 + 重放一次
    expect(bootCount).toBe(2) // re-boot 取到 NEW
    expect(c.getToken()).toBe('NEW')
  })

  it('re-boot 拿回同一枚 token（401 另有原因）→ 不重放，透传 401', async () => {
    const c = await freshClient()
    let bizCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') return jsonRes(200, { token: 'SAME' })
        bizCount++
        return jsonRes(403, { error: '来源不允许', code: 'FORBIDDEN' })
      }),
    )
    await c.boot()
    const r = await c.apiFetch('/api/books/书A/state')
    expect(r.status).toBe(403)
    expect(bizCount).toBe(1) // 不空转重放
  })
})
