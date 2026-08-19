import { apiJson } from './client'

// 机检报告类型（镜像后端 src/check/types.ts 精简；web-next 独立构建不跨包 import）。
export type CheckLevel = 'red' | 'yellow'
export interface CheckItem {
  checkId: string
  level: CheckLevel
  message: string
  leadId?: string
  chapter?: number
}
export interface CheckSection {
  name: string
  items: CheckItem[]
}
export interface CheckReport {
  sections: CheckSection[]
  byproducts?: Record<string, unknown>
}
export interface CheckResult {
  ok: true
  report: CheckReport
  hasRed: boolean
}

// POST /documents/:docId/check —— 本地机检（无 AI、断网可用；M12 块3 B3.1）。
// 即算即显，不落信封；返回 CheckReport + hasRed 汇总。
export async function runCheck(name: string, docId: string): Promise<CheckResult> {
  return apiJson<CheckResult>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/check`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
    // P2-FE-2：本地机检但超大章节可能慢；无超时则 loading 永转
    60_000,
  )
}

/** B1（批 6）：标记误报——excerpt 服务端从正文切（±50 字、上限 200），落
 *  check/false-positive 事件（语料回归库燃料入口）；幂等（同章同 checkId 最近一次为准） */
export async function markFalsePositive(
  name: string,
  docId: string,
  checkId: string,
): Promise<{ ok: true; checkId: string; chapter: number; excerpt: string }> {
  return apiJson(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/check-false-positive`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkId }),
    },
    60_000,
  )
}
