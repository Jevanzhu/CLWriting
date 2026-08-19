// startup-notices 客户端（A4 批 0）：启动链迁移失败通告（App 级横幅数据源）。
import { apiJson } from './client'

/** 单条启动通告（服务端 StartupNotice 同构） */
export interface StartupNotice {
  ts: string
  kind: string
  message: string
}

/** GET /api/startup-notices → 本次 server 生命周期内收集的通告 */
export async function getStartupNotices(): Promise<StartupNotice[]> {
  const r = await apiJson<{ notices: StartupNotice[] }>('/api/startup-notices')
  return r.notices ?? []
}
