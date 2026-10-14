/**
 * 阶段 55：更新助手（目录替换执行者）——以 `--apply-update` 形态复用主程序 exe 启动的
 * 一次性进程，在旧应用退出后把新版本目录换到位。
 *
 * 为什么必须是**独立进程**（而不是旧应用退出前自己换）：Windows 上运行中的 exe 被文件锁
 * 保护，自己所在的目录改名必然失败（见设计方案 §4.3 的前置验证项）。主进程入口在装配
 * 应用形态之前分流到本模块（main.ts 顶部），因此助手态**不请求单实例锁、不起 server、
 * 不开窗**——它就是一段等待 + 改名 + 拉起的顺序逻辑。
 *
 * 失败面三态（结果条 `update/cache.ts` 的 outcome）：
 *  - `aborted`：一字节未动（预检不过 / 旧进程不退出 / 包体校验失败）——目标目录原样；
 *  - `rolled-back`：改名换到一半失败，已把旧目录还原（用户下次双击仍是旧版可用）；
 *  - `applied`：换新完成（唯一会拉起新 exe 的结局）。
 *
 * 中断自愈：本进程可能在「目标已改名、新版未就位」的窄窗内被杀（断电/任务管理器）。
 * 此时磁盘上只剩 `<target>.old-<旧版本>`，而快捷方式指向的 `<target>` 已不存在——用户
 * 下次双击会落空。恢复点是**下一次助手启动**（助手是本模块唯一入口：用户重试「下载并
 * 更新」或再点一次即触达，起手 `recoverInterruptedSwap` 先把最近残留改回 target，再走
 * 正常流程）；另有一次启动维护清扫 `.old-*` 残留（见 update-controller）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { renameWithRetry } from '../fs/atomic.js'
import { queryLockHeld } from '../fs/cross-process-lock.js'
import { isProcessAlive } from '../fs/process-alive.js'
import { APP_INSTANCE_LOCK_FILE } from './app-instance-guard.js'
import { errMsg, log } from '../log/index.js'
import { writeUpdateAttemptNote, type UpdateOutcome, type UpdateReason } from '../update/cache.js'
import { sha256OfFile } from '../update/download.js'
import { extractZipTo } from '../update/extract.js'

/** 助手态判决旗（main.ts 顶部据此分流；只要 argv 含本旗就绝不按应用形态启动） */
export const APPLY_UPDATE_FLAG = '--apply-update'

/** 等待旧进程退出的上限（毫秒）——超过即放弃（前台应用还在，硬换会把用户脚下抽掉） */
export const WAIT_PID_TIMEOUT_MS = 120_000

/** 旧进程存活轮询间隔（毫秒） */
const WAIT_PID_POLL_MS = 250

/** 空间预检的倍数（包体 × N）——解压产物通常与包体同量级，留一倍余量再叠旧目录占用 */
const SPACE_FACTOR = 3

/** 便携包内 exe 名（electron-builder productName 口径；助手拉起新版的默认目标） */
export const PORTABLE_EXE_NAME = 'CLWriting.exe'

export interface ApplyUpdateInvocation {
  /** 便携包绝对路径（缓存目录内、已校验） */
  payloadZip: string
  /** 被替换的应用目录绝对路径（旧 exe 所在目录） */
  targetDir: string
  /** 旧进程 pid（等它退出再动手） */
  pid: number
  /** 旧版本号（`.old-<旧版本>` 命名与结果条用） */
  fromVersion: string
  /** 新版本号（`-new-<新版本>` 命名与结果条用） */
  toVersion: string
  /** 重启新版的附加 argv（如 `--dir <书库>`；空表 = 不带参） */
  relaunchArgs: string[]
  /** 新版 exe 绝对路径（缺省 `<targetDir>/CLWriting.exe`） */
  exePath: string | null
  /** 包体期望 sha256（换代前复核；null = 不复核，仅测试/降级形态） */
  sha256: string | null
  /** 结果条与维护日志落点（共享根；null = 不写结果条） */
  homeDir: string | null
  /** 助手日志目录（旧实例的 userData/logs；null = 不落盘） */
  logDir: string | null
}

/** 取值：`--key value` 形态（无值或缺下一个旗 → null） */
function argValue(argv: readonly string[], key: string): string | null {
  const i = argv.indexOf(key)
  const v = i >= 0 ? argv[i + 1] : undefined
  if (v === undefined || v.startsWith('--')) return null
  return v
}

