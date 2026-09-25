/**
 * friendlyError（shared/error）友好化映射行为族——按行为合并两散落文件
 * （原 friendly-error + r40-friendly-error，纯函数同装置）。
 *
 * - dv-01：本地 API/网络层的裸「HTTP 5xx」串（dev Vite proxy 未起返回 502 等）不得被
 *   /502/ 误匹配成「AI 服务繁忙」——那是 AI 提供方故障文案，会掩盖「本地服务没起」。
 *   已知 AI 技术错误模式（overloaded / 503 / 502 混在提供方文案里）仍应映射为 AI 文案。
 * - R40-40（四十轮）：子串匹配收窄 + 结构化 ApiError 优先。缺陷：裸子串（/SSE/、/429/、
 *   /502/、/invalid.*key/）把邻近词/数字误归类——「第 429 章不存在」判成「请求过于频繁」、
 *   assess 含 sse 判成「连接中断」、invalid 与 key 相隔任意距离判成「认证失败」。收窄后：
 *   词边界 + HTTP 语境 + 词距限定；真实上游错误形态保持原归类。ApiError 携带机器码时
 *   message 已是服务端人话信封，直接透出不再跑子串猜测（LOCAL_API_DOWN 例外走分类链）。
 *
 * 去重记录：R40-40「真实上游错误保持归类」组中 DeepSeek 502 / fetch failed ECONNREFUSED /
 * 裸 HTTP 502 三例与 dv-01 组逐字重复（同输入同期望），按 dv-01 保留不重复收录。
 */
import { describe, it, expect } from 'vitest'
import { friendlyError } from '../../../src/studio/web-next/src/shared/error'
import { ApiError } from '../../../src/studio/web-next/src/api/client'

const RATE_TIP = '请求过于频繁，请稍后重试'
const NET_TIP = '网络连接失败，请检查网络'
const AUTH_TIP = 'AI 服务认证失败，请检查设置'

// ── dv-01：裸 HTTP 状态 vs AI 服务文案 ────────────────────────

describe('friendlyError · 裸 HTTP 状态 vs AI 服务文案', () => {
  it('裸 HTTP 502 → 中性「请求失败（HTTP 502）」，不再误报 AI 服务繁忙', () => {
    expect(friendlyError(new Error('HTTP 502'))).toBe('请求失败（HTTP 502），请稍后重试')
  })

  it('ApiError 携带裸 HTTP 503 → 同样中性处理', () => {
    expect(friendlyError(new ApiError('HTTP 503', 503))).toBe('请求失败（HTTP 503），请稍后重试')
  })

  it('本地服务未连接新文案（不含 AI 故障字样）→ 原样透出', () => {
    const msg = '本地服务未连接，请确认 API 服务已启动（dev 开发请先运行 npm run dev:api）'
    expect(friendlyError(new Error(msg))).toBe(msg)
  })

  it('AI 提供方 overloaded/503/502 文案 → 仍映射「AI 服务繁忙，请稍后重试」', () => {
    expect(friendlyError(new Error('OpenAI 503: The server is overloaded'))).toBe(
      'AI 服务繁忙，请稍后重试',
    )
    expect(friendlyError(new Error('DeepSeek API 502: upstream error'))).toBe(
      'AI 服务繁忙，请稍后重试',
    )
  })

  it('既有模式不回归：timeout / 429 / 网络 / 未知', () => {
    expect(friendlyError(new Error('request timed out after 60s'))).toBe('请求超时，请重试')
    expect(friendlyError(new Error('OpenAI 429 rate limit exceeded'))).toBe(
      '请求过于频繁，请稍后重试',
    )
    expect(friendlyError(new Error('fetch failed: ECONNREFUSED'))).toBe(NET_TIP)
    expect(friendlyError(new Error('一些未知中文错误'))).toBe('一些未知中文错误')
  })
})

// ── R40-40：邻近误归类修复（不再命中） ────────────────────────

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

// ── R40-40：真实上游错误保持归类 ────────────────────────

describe('R40-40: 真实上游错误保持归类', () => {
  it('OpenAI 429 限频文案 → 请求过于频繁', () => {
    expect(friendlyError(new Error('OpenAI API 429: rate limit exceeded'))).toBe(RATE_TIP)
  })

  it('invalid api key → 认证失败', () => {
    expect(friendlyError(new Error('invalid api key'))).toBe(AUTH_TIP)
  })
})

// ── R40-40：结构化 ApiError 优先 ────────────────────────

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
