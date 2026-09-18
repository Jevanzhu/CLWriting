/**
 * verify-responses-relay 的错误摘要单行出口（D202，0918三轮修复批）。
 *
 * 抽离因由：verify-responses-relay.ts 顶层即执行（缺参打印用法即退），不可被测试
 * 安全 import——errBrief/ErrInfo/trunc 抽本零副作用模块供直测。D202 本体：网关 4xx
 * 报错 message 常回显请求 URL，部分网关把 key 放 query param（src/log/redact.ts
 * 自述泄漏形态，恰是本脚本要测的中转网关），原 errBrief 直出 message（仅截断不脱敏）
 * 可把完整凭据打到终端（可能进 CI 日志/截图），与脚本头注「输出永不回显完整 key」
 * 承诺相悖——message 出口统一过 redactSecret 后再截断。
 */
import { redactSecret } from '../src/log/redact.js'

export interface ErrInfo {
  message: string
  retryable: boolean
  code?: string
  status?: number
}

/** 压缩空白 + 超长截断（自 verify-responses-relay.ts 随迁，语义零变化）。 */
export function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

/** 错误单行摘要：优先 code，其次 HTTP status，兜底 ERROR；message 过脱敏再截断。 */
export function errBrief(e: ErrInfo): string {
  const head = e.code ?? (e.status !== undefined ? `HTTP ${e.status}` : 'ERROR')
  return `[${head}] ${trunc(redactSecret(e.message), 120)}（retryable=${e.retryable}）`
}
