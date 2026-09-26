/**
 * R59 清偿批（R55-A-4）回归：maskKeys 的 URL 值类排除 `\"` 转义引号，JSONL 行不破。
 *
 * 缺陷：日志掩码在 JSON.stringify 之后的单行 JSON 上执行（emit），URL 值类
 * `[^&\s#]+` 不排除 `"`/`\`——msg 值内形如 `api_key=abc"def` 的引号经序列化成
 * `\"`，值类照单全收后匹配越过 JSON 字符串边界，把行尾 `\"}` 等结构字符一并替换，
 * 单行 JSONL 不可解析（诊断日志整行报废）。修复：值类改 `[^\s&#\\"]+`，最长匹配
 * 止于转义序列，行结构恒完整；URL 裸值不含此两字符，常态掩码口径（长值留末 4 位）
 * 不变。过掩方向可接受（仅诊断日志面）。
 */
import { describe, it, expect } from 'vitest'
import { maskKeys } from '../../src/log/index.js'

/** 按 emit 的真实次序构造被掩对象：先 JSON.stringify 成单行，再过 maskKeys */
function maskJsonLine(msg: string): string {
  return maskKeys(
    JSON.stringify({ ts: '2026-09-07T00:00:00.000Z', level: 'info', tag: 'server', msg }),
  )
}

describe('R59 清偿批（R55-A-4）: maskKeys 值类排除转义引号，JSONL 行保持可解析', () => {
  it('报告形态：URL 值含引号（序列化成 \\"）且后随其他 query 参数——行仍可 JSON.parse，凭据已掩', () => {
    // 修复前红证：掩码保留末 4 位把裸 `"` 带回 JSON 字符串行内（SyntaxError）
    const masked = maskJsonLine('GET http://gw.test/v1?api_key=abc"def&x=1')
    expect(() => JSON.parse(masked)).not.toThrow()
    expect(masked).toContain('api_key=****') // 掩码语义仍在（保留参数名，值全掩）
    const parsed = JSON.parse(masked) as { msg: string }
    expect(parsed.msg).not.toContain('abc"def') // 原始值不回显
  })

  it('URL 值含引号且位于 msg 末尾：行可解析且值不回显（转义序列止住越界匹配）', () => {
    const masked = maskJsonLine('GET http://gw.test/v1?api_key=abc"def')
    expect(() => JSON.parse(masked)).not.toThrow()
    expect(masked).toContain('api_key=****')
  })

  it('常态口径不回归：无引号长值照旧掩码（长值留末 4 位），行可解析', () => {
    const masked = maskJsonLine('GET http://gw.test/v1?api_key=abcdefghijklmnop&x=1')
    expect(() => JSON.parse(masked)).not.toThrow()
    expect(masked).toContain('api_key=****mnop') // 长 ≥8 保留末 4 位（R26-95 契约）
  })
})
