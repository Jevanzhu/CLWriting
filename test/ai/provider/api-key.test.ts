/**
 * API Key 合法性单点单测（I6·dsh 口径，2026-08-22）。
 *
 * 覆盖：合法 key + 静默 trim / 空值（调用方配置态）/ 传输不变量外字符（空格、控制符、
 * 非 ASCII、全角符号）/ 含 = 的 ASCII key 不误杀 / 拒绝文案不回显 key 本体。
 * 前端孪生（apiKeyFailure）的对应口径见 test/studio/webnext/provider-format.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { normalizeApiKey, apiKeyRefusal } from '../../../src/ai/provider/api-key.js'

describe('normalizeApiKey（I6·dsh 单点）', () => {
  it('合法 key → ok + trim 后的值（首尾空白只有一种读法，静默修正）', () => {
    expect(normalizeApiKey('sk-abc123')).toEqual({ ok: true, value: 'sk-abc123' })
    expect(normalizeApiKey('  sk-abc123  ')).toEqual({ ok: true, value: 'sk-abc123' })
  })

  it('空/仅空白 → empty（留空是配置态：新增必填/编辑保留由调用方定）', () => {
    expect(normalizeApiKey('')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeApiKey('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('传输不变量外字符 → illegalCharacters（集合外的 key 到不了任何 provider）', () => {
    expect(normalizeApiKey('sk abc')).toEqual({ ok: false, reason: 'illegalCharacters' }) // 空格
    expect(normalizeApiKey('sk\nabc')).toEqual({ ok: false, reason: 'illegalCharacters' }) // 控制符
    expect(normalizeApiKey('sk-密钥')).toEqual({ ok: false, reason: 'illegalCharacters' }) // 非 ASCII
    expect(normalizeApiKey('sk-＝')).toEqual({ ok: false, reason: 'illegalCharacters' }) // 全角等号（误贴环境行常见形）
  })

  it('含 = 的 ASCII key 合法（base64 尾垫 ABCD== 不是赋值，不误杀）', () => {
    expect(normalizeApiKey('ABCD==')).toEqual({ ok: true, value: 'ABCD==' })
    expect(normalizeApiKey('sk-abc=def')).toEqual({ ok: true, value: 'sk-abc=def' })
  })

  it('拒绝文案口径单一且不回显 key 本体（dsh assertUsableApiKey 同则）', () => {
    expect(apiKeyRefusal('empty')).toBe('apiKey 必填')
    const msg = apiKeyRefusal('illegalCharacters')
    expect(msg).toContain('无法传输的字符')
    expect(msg).not.toContain('sk-')
  })
})
