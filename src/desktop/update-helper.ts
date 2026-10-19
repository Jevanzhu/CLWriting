/**
 * 阶段 55：更新助手（目录替换执行者）——以 `--apply-update` 形态复用主程序 exe 启动的
 * 一次性进程，在旧应用退出后把新版本目录换到位。
 *
 * 为什么必须是**独立进程**（而不是旧应用退出前自己换）：Windows 上运行中的 exe 被文件锁
 * 保护，自己所在的目录改名必然失败。主进程入口在装配应用形态之前分流到本模块（main.ts
 * 顶部），因此助手态**不请求单实例锁、不起 server、不开窗**——它就是一段等待 + 改名 +
 * 拉起的顺序逻辑。
 *
 * 失败面三态（结果条 `update/cache.ts` 的 outcome）：
 *  - `aborted`：一字节未动（预检不过 / 旧进程不退出 / 包体校验失败）——目标目录原样；
 *  - `rolled-back`：改名换到一半失败，已把旧目录还原（用户下次双击仍是旧版可用）；
 *  - `applied`：换新完成（唯一会拉起新 exe 的结局）。
 *
 * 来源与方向校验（argv 是外部输入，本进程以用户权限运行，且**要改名与递归删目录**）：
 *  - 目标目录只认两种形态——自身镜像所在目录（就地启动），或本应用装配的暂存副本位
 *    `<home>/更新缓存/<目标版本>/helper`（控制器 `stageHelperDir` 同式；助手从暂存副本
 *    运行是预设形态，见 update-controller 的装配注）；
 *  - 包体只认共享根更新缓存内的文件；`--sha256` 缺失即拒绝（无锚包体不解压）；
 *  - 版本方向 fail-closed：`compareSemver(to, from) > 0` 恒须成立（与检查链同向），
 *    全链任一环漂移都不得把旧版装回。
 *  三者任一不符即拒绝，且**不写结果条**——结果条落点同样是 argv 给的。
 *
 * 解压上限：包体字节 × `EXTRACT_BYTES_FACTOR` 下发到解压面（绝对上限由 `update/extract`
 * 兜底），超限即整体失败并清掉半成品目录。
 *
 * 中断自愈：本进程可能在「目标已改名、新版未就位」的窄窗内被杀（断电/任务管理器）。
 * 此时磁盘上只剩 `<target>.old-<旧版本>`，而快捷方式指向的 `<target>` 已不存在——用户
 * 下次双击会落空。还原触发点只有一处：**下一次助手启动**（`runUpdateHelper` 的
 * `recoverInterruptedSwap` 把最近残留改回 target，再走正常流程）——其他启动形态都不还原：
 * 启动维护在 target 缺席时只保留 `.old-*` 不擦除（见 update-controller），普通双击应用则
 * 根本起不来（应用目录缺席）。故该残留会一直留在盘上，直到下一次更新流程把助手拉起来；
 * 若用户始终无法再启动任何副本，它不会被自动还原也不会被清掉（需重装或人工改名）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { renameWithRetry } from '../fs/atomic.js'
import { queryLockHeld } from '../fs/cross-process-lock.js'
import { isProcessAlive } from '../fs/process-alive.js'
import { APP_INSTANCE_LOCK_FILE } from './app-instance-guard.js'
import { instanceKeyForDir } from '../fs/user-data-path.js'
import { errMsg, log } from '../log/index.js'
import {
  updateCacheDir,
  updateCacheRoot,
  writeUpdateAttemptNote,
  type UpdateOutcome,
  type UpdateReason,
} from '../update/cache.js'
import { sha256OfFile } from '../update/download.js'
import { compareSemver } from '../update/semver.js'
import { extractZipTo, type ExtractLimits } from '../update/extract.js'

/** 助手态判决旗（main.ts 顶部据此分流；只要 argv 含本旗就绝不按应用形态启动） */
export const APPLY_UPDATE_FLAG = '--apply-update'

/** 等待旧进程退出的上限（毫秒）——超过即放弃（前台应用还在，硬换会把用户脚下抽掉） */
export const WAIT_PID_TIMEOUT_MS = 120_000

/** 旧进程存活轮询间隔（毫秒） */
const WAIT_PID_POLL_MS = 250

/** 空间预检的倍数（包体 × N）——解压产物通常与包体同量级，留一倍余量再叠旧目录占用 */
const SPACE_FACTOR = 3

/** 解压字节上限的倍数（包体 × N）——正常便携包解压后与包体同量级，留压缩比余量 */
export const EXTRACT_BYTES_FACTOR = 10

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
  /** 包体期望 sha256（换代前复核；null = 无锚——生产链路拒绝执行，见 refuseUntrustedInvocation） */
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

