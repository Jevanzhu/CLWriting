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
})
