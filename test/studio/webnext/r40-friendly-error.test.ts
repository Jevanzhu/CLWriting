/**
 * R40-40（四十轮）回归：friendlyError 子串匹配收窄 + 结构化 ApiError 优先。
 *
 * 缺陷：裸子串（/SSE/、/429/、/502/、/invalid.*key/）把邻近词/数字误归类——
 * 「第 429 章不存在」判成「请求过于频繁」、assess 含 sse 判成「连接中断」、
 * invalid 与 key 相隔任意距离判成「认证失败」。收窄后：词边界 + HTTP 语境 +
 * 词距限定；真实上游错误形态保持原归类。ApiError 携带机器码时 message 已是
 * 服务端人话信封，直接透出不再跑子串猜测（LOCAL_API_DOWN 例外走分类链）。
 */
import { describe, it, expect } from 'vitest'
import { friendlyError } from '../../../src/studio/web-next/src/shared/error'
import { ApiError } from '../../../src/studio/web-next/src/api/client'

const RATE_TIP = '请求过于频繁，请稍后重试'
const NET_TIP = '网络连接失败，请检查网络'
const AUTH_TIP = 'AI 服务认证失败，请检查设置'

describe('R40-40: 邻近误归类修复（不再命中）', () => {
  it('「第 429 章不存在」→ 原样透出（数字无 HTTP 语境不再判频率限制）', () => {
    expect(friendlyError(new Error('第 429 章不存在'))).toBe('第 429 章不存在')
  })

  it('「请重新 assess 该章」→ 原样透出（assess 含 sse 不再判连接中断）', () => {
    expect(friendlyError(new Error('请重新 assess 该章'))).not.toBe('连接中断，请重试')
  })

  it('「password 无效」→ 原样透出（invalid 与 key 相距过远不再判认证失败）', () => {
    const msg = 'invalid value for field: password（缺少 key）'
    expect(friendlyError(new Error(msg))).toBe(msg)
  })
})

describe('R40-40: 真实上游错误保持归类', () => {
  it('OpenAI 429 限频文案 → 请求过于频繁', () => {
    expect(friendlyError(new Error('OpenAI API 429: rate limit exceeded'))).toBe(RATE_TIP)
  })

  it('DeepSeek 502 上游错误 → AI 服务繁忙', () => {
    expect(friendlyError(new Error('DeepSeek API 502: upstream error'))).toBe('AI 服务繁忙，请稍后重试')
  })

  it('fetch failed ECONNREFUSED → 网络连接失败', () => {
    expect(friendlyError(new Error('fetch failed: ECONNREFUSED'))).toBe(NET_TIP)
  })

  it('invalid api key → 认证失败', () => {
    expect(friendlyError(new Error('invalid api key'))).toBe(AUTH_TIP)
  })

  it('裸 HTTP 502（dv-01 回归锚）→ 仍走中性文案不判 AI 繁忙', () => {
    expect(friendlyError(new Error('HTTP 502'))).toBe('请求失败（HTTP 502），请稍后重试')
  })
})

describe('R40-40: 结构化 ApiError 优先', () => {
  it('携带机器码的服务端信封 → message 直接透出（不跑子串猜测）', () => {
    // 信封文案含「429」数字——旧子串链会误判频率限制，掩盖真实校验原因
    const e = new ApiError('第 429 章不存在，无法保存', 400, 'DOC_NOT_FOUND')
    expect(friendlyError(e)).toBe('第 429 章不存在，无法保存')
    expect(friendlyError(e)).not.toBe(RATE_TIP)
  })

  it('LOCAL_API_DOWN（无码形态）→ 保留分类链（透出本地服务指引）', () => {
    const msg = '本地服务未连接，请确认 API 服务已启动（dev 开发请先运行 npm run dev:api）'
    expect(friendlyError(new ApiError(msg, 0, 'LOCAL_API_DOWN'))).toBe(msg)
  })
})
