// app-info 客户端（阶段 53）：当前版本号 + 更新检查结果（更新提示数据源）。
// 只读端点，无需入参；失败向上抛由组件静默（比对器的静默口径在服务端，前端同样
// 不因「取不到版本信息」打扰作者）。
//
// 阶段 55 扩更新链两面：`update.asset`（便携 zip 资产——有才允许一键下载更新，
// 无则降级为「去下载」链接）与 `updateAttempt`（上次更新尝试的结果条，服务端读后即删，
// 顶多出现一次）。字段口径与服务端 `update/asset.ts`、`update/cache.ts` 对齐。
import { apiJson } from './client'

/** 便携 zip 资产（服务端从 GitHub 资产解析；`sha256` 为 null 时服务端会回落校验清单） */
export interface UpdateAsset {
  name: string
  url: string
  size: number | null
  sha256: string | null
}

export interface UpdateInfo {
  version: string
  url: string
  asset: UpdateAsset | null
  checksumsUrl: string | null
}

/** 上次更新尝试的结果条（更新助手写在新进程起服前的一次性反馈） */
export interface UpdateAttempt {
  at: string
  outcome: 'aborted' | 'rolled-back'
  from: string
  to: string
  reason:
    | 'ok'
    | 'timeout'
    | 'other-instances'
    | 'not-writable'
    | 'no-space'
    | 'payload-missing'
    | 'payload-corrupt'
    | 'extract-failed'
    | 'target-missing'
    | 'target-locked'
    | 'swap-failed'
    | 'relaunch-failed'
    | 'unknown'
}

/** 检查过程态（服务端 getUpdateCheckState + meta；结果本身在 `update` 里）。 */
export interface UpdateCheckMeta {
  /** `idle` = 从未跑过；`checking` = 正在出站；`done` = 已落定 */
  state: 'idle' | 'checking' | 'done'
  /** 上次落定时刻（epoch ms）；null = 从未落定 */
  checkedAt: number | null
  /** 上次失败原因（success 或未跑时为 null） */
  lastError: string | null
}

export interface AppInfo {
  /** 当前应用版本（服务端 resolveAppVersion：env 注入优先，缺省 package.json） */
  version: string
  /** 有新正式版时非空；未完成检查 / 已查无新版均为 null */
  update: UpdateInfo | null
  /** 上次更新未完成的说明（无则 null；服务端取一次即删） */
  updateAttempt: UpdateAttempt | null
  /** 检查过程态（老服务端无此字段——读侧按缺省 `idle` 兜底） */
  updateCheck?: UpdateCheckMeta
}

/** GET /api/app-info → { version, update, updateAttempt, updateCheck } */
export async function getAppInfo(): Promise<AppInfo> {
  return await apiJson<AppInfo>('/api/app-info')
}
