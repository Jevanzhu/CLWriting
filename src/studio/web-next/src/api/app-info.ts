// app-info 客户端（阶段 53）：当前版本号 + 更新检查结果（更新横幅数据源）。
// 只读端点，无需入参；失败向上抛由组件静默（比对器的静默口径在服务端，前端同样
// 不因「取不到版本信息」打扰作者）。
import { apiJson } from './client'

export interface AppInfo {
  /** 当前应用版本（服务端 resolveAppVersion：env 注入优先，缺省 package.json） */
  version: string
  /** 有新正式版时非空；未完成检查 / 已查无新版均为 null */
  update: { version: string; url: string } | null
}

/** GET /api/app-info → { version, update } */
export async function getAppInfo(): Promise<AppInfo> {
  return await apiJson<AppInfo>('/api/app-info')
}
