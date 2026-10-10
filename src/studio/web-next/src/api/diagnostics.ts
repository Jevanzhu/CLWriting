// 诊断包客户端：POST /api/diagnostics（服务端同步收集打包，MB 级——超时给 60s 兜底）。
// 失败回 422 {code:'DIAGNOSTICS_FAILED', error} 错误信封，由 apiJson 抛 ApiError。
import { apiJson } from './client'

export interface DiagnosticsResponse {
  ok: true
  /** 生成的包绝对路径 */
  file?: string
  /** 包所在目录绝对路径 */
  dir?: string
  /** 包内条目名（首条为 说明.txt） */
  entries?: string[]
  bytes?: number
  /** 收集期非致命问题（单日志文件不可读等）——包仍生成成功 */
  warnings?: string[]
}

/** POST /api/diagnostics → 生成诊断包（不带入参：包内容由服务端口径决定） */
export async function buildDiagnostics(): Promise<DiagnosticsResponse> {
  return apiJson<DiagnosticsResponse>('/api/diagnostics', { method: 'POST' }, 60_000)
}
