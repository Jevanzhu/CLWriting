/**
 * R59 清偿批（R55-F-5）回归：外部 signal abort 落在响应体读取期不伪造 MALFORMED_RESPONSE。
 *
 * 现状：apiJson 内层 catch 把 r.json() 的失败统一当坏体处理——外部 signal 在体读取期
 * abort 时（fetch 头已到、json() 以 AbortError 中途拒绝），r.ok 已为真，AbortError 被
 * 吞掉后误报 MALFORMED_RESPONSE（把调用方主动取消伪造成服务端故障）。修复：内层 catch
 * 判定 abort（联动内部 signal 已中止 / 错误本身是 AbortError）直通原 abort 语义；
 * 超时中止仍优先报 408（R32-25 口径，须先于 abort 判定——超时同样中止内部 signal）。
 * 注：当前全库无调用方传 signal（纯理论面），此守卫保证未来接线取消时不误报。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { apiJson, ApiError } from '../../../src/studio/web-next/src/api/client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 造一个「头已到、体读取可编程」的伪 Response（apiJson 只消费 ok/status/json） */
function fakeResponse(jsonImpl: () => Promise<unknown>): Response {
  return { ok: true, status: 200, json: jsonImpl } as unknown as Response
}

describe('R59 清偿批（R55-F-5）：体读取期 abort 直通取消语义', () => {
  it('外部 signal 在 json() 读取期 abort → 抛 AbortError，不伪造 MALFORMED_RESPONSE', async () => {
    const external = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse(async () => {
          external.abort() // 模拟调用方在体读取期取消（联动内部 signal 同步中止）
          throw new DOMException('This operation was aborted', 'AbortError')
        }),
      ),
    )
    const err = await apiJson('/api/health', { signal: external.signal }).then(
      () => {
        throw new Error('应当拒绝')
      },
      (e: unknown) => e,
    )
    expect((err as Error).name).toBe('AbortError') // 修复点：原 abort 语义直通
    expect(err).not.toBeInstanceOf(ApiError) // 修复前：ApiError MALFORMED_RESPONSE
  })

  it('对照：超时落在体读取期仍报 408 TIMEOUT（R32-25 不回归——超时判定先于 abort 判定）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse(
          () =>
            new Promise((_, rej) => {
              // 模拟 fetch 规范：signal 中止使挂起的体读取以 AbortError 拒绝
              setTimeout(() => rej(new DOMException('This operation was aborted', 'AbortError')), 60)
            }),
        ),
      ),
    )
    await expect(apiJson('/api/health', undefined, 20)).rejects.toMatchObject({
      status: 408,
      code: 'TIMEOUT',
    })
  })

  it('对照：2xx 非 JSON 体（无 abort）→ 仍上抛 MALFORMED_RESPONSE（R51-H-1 不回归）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>proxy error page</html>', { status: 200 })),
    )
    try {
      await apiJson('/api/health')
      expect.unreachable('应当抛出 ApiError')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).code).toBe('MALFORMED_RESPONSE')
    }
  })
})