/** 是否助手态（只看旗——解析失败也必须走助手出口，不得落回应用形态） */
export function isApplyUpdateInvocation(argv: readonly string[]): boolean {
  return argv.includes(APPLY_UPDATE_FLAG)
}

/** 解析助手 argv（缺必需项 → null；调用方按「带旗但不可解析」记 error 后退出） */
export function parseApplyUpdateArgv(argv: readonly string[]): ApplyUpdateInvocation | null {
  if (!isApplyUpdateInvocation(argv)) return null
  const payloadZip = argValue(argv, '--payload')
  const targetDir = argValue(argv, '--target')
  const pidRaw = argValue(argv, '--pid')
  const fromVersion = argValue(argv, '--from-version')
  const toVersion = argValue(argv, '--to-version')
  if (!payloadZip || !targetDir || !pidRaw || !fromVersion || !toVersion) return null
  const pid = Number(pidRaw)
  if (!Number.isInteger(pid) || pid <= 0) return null
  // 重启参数块：`--dir` 单值（多库多窗沿用的透传面），无则空表
  const dir = argValue(argv, '--dir')
  return {
    payloadZip,
    targetDir,
    pid,
    fromVersion,
    toVersion,
    relaunchArgs: dir ? ['--dir', dir] : [],
    exePath: argValue(argv, '--exe'),
    sha256: argValue(argv, '--sha256'),
    homeDir: argValue(argv, '--home'),
    logDir: argValue(argv, '--log-dir'),
  }
}

/** 目录删除（递归 + 静默）——失败残留交下次启动维护清扫，不反转主流程结局 */
function rmDirQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* 瞬时占用/权限：残留不阻断（下次助手起手或启动维护再清） */
  }
}

/**
 * 中断自愈：target 缺席且存在 `.old-*` 残留 → 把最近修改的那个改回 target。
 * 返回是否发生了还原。多个残留（历史多次失败）时取 mtime 最新者——那是最后一次未完成的
 * 交换留下的（更早的残留对应的是已经失败并回滚过的尝试，其内容与后续版本无关）。
 */
