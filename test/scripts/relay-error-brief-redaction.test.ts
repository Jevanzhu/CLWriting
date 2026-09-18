/**
 * 0918三轮修复批（D202）回归：verify-responses-relay 错误摘要出口脱敏。
 *
 * 修复前 errBrief 直出 message（仅截断不脱敏）——中转网关 4xx 报错常回显请求 URL
 * （部分网关把 key 放 query param，src/log/redact.ts 自述泄漏形态，恰是本脚本要测的
 * 中转网关），完整凭据可打到终端/CI 日志，与脚本头注「输出永不回显完整 key」承诺
 * 相悖。修复后 message 出口统一过 redactSecret 再截断。
 * 抽离缘由：verify-responses-relay.ts 顶层即执行不可被测试安全 import——
 * errBrief/trunc/ErrInfo 单源至 scripts/relay-error-brief.ts 供直测。
 * 锚：0918三轮修复批 D202。
 */
import { describe, expect, it } from 'vitest'
import { errBrief, trunc, type ErrInfo } from '../../scripts/relay-error-brief.js'

describe('D202（0918三轮修复批）：errBrief 脱敏出口', () => {
  it('message 内 query param key → ***REDACTED***（修复前原文直出）', () => {
    const e: ErrInfo = {
      message: '请求失败：https://gw.example.com/v1/chat?key=gsk_real_secret_key_000111222333',
      retryable: false,
      status: 401,
    }
    const brief = errBrief(e)
    expect(brief).not.toContain('gsk_real_secret_key_000111222333')
    expect(brief).toContain('key=***REDACTED***')
    expect(brief).toContain('HTTP 401') // 无 code 时回退 HTTP status
  })

  it('裸 sk- key 与 Bearer 头原文同样被掩；head 优先 code；retryable 渲染', () => {
    const brief = errBrief({
      message: 'Bearer abc123def456 和 sk-ant-key123456789012345678 均不回显',
      retryable: true,
      code: 'E_RELAY',
    })
    expect(brief).not.toContain('abc123def456')
    expect(brief).not.toContain('sk-ant-key123456789012345678')
    expect(brief).toContain('Bearer ***REDACTED***')
    expect(brief.startsWith('[E_RELAY] ')).toBe(true)
    expect(brief.endsWith('（retryable=true）')).toBe(true)
  })

  it('无 code 无 status 兜底 ERROR；超长 message 脱敏后截断 120 字加省略号', () => {
    expect(errBrief({ message: '炸了', retryable: false }).startsWith('[ERROR] ')).toBe(true)
    const brief = errBrief({ message: 'x'.repeat(300), retryable: false })
    const body = brief.slice('[ERROR] '.length, -'（retryable=false）'.length)
    expect(body.endsWith('…')).toBe(true)
    expect(body.length).toBe(121) // 120 + 省略号
  })

  it('trunc：压缩空白 + 超长截断（自 relay 脚本随迁语义）', () => {
    expect(trunc('a\n\n  b', 10)).toBe('a b')
    expect(trunc('x'.repeat(15), 10)).toBe('xxxxxxxxxx…')
  })
})