/** 目录删除（递归 + 静默，无 asar 叶处理——助手进程已 `process.noAsar = true`）；
 *  与 update-controller 的 `rmDirQuietly`（asar 叶摘除 + 重试，应用进程口径）语义不同，
 *  故分别命名，误引即「asar 目录删不掉」类缺陷复现。 */
function rmDirQuietlyPlain(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* 瞬时占用/权限：残留不阻断（下次助手起手或启动维护再清） */
  }
}

/** 目录同一判定（win 盘符/大小写不敏感；两侧都按 resolve 归一化分隔符） */
function sameDir(a: string, b: string): boolean {
  const ra = resolve(a)
  const rb = resolve(b)
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

/** 暂存副本位（与 update-controller 的 `helperStageDir` 同式：`<home>/更新缓存/<版本>/helper`；
 *  两处必须逐字一致——来源校验以它判定「助手确实是本应用装配的暂存副本」）。 */
function stagedHelperDir(homeDir: string, toVersion: string): string {
  return join(updateCacheDir(homeDir, toVersion), 'helper')
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/** 路径是否落在某目录之内（win 大小写不敏感；先 resolve 归一化分隔符再比前缀） */
function isInsideDir(path: string, dir: string): boolean {
  const p = resolve(path)
  const d = resolve(dir)
  const hit = process.platform === 'win32' ? p.toLowerCase().startsWith(d.toLowerCase() + sep) : p.startsWith(d + sep)
  return hit
}

/**
 * 来源与版本方向校验（fail-closed；先于任何盘面动作，包括中断自愈的改名）。
 * 返回拒绝原因（人话，只落日志），null = 放行。
 */
export function refuseUntrustedInvocation(
  inv: ApplyUpdateInvocation,
  opts: { execPath: string; allowUnanchoredPayload: boolean },
): string | null {
  const targetHasExe = existsSync(join(inv.targetDir, PORTABLE_EXE_NAME))
  // 目标缺席是「已改名未就位」的中断现场（要还原的正是它）：此时认可 `.old-<旧版本>`
  // 残留内的便携 exe——还原源仍是本应用目录的产物，不是随手可指的任意目录
  const residueHasExe =
    !existsSync(inv.targetDir) && existsSync(join(`${inv.targetDir}.old-${inv.fromVersion}`, PORTABLE_EXE_NAME))
  if (!targetHasExe && !residueHasExe) {
    return `目标目录内无 ${PORTABLE_EXE_NAME}（且无可还原的中断残留）：${inv.targetDir}`
  }
  const imageDir = dirname(opts.execPath)
  const inPlace = sameDir(inv.targetDir, imageDir)
  const staged = inv.homeDir !== null && sameDir(imageDir, stagedHelperDir(inv.homeDir, inv.toVersion))
  if (!inPlace && !staged) {
    return `目标目录 ${inv.targetDir} 既非助手镜像目录（${imageDir}），也非本应用装配的暂存副本位`
  }
  if (!inv.homeDir) return '缺少 --home：无法确认包体落在更新缓存内'
  if (!isInsideDir(inv.payloadZip, updateCacheRoot(inv.homeDir))) {
    return `包体不在更新缓存内：${inv.payloadZip}`
  }
  if (!opts.allowUnanchoredPayload) {
    const given = inv.sha256?.trim().toLowerCase() ?? ''
    if (!SHA256_HEX_RE.test(given)) return '包体缺少可用的 sha256 锚：拒绝解压不可校验的包'
  }
  let cmp: number
  try {
    cmp = compareSemver(inv.toVersion, inv.fromVersion)
  } catch {
    return `版本串无法比较：${inv.fromVersion} → ${inv.toVersion}`
  }
  if (!Number.isFinite(cmp) || cmp <= 0) {
    return `目标版本不高于当前版本（${inv.fromVersion} → ${inv.toVersion}）：拒绝降级安装`
  }
  return null
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
 * `excludeKey` = 本实例 key：调用方**恒须显式传**本机已知 key（自己的锁必在持，不算
 *  「其他」）——控制器侧 IPC 预检传 `currentInstanceKey()`，助手侧传 `ownInstanceKeyOf(inv)`；
 *  两路都取不到时才传 null，并按「多算即保守 abort」编码。
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

/**
 * 被替换旧实例的本机实例 key（`otherInstancesRunning` 的 excludeKey 实参）。
 * 两路取自控制器装配 argv 时既有的信息，都取不到 → null（不排除任何实例；多算即保守 abort）：
 *  ① `--log-dir` 的 `<home>/instances/<key>/logs` 段：旧实例的 userData 目录名即 key（最直接）；
 *  ② `--dir <书库>`：经 instanceKeyForDir 单源算式（与控制器 `currentInstanceKey()` 同式）。
 * 助手在「旧进程未退净」形态下工作时，自己的锁不得被算成「其他实例」。
 */
export function ownInstanceKeyOf(inv: ApplyUpdateInvocation): string | null {
  if (inv.logDir) {
    const m = /[\\/]instances[\\/]([^\\/]+)[\\/]logs[\\/]?$/.exec(resolve(inv.logDir))
    if (m?.[1]) return m[1]
  }
  const dir = argValue(inv.relaunchArgs, '--dir')
  return dir ? instanceKeyForDir(dir) : null
}

/** 只做还原的子命令旗：argv 含它即走还原出口（不解析更新参数、不换目录、不写结果条、
 *  不拉起任何进程）。用途 = 「已改名未就位」中断现场（target 缺席、快捷方式落空）下，
 *  用户无须先成功启动应用——直接跑 `CLWriting.exe --recover-interrupted-update
 *  --target <应用目录>` 把最近残留改回原位。 */
export const RECOVER_UPDATE_FLAG = '--recover-interrupted-update'

/** 是否还原子命令态（只看旗，与助手态同款：解析失败也必须走该出口，不得落回应用形态） */
export function isRecoverUpdateInvocation(argv: readonly string[]): boolean {
  return argv.includes(RECOVER_UPDATE_FLAG)
}

/** 还原出口（进程入口按本旗分流调用）：true = 目标目录已在位。
 *  与助手主流程共用 `recoverInterruptedSwap` 单点实现（不复制还原判据、不新增还原源），
 *  故不改写既有换目录 / 回滚语义；本出口只认 `--target`，其余 argv 一律不解释。 */
export function runRecoverUpdateCli(argv: readonly string[]): boolean {
  const target = argValue(argv, '--target')
  if (!target) {
    log.error('update', '还原子命令缺少 --target：无法定位应用目录')
    return false
  }
  const recovered = recoverInterruptedSwap(target)
  if (existsSync(target)) {
    log.info('update', `还原子命令：应用目录已在位（${target}）${recovered ? '（本次由残留还原）' : ''}`)
    return true
  }
  log.error('update', `还原子命令：无可还原残留，应用目录仍缺席（${target}）`)
  return false
}

export interface UpdateHelperDeps {
  isProcessAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  spawnDetached?: (exe: string, args: string[]) => Promise<boolean>
  extract?: (zipPath: string, dir: string, limits?: Partial<ExtractLimits>) => Promise<void>
  instancesRunning?: (homeDir: string, excludeKey?: string | null) => boolean
  sha256Of?: (path: string) => Promise<string>
  /** 助手自身镜像路径（来源校验基准；缺省 `process.execPath`）——测试注入 */
  execPath?: string
  /** 显式放行「无 sha256 锚的包体」（测试专项开关；生产恒 false = 拒绝） */
  allowUnanchoredPayloadForTest?: boolean
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
 * `sha256` 由来源校验保证有值（除测试开关放行形态），故此处复核恒被走到。
 * `ownInstanceKey` = 本机（被替换的旧实例）已知 key：显式排除自身，与控制器侧 IPC 预检
 * （`prepareUpdateApply` 传 `currentInstanceKey()`）形态对称。
 */
async function precheck(
  inv: ApplyUpdateInvocation,
  instancesRunning: (homeDir: string, excludeKey?: string | null) => boolean,
  sha256Of: (path: string) => Promise<string>,
  ownInstanceKey: string | null,
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
    if (actual !== inv.sha256.trim().toLowerCase()) return 'payload-corrupt'
  }
  if (inv.homeDir && instancesRunning(inv.homeDir, ownInstanceKey)) {
    // 其他库的窗口还开着：换目录会抽掉它们的运行底座（同库不同库都一样——
    // 「换一次全机生效」的前提就是此刻没有人正在跑旧版）
    return 'other-instances'
  }
  return null
}

/** 建新版目录 + 空间预检（半成品目录先清）；返回不放行的原因（null = 通过） */
function prepareWorkDir(newDir: string, targetDir: string, payloadZip: string): UpdateReason | null {
  rmDirQuietlyPlain(newDir) // 上次失败留下的半成品目录（存在即说明没换成）
  try {
    mkdirSync(newDir, { recursive: true })
  } catch {
    return 'not-writable'
  }
  const free = freeSpaceOf(dirname(targetDir))
  const zipSize = sizeOfFile(payloadZip)
  if (free !== null && zipSize > 0 && free < zipSize * SPACE_FACTOR) {
    rmDirQuietlyPlain(newDir)
    return 'no-space'
  }
  return null
}

/**
 * 换目录（不可回头点）：target → `.old-<旧版本>`，再 `-new-<新版本>` → target。
 * 返回 null = 换新完成；'target-locked' = 旧目录改名失败（目标未动，可安全放弃）；
 * 'swap-failed' = 新版目录就位失败（已尝试回滚；无论回滚本身成败都由调用方按
 * rolled-back 收口——该结局记的是「走了回滚链路」，回滚失败的子例见下注）。
 */
function swapDirs(targetDir: string, newDir: string, oldDir: string): UpdateReason | null {
  try {
    rmDirQuietlyPlain(oldDir) // 同版本历史残留（正常不该有；有则是上次同版本失败的重试）
    renameWithRetry(targetDir, oldDir)
  } catch (e) {
    log.error('update', `应用目录改名失败（${targetDir} → ${oldDir}）：${errMsg(e)}`)
    rmDirQuietlyPlain(newDir)
    return 'target-locked'
  }
  try {
    renameWithRetry(newDir, targetDir)
  } catch (e) {
    // 回滚：把旧目录改回原位（新版目录留着——下次重试的 rmDirQuietlyPlain(newDir) 会清掉）
    log.error('update', `新版目录就位失败，回滚：${errMsg(e)}`)
    try {
      renameWithRetry(oldDir, targetDir)
    } catch (rollbackErr) {
      // 双向失败：应用目录层面已无 target。`.old-` 留在盘上（启动维护在 target 缺席时
      // 不再擦除它），留作下一次助手启动 recoverInterruptedSwap 的还原源。
      // 结果条仍按 rolled-back + 'swap-failed' 收口：该结局记「走了回滚链路」而非
      // 「已还原」的事实——本子例目录其实缺席，呈现层的「已还原」文案与现场的差口
      // 就在这里（还原要等下一次助手启动）。
      log.error('update', `回滚也失败（${oldDir} → ${targetDir}）：${errMsg(rollbackErr)}`)
    }
    return 'swap-failed'
  }
  return null
}

/**
 * 跑助手主流程（返回值即结局，供进程退出码）。
 * 出口纪律：**任何**结局都先写结果条（有 homeDir 时）再返回——结果条是新进程唯一的
 * 现场来源，写不进去（返回 false）时至少留一行日志。例外只有一处：来源/方向校验拒绝的
 * 形态（`refuseUntrustedInvocation`）不写结果条——那一支的结果条落点同样是不可信入参。
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

  // 0. 来源与方向校验（先于任何盘面动作；中断自愈的改名同样以 target 为轴，不得跑在校验前）
  const refusal = refuseUntrustedInvocation(inv, {
    execPath: deps.execPath ?? process.execPath,
    allowUnanchoredPayload: deps.allowUnanchoredPayloadForTest === true,
  })
  if (refusal) {
    log.error('update', `更新助手拒绝执行：${refusal}`)
    return 'aborted'
  }

  // 1. 中断自愈：target 缺席但有 .old- 残留 → 先还原（否则后续一切预检都建在废墟上）
  recoverInterruptedSwap(targetDir)
  if (!existsSync(targetDir)) return finish('aborted', 'target-missing')

  // 2. 等旧进程退出（含旧应用的渲染/保存链收尾——这是助手存在的前提）
  if (!(await waitForExit(inv.pid, alive, sleep, now))) {
    // 旧应用还在前台：换掉它脚下的目录会把运行中的 exe 变孤儿——放弃且**不重启**
    //（用户面前已经有那个应用，再拉起一个只会双开）
    return finish('aborted', 'timeout')
  }

  // 3. 预检（全部通过才动目标目录）
  const blocked = await precheck(inv, instancesRunning, sha256Of, ownInstanceKeyOf(inv))
  if (blocked) return abortKeepingOld(blocked)
  const noRoom = prepareWorkDir(newDir, targetDir, inv.payloadZip)
  if (noRoom) return abortKeepingOld(noRoom)

  // 4. 解压到 `-new-<版本>`（此步失败目标目录未动）
  try {
    const zipBytes = sizeOfFile(inv.payloadZip)
    // 解压上限随包体收紧（见 update/extract 的绝对上限）：解压炸弹超限即整体失败
    await extract(inv.payloadZip, newDir, zipBytes > 0 ? { maxTotalBytes: zipBytes * EXTRACT_BYTES_FACTOR } : undefined)
  } catch (e) {
    log.error('update', `解压失败：${errMsg(e)}`)
    rmDirQuietlyPlain(newDir)
    return abortKeepingOld('extract-failed')
  }

  // 5. 换目录（不可回头点）
  const swapReason = swapDirs(targetDir, newDir, oldDir)
  if (swapReason === 'swap-failed') return finish('rolled-back', 'swap-failed')
  if (swapReason) return abortKeepingOld(swapReason)

  // 6. 拉起新版（换新已完成——拉起失败不影响结局，用户手动打开同样是新版）
  const spawned = await relaunch(exePath)
  return finish('applied', spawned ? 'ok' : 'relaunch-failed')
}