export function recoverInterruptedSwap(targetDir: string): boolean {
  if (existsSync(targetDir)) return false
  const parent = dirname(targetDir)
  const prefix = `${basename(targetDir)}.old-`
  let names: string[]
  try {
    names = readdirSync(parent).filter((n) => n.startsWith(prefix))
  } catch {
    return false
  }
  if (names.length === 0) return false
  const ranked = names
    .map((n) => {
      const p = join(parent, n)
      try {
        return { p, mtime: statSync(p).mtimeMs }
      } catch {
        return { p, mtime: 0 }
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
  try {
    renameWithRetry(ranked[0]!.p, targetDir)
    log.warn('update', `发现中断的更新残留，已把 ${ranked[0]!.p} 还原为 ${targetDir}`)
    return true
  } catch (e) {
    log.error('update', `中断残留还原失败（${ranked[0]!.p} → ${targetDir}）：${errMsg(e)}`)
    return false
  }
}

/**
 * 是否有**其他实例**在运行（跨库多窗）。判据 = `instances/<key>/app-instance.lock` 在持
 * （queryLockHeld 与 acquire 同源口径：活 pid 未超龄才算在持，死进程残留不算）——
 * 不看 Electron 单实例锁：它按 userData 隔离，只覆盖同库。
 * `excludeKey` = 本实例 key（点击时刻自查用：自己的锁必在持，不算「其他」）。
 * 读不到 `instances/`（单实例旧布局/权限）按「无其他实例」放行——少查一层的代价是
 * 极端形态下别的窗口被换掉底座，故此处**不留 fail-open 兜底判断**：目录不存在本身
 * 就是「本机从未跑过多实例」的强信号。
 */
export function otherInstancesRunning(homeDir: string, excludeKey?: string | null): boolean {
  const root = join(homeDir, 'instances')
  let keys: string[]
  try {
    keys = readdirSync(root)
  } catch {
    return false
  }
  for (const key of keys) {
    if (excludeKey && key === excludeKey) continue
    if (queryLockHeld(join(root, key, APP_INSTANCE_LOCK_FILE))) return true
  }
  return false
}

export interface UpdateHelperDeps {
  isProcessAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  spawnDetached?: (exe: string, args: string[]) => Promise<boolean>
  extract?: (zipPath: string, dir: string) => Promise<void>
  instancesRunning?: (homeDir: string) => boolean
  sha256Of?: (path: string) => Promise<string>
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 分离式拉起（同 new-instance 的口径）：'spawn'/'error' 两向落定后 unref，父进程退出不带走子进程 */
export function spawnDetachedProcess(exe: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
    child.once('spawn', () => {
      settled = true
      child.unref()
      resolve(true)
    })
    child.once('error', () => {
      if (!settled) resolve(false)
    })
  })
}

/** 目录可用空间（字节；探测失败 → null = 跳过判据，交给解压阶段自己报错） */
function freeSpaceOf(dir: string): number | null {
  try {
    const st = statfsSync(dir)
    return st.bavail * st.bsize
  } catch {
    return null
  }
}

/** 文件字节数（探测失败 → 0 = 空间判据跳过该乘数） */
function sizeOfFile(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 等旧进程退出（返回是否已退）。超时态助手必须放弃——前台应用还在，硬换会抽掉用户脚下的底座。 */
async function waitForExit(
  pid: number,
  alive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<boolean> {
  const deadline = now() + WAIT_PID_TIMEOUT_MS
  while (alive(pid) && now() < deadline) await sleep(WAIT_PID_POLL_MS)
  return !alive(pid)
}

/**
 * 预检：包体在位且复核一致 + 无其他实例在跑。返回不放行的原因（null = 通过）。
 * 只读不写——目标目录原样保留，调用方据此决定是否把旧应用还给用户。
 */
async function precheck(
  inv: ApplyUpdateInvocation,
  instancesRunning: (homeDir: string) => boolean,
  sha256Of: (path: string) => Promise<string>,
): Promise<UpdateReason | null> {
  if (!existsSync(inv.payloadZip)) return 'payload-missing'
  if (inv.sha256) {
    let actual: string
    try {
      actual = await sha256Of(inv.payloadZip)
    } catch (e) {
      log.warn('update', `包体复核失败（${inv.payloadZip}）：${errMsg(e)}`)
      return 'payload-missing'
    }
    if (actual !== inv.sha256.toLowerCase()) return 'payload-corrupt'
  }
  if (inv.homeDir && instancesRunning(inv.homeDir)) {
    // 其他库的窗口还开着：换目录会抽掉它们的运行底座（同库不同库都一样——
    // 「换一次全机生效」的前提就是此刻没有人正在跑旧版）
    return 'other-instances'
  }
  return null
}

/** 建新版目录 + 空间预检（半成品目录先清）；返回不放行的原因（null = 通过） */
function prepareWorkDir(newDir: string, targetDir: string, payloadZip: string): UpdateReason | null {
  rmDirQuietly(newDir) // 上次失败留下的半成品目录（存在即说明没换成）
  try {
    mkdirSync(newDir, { recursive: true })
  } catch {
    return 'not-writable'
  }
  const free = freeSpaceOf(dirname(targetDir))
  const zipSize = sizeOfFile(payloadZip)
  if (free !== null && zipSize > 0 && free < zipSize * SPACE_FACTOR) {
    rmDirQuietly(newDir)
    return 'no-space'
  }
  return null
}

/**
 * 换目录（不可回头点）：target → `.old-<旧版本>`，再 `-new-<新版本>` → target。
 * 返回 null = 换新完成；'target-locked' = 旧目录改名失败（目标未动，可安全放弃）；
 * 'swap-failed' = 新版目录就位失败（已尝试回滚，由调用方按 rolled-back 收口）。
 */
function swapDirs(targetDir: string, newDir: string, oldDir: string): UpdateReason | null {
  try {
    rmDirQuietly(oldDir) // 同版本历史残留（正常不该有；有则是上次同版本失败的重试）
    renameWithRetry(targetDir, oldDir)
  } catch (e) {
    log.error('update', `应用目录改名失败（${targetDir} → ${oldDir}）：${errMsg(e)}`)
    rmDirQuietly(newDir)
    return 'target-locked'
  }
  try {
    renameWithRetry(newDir, targetDir)
  } catch (e) {
    // 回滚：把旧目录改回原位（新版目录留着——下次重试的 rmDirQuietly(newDir) 会清掉）
    log.error('update', `新版目录就位失败，回滚：${errMsg(e)}`)
    try {
      renameWithRetry(oldDir, targetDir)
    } catch (rollbackErr) {
      // 双向失败：库目录层面已无 target。下次任何启动的 recoverInterruptedSwap 会
      // 把 .old- 还原（这是该路径存在的意义）；结果条如实标 rolled-back。
      log.error('update', `回滚也失败（${oldDir} → ${targetDir}）：${errMsg(rollbackErr)}`)
    }
    return 'swap-failed'
  }
  return null
}

/**
 * 跑助手主流程（返回值即结局，供进程退出码）。
 * 出口纪律：**任何**结局都先写结果条（有 homeDir 时）再返回——结果条是新进程唯一的
 * 现场来源，写不进去（返回 false）时至少留一行日志。
 */
export async function runUpdateHelper(inv: ApplyUpdateInvocation, deps: UpdateHelperDeps = {}): Promise<UpdateOutcome> {
  const alive = deps.isProcessAlive ?? isProcessAlive
  const sleep = deps.sleep ?? sleepMs
  const now = deps.now ?? Date.now
  const spawnDetached = deps.spawnDetached ?? spawnDetachedProcess
  const extract = deps.extract ?? extractZipTo
  const instancesRunning = deps.instancesRunning ?? otherInstancesRunning
  const sha256Of = deps.sha256Of ?? sha256OfFile

  const targetDir = inv.targetDir
  const newDir = `${targetDir}-new-${inv.toVersion}`
  const oldDir = `${targetDir}.old-${inv.fromVersion}`
  const exePath = inv.exePath ?? join(targetDir, PORTABLE_EXE_NAME)

  /** 结局落定：写结果条（best-effort）+ 一行日志 */
  const finish = (outcome: UpdateOutcome, reason: UpdateReason): UpdateOutcome => {
    if (inv.homeDir) {
      const ok = writeUpdateAttemptNote(inv.homeDir, {
        at: new Date().toISOString(),
        outcome,
        from: inv.fromVersion,
        to: inv.toVersion,
        reason,
      })
      if (!ok) log.warn('update', `更新结果条写入失败（${inv.homeDir}），结局仅存于日志`)
    }
    log.info('update', `更新助手结局：${outcome}（${reason}）— ${inv.fromVersion} → ${inv.toVersion}`)
    return outcome
  }

  /** 拉起 exe（换新成功后的默认动作，与预检失败后「把旧应用还给用户」共用） */
  const relaunch = async (exe: string): Promise<boolean> => {
    try {
      return await spawnDetached(exe, inv.relaunchArgs)
    } catch (e) {
      log.error('update', `拉起失败（${exe}）：${errMsg(e)}`)
      return false
    }
  }

  /** 预检失败共用出口：不动目标目录，把旧应用原样还给用户（用户至少能看到界面 + 结果条提示） */
  const abortKeepingOld = async (reason: UpdateReason): Promise<UpdateOutcome> => {
    await relaunch(exePath)
    return finish('aborted', reason)
  }

  // 0. 中断自愈：target 缺席但有 .old- 残留 → 先还原（否则后续一切预检都建在废墟上）
  recoverInterruptedSwap(targetDir)
  if (!existsSync(targetDir)) return finish('aborted', 'target-missing')

  // 1. 等旧进程退出（含旧应用的渲染/保存链收尾——这是助手存在的前提）
  if (!(await waitForExit(inv.pid, alive, sleep, now))) {
    // 旧应用还在前台：换掉它脚下的目录会把运行中的 exe 变孤儿——放弃且**不重启**
    //（用户面前已经有那个应用，再拉起一个只会双开）
    return finish('aborted', 'timeout')
  }

  // 2. 预检（全部通过才动目标目录）
  const blocked = await precheck(inv, instancesRunning, sha256Of)
  if (blocked) return abortKeepingOld(blocked)
  const noRoom = prepareWorkDir(newDir, targetDir, inv.payloadZip)
  if (noRoom) return abortKeepingOld(noRoom)

  // 3. 解压到 `-new-<版本>`（此步失败目标目录未动）
  try {
    await extract(inv.payloadZip, newDir)
  } catch (e) {
    log.error('update', `解压失败：${errMsg(e)}`)
    rmDirQuietly(newDir)
    return abortKeepingOld('extract-failed')
  }

  // 4. 换目录（不可回头点）
  const swapReason = swapDirs(targetDir, newDir, oldDir)
  if (swapReason === 'swap-failed') return finish('rolled-back', 'swap-failed')
  if (swapReason) return abortKeepingOld(swapReason)

  // 5. 拉起新版（换新已完成——拉起失败不影响结局，用户手动打开同样是新版）
  const spawned = await relaunch(exePath)
  return finish('applied', spawned ? 'ok' : 'relaunch-failed')
}
