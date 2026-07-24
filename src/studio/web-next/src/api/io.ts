import { apiJson } from './client'

// 导入/导出（细案 §2.2 T4.2）：POST /export spawn CLI（确定性，数秒返回）。
// format 三选；platform 五选一可选；带写 token。

export type ExportFormat = 'merged' | 'split' | 'both'
export type ExportPlatform = 'generic' | 'wechat' | 'zhihu-salt' | 'fanqie' | 'xiaohongshu'

export interface CliResult {
  ok: boolean
  code?: number
  stdout?: string
  stderr?: string
}

export async function exportBook(
  name: string,
  body: { format: ExportFormat; platform?: ExportPlatform },
): Promise<CliResult> {
  return apiJson<CliResult>(`/api/books/${encodeURIComponent(name)}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
