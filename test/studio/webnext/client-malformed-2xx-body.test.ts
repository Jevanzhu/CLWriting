/**
 * R51-H-1（五十一轮）回归：apiJson 对「2xx + 非 JSON 体」上抛 MALFORMED_RESPONSE。
 *
 * 原实现静默回 {}——getContent 得 content:undefined、sha256Revision('undefined') 成
 * 错误基线，首存必吃 REVISION_CONFLICT（编辑永不静默丢失红线的边角缺口）。本 API 面
 * 服务端统一 JSON 信封、无 200-无体端点；仅 204/304 维持空对象口径，非 2xx 非 JSON
 * 仍走 LOCAL_API_DOWN（dv-01 不回归）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { apiJson, ApiError } from '../../../src/studio/web-next/src/api/client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('R51-H-1: 2xx + 非 JSON 体 → MALFORMED_RESPONSE', () => {
  it('200 裸 HTML 体 → ApiError MALFORMED_RESPONSE（原静默 {}——回归红）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>proxy error page</html>', { status: 200 })),
    )
    try {
      await apiJson('/api/books/书A/documents/content')
      expect.unreachable('应当抛出 ApiError')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      const ae = e as ApiError
      expect(ae.code).toBe('MALFORMED_RESPONSE')
      expect(ae.status).toBe(200)
    }
  })

  it('204 无体 → 维持空对象口径（HTTP 无体语义合法）', async () => {
    // 204 语义上不允许 body——Response 构造器对非 null body 直接抛错，用 null
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    )
    const body = await apiJson('/api/some-endpoint')
    expect(body).toEqual({})
  })

  it('对照：502 空体仍走 LOCAL_API_DOWN（dv-01 不回归）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 502 })),
    )
    try {
      await apiJson('/api/health')
      expect.unreachable('应当抛出 ApiError')
    } catch (e) {
      const ae = e as ApiError
      expect(ae.code).toBe('LOCAL_API_DOWN')
    }
  })
})

// 0918二轮修复批（E102）：2xx + 裸字面量坏体（合法 JSON 但非对象）——原守卫只锚
// null（重评二轮-P3-3 最小修复），true/数字/字符串穿透信封判型直达调用方按对象消费
//（信封字段对一切非对象静默 undefined，与 null 失效同族）。全量 apiJson 调用方复核
// 无合法返回 string/number/boolean 的端点，守卫扩到一切非对象形态。
describe('E102: 2xx + 裸字面量（true/数字/字符串）→ MALFORMED_RESPONSE', () => {
  it.each(['"ok"', '5', 'true'])('200 体 %s → 抛 ApiError MALFORMED_RESPONSE（修复前穿透）', async (raw) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(raw, { status: 200 })),
    )
    try {
      await apiJson('/api/books/书A/documents/content')
      expect.unreachable('应当抛出 ApiError')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      const ae = e as ApiError
      expect(ae.code).toBe('MALFORMED_RESPONSE')
      expect(ae.status).toBe(200)
    }
  })

  it('对照：正常对象信封不受影响', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, revision: 'sha256:x' }), { status: 200 })),
    )
    const body = await apiJson<{ ok: boolean; revision: string }>('/api/books/书A/documents/d1/content')
    expect(body).toEqual({ ok: true, revision: 'sha256:x' })
  })

  it('对照：数组体照常放行（typeof 数组为 object，Foreshadow[] 等端点不误伤）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([{ id: 'f1' }]), { status: 200 })),
    )
    const body = await apiJson<{ id: string }[]>('/api/books/书A/foreshadows')
    expect(body).toEqual([{ id: 'f1' }])
  })
})
