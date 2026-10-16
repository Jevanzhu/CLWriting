/**
 * 阶段 55：更新缓存目录与「上次更新尝试」结果条的读写（薄 IO 面）。
 *
 * 落点 = **共享根** `<home>/更新缓存/`：`<home>/更新缓存/<版本>/` 放该版本的便携 zip，
 * `<home>/更新缓存/更新结果.json` 放助手进程写下的结果条。为什么不是实例目录（Electron
 * userData，`<home>/instances/<key>`）：更新助手进程由被替换的旧应用拉起，此刻它既不知道
 * 也不知道该信任启动实例的 key，而 zip 又是**跨库共享**的（同一份程序换一次就够）——
 * 缓存跟着共享根走，助手与 server 两侧都不需要额外传参即可算出同一路径。
 *
 * 结果条 = 跨进程、跨世代的一次性信箱：助手在退出前写，**新应用**（或回滚后的旧应用）
 * 起服后由 `GET /api/app-info` 取走（`takeUpdateAttemptNote` 读后即删）。这样「更新没成」
 * 不必依赖新进程能否起来——写盘发生在旧进程退出之后、任何界面出现之前，是唯一能在
 * 「新版本起不来」场景里活下来的反馈通道。
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'

/** 缓存目录名（共享根下；中文名与仓库既有用户可见目录口径一致，如「更新缓存」随应用数据根） */
export const UPDATE_CACHE_DIRNAME = '更新缓存'

/** 结果条文件名 */
export const UPDATE_RESULT_FILENAME = '更新结果.json'

export function updateCacheRoot(homeDir: string): string {
  return join(homeDir, UPDATE_CACHE_DIRNAME)
}

/** 某版本的缓存目录（zip 落点；下载链与启动清扫共用同一算式） */
export function updateCacheDir(homeDir: string, version: string): string {
  return join(updateCacheRoot(homeDir), version)
}

export function updateResultPath(homeDir: string): string {
  return join(updateCacheRoot(homeDir), UPDATE_RESULT_FILENAME)
}

/** 助手结局三态：applied = 已换新并拉起；aborted = 未动目标目录；rolled-back = 走完回滚
 *  链路（成功则旧目录已还原；reason 'swap-failed' 的子例里回滚本身也可能失败——目录缺席、
 *  还原源留待下一次助手启动，见 update-helper 的 swapDirs 注） */
export type UpdateOutcome = 'applied' | 'aborted' | 'rolled-back'

/** 结局原因码（机器码；人话在渲染层映射——文案改动不该动助手） */
export type UpdateReason =
  /** applied 的唯一正常原因 */
  | 'ok'
  /** 旧进程超期未退出（前台应用还在） */
  | 'timeout'
  /** 其他库窗口在运行 */
  | 'other-instances'
  /** 目标盘不可写（建新版目录失败） */
  | 'not-writable'
  /** 可用空间不足 */
  | 'no-space'
  /** 包体缺失/读不到 */
  | 'payload-missing'
  /** 包体 sha256 复核不符 */
  | 'payload-corrupt'
  /** 解压失败 */
  | 'extract-failed'
  /** 目标目录不存在（且无可还原残留） */
  | 'target-missing'
  /** 旧目录改名失败（被占用/权限） */
  | 'target-locked'
  /** 新版就位失败，已回滚 */
  | 'swap-failed'
  /** 已换新但没拉起来 */
  | 'relaunch-failed'
  | 'unknown'

const OUTCOMES: UpdateOutcome[] = ['applied', 'aborted', 'rolled-back']
const REASONS: UpdateReason[] = [
  'ok',
  'timeout',
  'other-instances',
  'not-writable',
  'no-space',
  'payload-missing',
  'payload-corrupt',
  'extract-failed',
  'target-missing',
  'target-locked',
  'swap-failed',
  'relaunch-failed',
  'unknown',
]

export interface UpdateAttemptNote {
  /** 写入时刻（ISO 串；只作展示「上次」的时间锚） */
  at: string
  outcome: UpdateOutcome
  /** 被替换的旧版本（回滚后即当前运行版本） */
  from: string
  /** 目标新版本 */
  to: string
  reason: UpdateReason
}

/** 写结果条（best-effort：失败返 false，调用方留痕后照常退出——结果条丢了不该让更新链失败） */
export function writeUpdateAttemptNote(homeDir: string, note: UpdateAttemptNote): boolean {
  try {
    atomicWriteFile(updateResultPath(homeDir), `${JSON.stringify(note)}\n`)
    return true
  } catch {
    return false
  }
}

/** 读结果条（不存在/畸形/字段越界一律 null——外部文件不可信） */
export function readUpdateAttemptNote(homeDir: string): UpdateAttemptNote | null {
  let raw: string
  try {
    raw = readFileSync(updateResultPath(homeDir), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const n = parsed as Record<string, unknown>
    const { at, outcome, from, to, reason } = n
    if (typeof at !== 'string' || typeof from !== 'string' || typeof to !== 'string') return null
    if (!OUTCOMES.includes(outcome as UpdateOutcome)) return null
    if (!REASONS.includes(reason as UpdateReason)) return null
    return { at, outcome: outcome as UpdateOutcome, from, to, reason: reason as UpdateReason }
  } catch {
    return null
  }
}

/** 取走结果条（读后即删——一次性信箱；端点每次拉起都取，取不到即无此事） */
export function takeUpdateAttemptNote(homeDir: string): UpdateAttemptNote | null {
  const note = readUpdateAttemptNote(homeDir)
  try {
    rmSync(updateResultPath(homeDir), { force: true })
  } catch {
    /* 删除失败（瞬时占用等）不阻断：下次启动再取一次同一条，至多多提示一次 */
  }
  return note
}
