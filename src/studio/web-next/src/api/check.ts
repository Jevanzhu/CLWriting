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
  )
}
