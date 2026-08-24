import { apiJson } from './client'

// 导入/导出（细案 §2.2 T4.2）：POST /export（B-24 起服务端 worker 线程执行，数秒返回）。
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

/** ii 批：域形状负载（与后端 /export 契约同步收敛——旧 CLI 信封 code/stdout/stderr 已废）。
 *  B-23（第六十轮补修）：业务失败改 422 {code:'EXPORT_FAILED', error} 错误信封——
 *  失败即由 apiJson 抛 ApiError（信封 error 即诊断文案，dv-01 完整保留），
 *  本类型只描述成功形状（ok 恒 true） */
export interface ExportResponse {
  ok: true
  chapterCount?: number
  unit?: string
  files?: string[]
}

export async function exportBook(
  name: string,
  body: { format: ExportFormat; platform?: ExportPlatform },
): Promise<ExportResponse> {
  return apiJson<ExportResponse>(
    `/api/books/${encodeURIComponent(name)}/export`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    // P2-FE-1：大书同步遍历可能数秒，无超时则 ExportDialog loading 永真
    60_000,
  )
}
