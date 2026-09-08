/**
 * 重审-15（2026-09-07 全量代码重审 §四.15）回归：apiJson 对「重放仍 401/403」的
 * 统一友好文案。
 *
 * 缺陷：401/403 → rebootstrap 换新 token → **重放仍 401/403** 时，apiJson 原样透传
 * 服务端原始错误串（「token 无效」等工程口径），boot 重试与重放双失败后各调用方凭
 * friendlyError 分散兜底、文案不一。修复：重放后仍 401/403 → message 换统一友好文案；
 * status/code 原样保留（上游 instanceof/status 分支与 dev 诊断依赖）。不重放路径
 * （token 未变/为 null——Origin/权限类）行为不变：信封原样透传（r28-client-cancel 已锁）。
 *
 * token 为 client 模块级变量：每例 vi.resetModules + 动态 import 取干净实例
 * （同 e2-client-reboot）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

const AUTH_BROKEN_MSG = '本地服务连接异常（登录态失效），请刷新页面或重启应用'

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
  // R64-43：退避注入点换 no-op sleep——boot 若走重试不垫真实墙钟等待
  c.__testHooks.sleep = async () => {}
  return c
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('重审-15 · 重放仍 401/403 统一友好文案（status/code 保留）', () => {
  it('重放（re-boot 换新 token）仍 401 → message 换统一文案，status/code 原样保留', async () => {
    const c = await freshClient()
    let bootCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') {
          bootCalls++
          // 首次 boot 发 OLD，re-boot 换 NEW（token 变化才重放）
          return jsonRes(200, { token: bootCalls === 1 ? 'OLD' : 'NEW' })
        }
        return jsonRes(401, { code: 'UNAUTHORIZED', error: 'token 无效' })
      }),
    )
    await c.boot() // 持有 OLD
    await expect(c.apiJson('/api/books/书A/state')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: AUTH_BROKEN_MSG,
    })
    expect(bootCalls).toBe(2) // 确认真实走了重放通道（re-boot 换新枚后才有的形态）
  })

  it('重放仍 403 → 同口径（403 形态）', async () => {
    const c = await freshClient()
    let bootCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') {
          bootCalls++
          return jsonRes(200, { token: bootCalls === 1 ? 'OLD' : 'NEW' })
        }
        return jsonRes(403, { code: 'FORBIDDEN', error: '来源不允许' })
      }),
    )
    await c.boot()
    await expect(c.apiJson('/api/x')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: AUTH_BROKEN_MSG,
    })
  })

  it('无信封形态（重放 401 空体）→ code LOCAL_API_DOWN + 统一文案；friendlyError 直出该文案', async () => {
    vi.resetModules()
    const c = await import('../../../src/studio/web-next/src/api/client')
    c.__testHooks.sleep = async () => {}
    // friendlyError 与 client 须同一 reset 周期实例（error.ts 按 instanceof 识别 ApiError）
    const { friendlyError } = await import('../../../src/studio/web-next/src/shared/error')
    let bootCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') {
          bootCalls++
          return jsonRes(200, { token: bootCalls === 1 ? 'OLD' : 'NEW' })
        }
        return new Response('', { status: 401 })
      }),
    )
    await c.boot()
    let caught: unknown
    await c.apiJson('/api/x').catch((e: unknown) => {
      caught = e
    })
    const ae = caught as InstanceType<typeof c.ApiError>
    expect(ae).toBeInstanceOf(c.ApiError)
    expect(ae.status).toBe(401)
    expect(ae.code).toBe('LOCAL_API_DOWN')
    expect(ae.message).toBe(AUTH_BROKEN_MSG)
    // 无信封形态走 friendlyError 分类链：统一文案不命中任何 TECH_PATTERNS → 原样透出
    expect(friendlyError(caught)).toBe(AUTH_BROKEN_MSG)
  })

  it('有信封形态 → friendlyError 结构化优先直出 message（= 统一文案，不落子串猜测）', async () => {
    vi.resetModules()
    const c = await import('../../../src/studio/web-next/src/api/client')
    c.__testHooks.sleep = async () => {}
    const { friendlyError } = await import('../../../src/studio/web-next/src/shared/error')
    let bootCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') {
          bootCalls++
          return jsonRes(200, { token: bootCalls === 1 ? 'OLD' : 'NEW' })
        }
        return jsonRes(401, { code: 'UNAUTHORIZED', error: 'token 无效' })
      }),
    )
    await c.boot()
    let caught: unknown
    await c.apiJson('/api/x').catch((e: unknown) => {
      caught = e
    })
    expect(friendlyError(caught)).toBe(AUTH_BROKEN_MSG)
  })

  it('对照：不重放（re-boot 拿回同一枚 token）→ 信封原样透传，message 不换（r28 已锁行为的本域锚）', async () => {
    const c = await freshClient()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/boot') return jsonRes(200, { token: 'SAME' })
        return jsonRes(403, { code: 'FORBIDDEN', error: '来源不允许' })
      }),
    )
    await c.boot()
    await expect(c.apiJson('/api/x')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: '来源不允许',
    })
  })
})
