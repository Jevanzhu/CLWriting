import { apiJson } from './client'
import { bookUrl } from './url'

// 机检报告类型单源 = src/shared/contract/check.ts（服务端端点同类型注解）。
import type { CheckResult } from '../../../../shared/contract/check'
export type { CheckItem, CheckLevel, CheckReport, CheckResult } from '../../../../shared/contract/check'

// POST /documents/:docId/check —— 本地机检（无 AI、断网可用；M12 块3 B3.1）。
// 即算即显，不落信封；返回 CheckReport + hasRed 汇总。
export async function runCheck(name: string, docId: string): Promise<CheckResult> {
  return apiJson<CheckResult>(
    bookUrl(name, 'documents', docId, 'check'),
    {
      method: 'POST',
      json: {},
    },
    // 本地机检但超大章节可能慢；无超时则 loading 永转
    60_000,
  )
}

/** 标记误报——excerpt 服务端从正文切（±50 字、上限 200），落
 *  check/false-positive 事件（语料回归库燃料入口）；幂等（同章同 checkId 最近一次为准） */
export async function markFalsePositive(
  name: string,
  docId: string,
  checkId: string,
): Promise<{ ok: true; checkId: string; chapter: number; excerpt: string }> {
  return apiJson(
    bookUrl(name, 'documents', docId, 'check-false-positive'),
    {
      method: 'POST',
      json: { checkId },
    },
    60_000,
  )
}
