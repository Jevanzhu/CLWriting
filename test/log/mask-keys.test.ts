/**
 * R26-95（二十六轮）：maskKeys 直测（掩码是安全语义，锁形貌）。
 * - Bearer 形态：token 部分掩码（Bearer ****末4位）——修复前 m.slice(0,5) 产出
 *   「Beare***」破损外观（前缀被截断、token 一位未掩）；
 * - sk- 形态：保留前 5 字符 + ***（原口径不变）。
 */
import { describe, it, expect } from 'vitest'
import { maskKeys } from '../../src/log/index.js'

describe('R26-95：maskKeys 密钥形态掩码', () => {
  it('Bearer token：保留前缀 + 全掩 + 末 4 位（不再产出 Beare*** 破损外观）', () => {
    const masked = maskKeys('Authorization: Bearer abcd1234efgh5678')
    expect(masked).toBe('Authorization: Bearer ****5678')
    // 完整 token 不泄露
    expect(masked).not.toContain('abcd1234efgh5678')
    expect(masked).not.toContain('abcd1234')
  })

  it('Bearer 后多空白：token 部分照常掩码', () => {
    expect(maskKeys('Bearer   abcdefgh123456')).toBe('Bearer ****3456')
  })

  it('sk- 密钥：保留前 5 字符 + ***（原口径不变，密钥主体不泄露）', () => {
    const masked = maskKeys('连接失败：sk-abcdef1234567890')
    expect(masked).toContain('sk-ab***')
    expect(masked).not.toContain('abcdef1234567890')
  })

  it('一行内多个命中（g 旗标）逐个掩码；无密钥文本原样', () => {
    const both = maskKeys('Bearer aaaa1111bbbb2222 sk-wwwwxxxxyyyy9999')
    expect(both).toContain('Bearer ****2222')
    expect(both).toContain('sk-ww***')
    expect(maskKeys('普通日志文本，没有密钥')).toBe('普通日志文本，没有密钥')
  })

  // ── R31-27（三十一轮）：词表对齐——智谱/Gemini 无前缀形态（此前漏掩） ──
  it('R31-27: 智谱 32hex.32hex 形态掩码', () => {
    const zhipu = `${'a'.repeat(32)}.${'b'.repeat(32)}`
    const out = maskKeys(`SDK 报错 key=${zhipu} 请检查`)
    expect(out).not.toContain(zhipu)
  })

  it('R31-27: Gemini AIza+35 形态掩码', () => {
    const gem = `AIza${'C'.repeat(35)}`
    const out = maskKeys(`Gemini failed with ${gem}`)
    expect(out).not.toContain(gem)
  })

  // ── IR-1（独立重评修复批）：词表真对齐 redactSecret——原 4 形态外 9 类实测穿透 ──
  it('IR-1: 无前缀裸 key 族（xai-/sk_/gsk_/hf_/glpat-/ghp_）逐一掩码', () => {
    const samples = [
      ['xai-', 'x'],
      ['sk_', 's'],
      ['gsk_', 'g'],
      ['hf_', 'h'],
      ['glpat-', 'p'],
      ['ghp_', 'q'],
    ] as const
    for (const [prefix, ch] of samples) {
      const key = `${prefix}${ch.repeat(20)}`
      const out = maskKeys(`SDK error: ${key}`)
      expect(out, prefix).not.toContain(key)
      expect(out, prefix).toContain('***')
    }
  })

  it('IR-1: x-api-key 头掩码（保留头名 + 末 4 位）', () => {
    const out = maskKeys('x-api-key: abcd1234efgh5678')
    expect(out).toBe('x-api-key ****5678')
    expect(out).not.toContain('abcd1234')
  })

  it('IR-1: URL query 凭据掩码（保留参数名，值全掩；长值留末 4 位）', () => {
    const long = maskKeys('GET /v1/messages?api_key=abcd1234efgh5678&x=1')
    expect(long).toContain('api_key=****5678')
    expect(long).not.toContain('abcd1234')
    const short = maskKeys('failed: http://gw.test/chat?key=abc')
    expect(short).toContain('key=****')
    expect(short).not.toBe('failed: http://gw.test/chat?key=abc')
  })

  it('IR-1: Bearer 值含 base64 pad（+/=）不再中途截断漏掩', () => {
    const out = maskKeys('Authorization: Bearer abcd1234+efg/h5678==')
    expect(out).not.toContain('abcd1234')
    expect(out).toContain('Bearer ****')
  })

  it('IR-1: 大小写变体（BEARER / X-API-KEY）同样命中（头/查询族 /gi 对齐）', () => {
    expect(maskKeys('BEARER abcd1234efgh5678')).not.toContain('abcd1234')
    expect(maskKeys('X-API-KEY: abcd1234efgh5678')).not.toContain('abcd1234')
  })
})