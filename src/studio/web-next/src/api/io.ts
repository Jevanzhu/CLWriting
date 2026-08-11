import { apiJson } from './client'

// 导入/导出（细案 §2.2 T4.2）：POST /export spawn CLI（确定性，数秒返回）。
// format 三选；platform 五选一可选；带写 token。

export type ExportFormat = 'merged' | 'split' | 'both'
export type ExportPlatform = 'generic' | 'wechat' | 'zhihu-salt' | 'fanqie' | 'xiaohongshu'

/** 导出格式选项（UI 与类型同源，P2-PROD-5：消除组件内硬编码） */
export const EXPORT_FORMATS: { v: ExportFormat; label: string; hint: string }[] = [
  { v: 'merged', label: '合并', hint: '全书一个文件' },
  { v: 'split', label: '分章', hint: '每章一个文件' },
  { v: 'both', label: '全量', hint: '合并 + 分章' },
]

/** 导出平台选项（P2-PROD-5：从 ExportDialog 提取，集中管理） */
export const EXPORT_PLATFORMS: { v: ExportPlatform; label: string }[] = [
  { v: 'generic', label: '通用' },
  { v: 'wechat', label: '公众号' },
  { v: 'zhihu-salt', label: '知乎盐选' },
  { v: 'fanqie', label: '番茄' },
  { v: 'xiaohongshu', label: '小红书' },
]

export interface ExportResponse {
  ok: boolean
  code?: number
  stdout?: string
  stderr?: string
}

export async function exportBook(
  name: string,
  body: { format: ExportFormat; platform?: ExportPlatform },
): Promise<ExportResponse> {
  return apiJson<ExportResponse>(`/api/books/${encodeURIComponent(name)}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
