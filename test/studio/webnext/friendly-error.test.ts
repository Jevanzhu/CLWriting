/**
 * friendlyError（shared/error）友好化映射回归。
 *
 * dv-01：本地 API/网络层的裸「HTTP 5xx」串（dev Vite proxy 未起返回 502 等）不得被
 * /502/ 误匹配成「AI 服务繁忙」——那是 AI 提供方故障文案，会掩盖「本地服务没起」。
 * 已知 AI 技术错误模式（overloaded / 503 / 502 混在提供方文案里）仍应映射为 AI 文案。
 */
import { describe, it, expect } from 'vitest'
import { friendlyError } from '../../../src/studio/web-next/src/shared/error'
import { ApiError } from '../../../src/studio/web-next/src/api/client'

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
    expect(friendlyError(new Error('fetch failed: ECONNREFUSED'))).toBe(
      '网络连接失败，请检查网络',
    )
    expect(friendlyError(new Error('一些未知中文错误'))).toBe('一些未知中文错误')
  })
})