/**
 * 阶段 55：更新控制器（主进程侧）——能力闸、下载编排、退出链上的助手拉起、启动维护。
 *
 * 模块边界：
 *  - 路径与结果条归 `update/cache.ts`；资产解析归 `update/asset.ts`；下载原语归
 *    `update/download.ts`；换目录的执行者在 `update-helper.ts`（本模块只**计划**它，不执行）；
 *  - 渲染层交互面（IPC 三处同步）在 `ipc.ts` / `preload.ts` / `desktop.d.ts`，本模块
 *    只暴露纯函数式入口（返回 {ok, reason} 契约与 reason 人话），供 IPC 层直调；
 *  - 更新检查也归本模块侧（`createUpdateCheckHost`）：检查出站与下载同走 `net.fetch`
 *    （受系统代理），结果下发子进程落态——子进程全局 fetch 不读代理，见该函数注。
 *
 * 为什么下载要重新解析发布信息（不复用启动时检查结果）：进程可能已开着很久，期间可能
 * 发了新版本；重新取一次保证「下载的就是当下最新正式版」，并顺手把版本对不上（响应被
 * 篡改/缓存错位）这类形态挡在下载之前。
 *
 * 与切库（workdir-controller）的意图互斥：两者都以「退出 + 重启」兑现，同时挂起会起
 * 两个新进程（一个按 --dir 旧库、一个按新库）。故 apply 预检显式拒「切库在途」，反向
 * （apply 已武装后切库）靠退出链相位收敛——切库的 reboot 意图只在退出链不可回头点兑现，
 * 那时本模块意图已先行兑现并占了进程重启位（见 armPendingUpdateIfAny 调用点注释）。
 */
import { cpSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, net, shell } from 'electron'
import { testableConst } from '../shared/testable.js'
import { errMsg, log } from '../log/index.js'
import { appDataHomeDir, instanceKeyForDir } from '../fs/user-data-path.js'
import { compareSemver } from '../update/semver.js'
import {
  fetchLatestRelease,
  getUpdateCheckResult,
  getUpdateCheckState,
  runUpdateCheckOnce,
  UPDATE_CHECK_DELAY_MS,
  UPDATE_RESULT_MESSAGE_TYPE,
} from '../update/check.js'
import { pickChecksumsUrl, pickPortableAsset, type UpdateAsset } from '../update/asset.js'
import { downloadUpdateZip, sha256OfFile } from '../update/download.js'
import { UPDATE_RESULT_FILENAME, updateCacheDir, updateCacheRoot } from '../update/cache.js'
import { currentWorkDir, isRelaunchPending } from './workdir-controller.js'
import { APPLY_UPDATE_FLAG, otherInstancesRunning, PORTABLE_EXE_NAME, spawnDetachedProcess } from './update-helper.js'

/**
 * 开发/非 Windows 形态下强制开启「下载」能力的开关（严格 opt-in，同 CLW_SMOKE_* 口径）：
 * mac/linux 开发机可以真下载一次便携包验链路（下载 → 校验 → 缓存落盘 → 打开所在文件夹），
 * 但**不**放行安装（安装面恒要求 win + 打包态）——`--apply-update` 的目录换名语义是
 * Windows 便携形态专属，别的平台上跑没有意义也不安全。
 * 打包态一律忽略本变量（宿主残留 env 不得改变生产行为）。
 */
export const UPDATE_DEV_FORCE_ENV = 'CLW_UPDATE_FORCE_ENABLE'

function devForceDownload(): boolean {
  return !app.isPackaged && process.env[UPDATE_DEV_FORCE_ENV] === '1'
}

/** 能否应用内下载便携包（win 打包态；或开发态显式开关） */
export function selfUpdateDownloadCapable(): boolean {
  if (devForceDownload()) return true
  return app.isPackaged && process.platform === 'win32'
}

/** 能否自动安装（换目录 + 重启）：win 打包态专属 */
export function selfUpdateInstallCapable(): boolean {
  return app.isPackaged && process.platform === 'win32'
}

/** 更新包就绪态（下载成功后置；applied/放弃/取消后清） */
export interface PendingUpdate {
  zipPath: string
  /** 实测 sha256（非法/未校验形态为 null——助手侧据此决定是否复核） */
  sha256: string | null
  toVersion: string
}

const [getPending, setPending] = testableConst<PendingUpdate | null>(null)

/** 最近一次下载落点（「打开所在文件夹」用；与 pending 生命周期解耦——取消后仍可打开看看） */
let lastZipPath: string | null = null

export interface UpdateIpcResult {
  ok: boolean
  reason?: string
}

export interface UpdateProgressEvent {
  received: number
  total: number | null
}

/** 发布信息请求超时（毫秒）——用户点了按钮在等，比启动检查的 5s 稍宽 */
const RELEASE_FETCH_TIMEOUT_MS = 10_000

/** net.fetch 适配（受系统代理；主进程全局 fetch 不走 Chromium 网络栈）。
 *  调用方只传 URL 串（发布信息与包体地址），故此处把三种入参形态归一为串。 */
const netFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return net.fetch(url, init)
}

let activeDownload: AbortController | null = null

/** 下载取消（用户点「取消」；无在途下载时 no-op） */
export function cancelUpdateDownload(): void {
  activeDownload?.abort()
}

function failureMessage(reason: 'network' | 'checksum' | 'disk' | 'canceled', detail: string): string {
  switch (reason) {
    case 'canceled':
      return '已取消下载'
    case 'network':
      return `下载失败（${detail}）——请重试或改用「去下载」`
    case 'checksum':
      return `更新包校验未通过：${detail}`
    case 'disk':
      return `更新包保存失败：${detail}`
  }
}

/**
 * 下载便携包到共享根缓存并置就绪态。
 * 缓存复用：正式名文件存在 ⟺ 它上一轮已过校验——此时实测 sha256 与发布方给的值
 * 一致就直接复用（重复点击不重下三百兆）；对不上或发布方没给值则删掉重下。
 */
export async function startUpdateDownload(opts: {
  version: string
  onProgress: (p: UpdateProgressEvent) => void
}): Promise<UpdateIpcResult> {
  if (!selfUpdateDownloadCapable()) {
    return { ok: false, reason: '当前平台不提供应用内下载，请用「去下载」到发布页获取' }
  }
  if (activeDownload) return { ok: false, reason: '已有一次下载正在进行中' }

  const home = appDataHomeDir()
  let release: Awaited<ReturnType<typeof fetchLatestRelease>> = null
  try {
    release = await fetchLatestRelease(netFetch, RELEASE_FETCH_TIMEOUT_MS)
  } catch (e) {
    log.warn('update', `发布信息拉取异常：${errMsg(e)}`)
  }
  if (!release) return { ok: false, reason: '取不到发布信息（网络不可达或限速），请稍后重试或改用「去下载」' }
  const version = release.tag.replace(/^v/, '')
  if (version !== opts.version.replace(/^v/, '')) {
    return { ok: false, reason: '发布页版本已变化，请重新检查更新' }
  }
  const asset: UpdateAsset | null = pickPortableAsset(release.assets, version)
  if (!asset) return { ok: false, reason: '该版本未提供便携包，请改用「去下载」' }

  const destDir = updateCacheDir(home, version)
  const zipPath = join(destDir, asset.name)
  if (existsSync(zipPath)) {
    const actual = await sha256OfFile(zipPath).catch(() => null)
    if (actual && asset.sha256 && actual === asset.sha256) {
      lastZipPath = zipPath
      setPending({ zipPath, sha256: actual, toVersion: version })
      return { ok: true }
    }
    try {
      rmSync(zipPath, { force: true })
    } catch {
      /* 删不掉就交给下一步的覆盖写：打开同名文件写会失败 → 报 disk，用户可见 */
    }
  }

  const controller = new AbortController()
  activeDownload = controller
  try {
    const r = await downloadUpdateZip({
      url: asset.url,
      destDir,
      fileName: asset.name,
      size: asset.size,
      sha256: asset.sha256,
      checksumsUrl: pickChecksumsUrl(release.assets),
      fetchImpl: netFetch,
      signal: controller.signal,
      onProgress: opts.onProgress,
    })
    if (!r.ok) return { ok: false, reason: failureMessage(r.failure.reason, r.failure.detail) }
    lastZipPath = r.zipPath
    setPending({ zipPath: r.zipPath, sha256: r.sha256, toVersion: version })
    log.info('update', `更新包就绪：${r.zipPath}（v${version}）`)
    return { ok: true }
  } finally {
    activeDownload = null
  }
}

/** 「打开所在文件夹」（开发态只有下载没有安装时的出口）：无下载过则 no-op 留痕 */
export function revealUpdateDownload(): void {
  if (!lastZipPath || !existsSync(lastZipPath)) {
    log.warn('update', '更新包目录无物可开（本次进程尚未下载过更新包）')
    return
  }
  shell.showItemInFolder(lastZipPath)
}

/**
 * 应用更新前的预检（IPC 层直调；通过后由 ipc 层置退出链 + app.quit）。
 * 四道闸：形态（win 打包态）→ 包已就绪且版本一致 → 无切库在途 → 无其他实例在跑。
 */
export function prepareUpdateApply(opts: { version: string }): UpdateIpcResult {
  if (!selfUpdateInstallCapable()) {
    return {
      ok: false,
      reason: devForceDownload()
        ? '当前为开发/非 Windows 形态：更新包已下载，自动安装需在 Windows 便携版上进行'
        : '当前平台不支持自动安装更新，请用「去下载」',
    }
  }
  const pending = getPending()
  if (!pending) return { ok: false, reason: '更新包尚未就绪，请先下载' }
  if (pending.toVersion !== opts.version.replace(/^v/, '')) return { ok: false, reason: '版本已变化，请重新检查更新' }
  if (isRelaunchPending()) return { ok: false, reason: '应用正在切换书库，请稍后再试' }
  if (otherInstancesRunning(appDataHomeDir(), currentInstanceKey())) {
    return { ok: false, reason: '还有其他书库的窗口在运行，请先关闭它们再更新' }
  }
  return { ok: true }
}

/** 本实例 key（自查排除用）：与启动链同一算式（instanceKeyForDir 单源） */
function currentInstanceKey(): string {
  return instanceKeyForDir(currentWorkDir())
}

/** 目标应用目录 = 当前 exe 所在目录（打包态即便携解压目录；dev 态是 Electron 发行目录） */
export function appDirOf(execPath: string): string {
  return dirname(execPath)
}

/** 助手暂存副本落点：`<home>/更新缓存/<目标版本>/helper`——与包体同目录，随版本缓存一并清扫 */
export function helperStageDir(homeDir: string, toVersion: string): string {
  return join(updateCacheDir(homeDir, toVersion), 'helper')
}

/** 整棵应用目录 → 暂存落点（半成品先清）；成功返回暂存 exe 路径，失败留痕并返回 null */
function stageHelperCopy(sourceDir: string, stageDir: string): string | null {
  try {
    rmDirQuietly(stageDir)
    cpSync(sourceDir, stageDir, { recursive: true })
    return join(stageDir, PORTABLE_EXE_NAME)
  } catch (e) {
    log.error('update', `助手暂存副本复制失败（${sourceDir} → ${stageDir}）：${errMsg(e)}`)
    rmDirQuietly(stageDir)
    return null
  }
}

/**
 * 退出链不可回头点兑现更新意图（lifecycle 调用，时序与 pendingRelaunch 同款）：
 * 此刻旧应用的 flush/停机全过、进程即将退出，助手进程接管（它自己等我们死透）。
 * 助手一律从**目标目录外的暂存副本**运行：Electron 进程会把自镜像所在目录占住，
 * 从目标内跑助手则「target → .old-」改名必败 EPERM（win 真机实测；三连对照：
 * 真 node.exe 同样形态不挡、Electron 镜像移出目标即通）。暂存副本放更新缓存内，随版本
 * 缓存一并清扫；复制失败与「形态不支持」同款收口——丢弃意图留痕，不让退出链挂着。
 * 形态不支持（非 win 打包态）时静默丢弃并留痕——意图不该把应用卡在退出链上。
 */
export function armPendingUpdateIfAny(): void {
  const pending = getPending()
  if (!pending) return
  setPending(null)
  if (!selfUpdateInstallCapable()) {
    log.warn('update', '带更新意图退出但当前形态不支持自动安装——已丢弃（更新包留在缓存）')
    return
  }
  const home = appDataHomeDir()
  const targetDir = appDirOf(process.execPath)
  const stagedExe = stageHelperCopy(targetDir, helperStageDir(home, pending.toVersion))
  if (!stagedExe) {
    log.warn('update', '助手暂存副本不可用——本次更新已丢弃（更新包仍在缓存，可稍后重试）')
    return
  }
  const args = [
    APPLY_UPDATE_FLAG,
    '--payload',
    pending.zipPath,
    '--target',
    targetDir,
    '--pid',
    String(process.pid),
    '--from-version',
    app.getVersion(),
    '--to-version',
    pending.toVersion,
    '--home',
    home,
    '--log-dir',
    join(app.getPath('userData'), 'logs'),
  ]
  const workDir = currentWorkDir()
  if (workDir) args.push('--dir', workDir)
  if (pending.sha256) args.push('--sha256', pending.sha256)
  // 助手拉起是 fire-and-forget：主进程随后退出，助手自己等本 pid 消失——
  // 此处 await 会把退出链钉在助手存活上（助手要等我们退出，成了死结）
  void spawnDetachedProcess(stagedExe, args).then((ok) => {
    if (!ok) log.error('update', '更新助手拉起失败——本次更新未执行（更新包仍在缓存，可稍后重试）')
  })
  log.info('update', `已交接更新助手（暂存副本）：${app.getVersion()} → ${pending.toVersion}`)
}

/** 丢弃更新意图（退出被取消时调用）；返回是否确有意图（IPC 层据此广播「已取消」） */
export function discardPendingUpdate(): boolean {
  if (!getPending()) return false
  setPending(null)
  return true
}

/** 测试钩子：注入就绪态（IPC/退出链用例免真下载） */
export function __setPendingUpdateForTest(next: PendingUpdate | null): void {
  setPending(next)
}

/** 测试钩子：读就绪态（断言下载链真的置了位，以及退出链兑现后已清） */
export function __getPendingUpdateForTest(): PendingUpdate | null {
  return getPending()
}

// ── 启动维护（bootstrap 尾段排程）────────────────────────

/** 把 `<dir>/resources` 下的 `*.asar` 文件摘成普通名（返回摘了几件）。
 *  Electron 正常应用进程的 fs 带 asar 层：`resources/app.asar` 被呈现为**目录**，递归删
 *  整树在这片叶子上必 EPERM（win 真机实测）——摘名后它只是普通文件，删除恢复照常。 */
function detachAsarLeaves(dir: string): number {
  const resources = join(dir, 'resources')
  let names: string[]
  try {
    names = readdirSync(resources)
  } catch {
    return 0
  }
  let detached = 0
  for (const name of names) {
    if (!name.endsWith('.asar')) continue
    try {
      renameSync(join(resources, name), join(resources, `${name}.rm-${process.pid}`))
      detached++
    } catch {
      /* 摘不动：删除同样只是失败残留，两者等价，不另行处置 */
    }
  }
  return detached
}

/** 删目录（best-effort；rm 可注入——测试用桩模拟 asar 层的 EPERM）。
 *  Electron 进程的 asar 层会绊住含 `resources/*.asar` 的递归删（见 detachAsarLeaves）：
 *  先摘叶再重试一次，两次仍失败交残留（下次启动维护再清），不阻断调用方。 */
export function rmDirQuietly(path: string, opts?: { rm?: (p: string) => void }): void {
  const doRm = opts?.rm ?? ((p: string) => rmSync(p, { recursive: true, force: true }))
  try {
    doRm(path)
    return
  } catch {
    /* 见函数注：摘 asar 叶后重试 */
  }
  detachAsarLeaves(path)
  try {
    doRm(path)
  } catch {
    /* 瞬时占用：残留交下次启动，不阻断 */
  }
}

export interface UpdateMaintenanceOptions {
  /** 应用目录（`dirname(process.execPath)`）；null = 跳过目录残留清扫 */
  appDir: string | null
  homeDir: string
  currentVersion: string
}

/**
 * 启动维护（幂等、失败只留痕）：
 *  1. 应用目录旁的 `-new-*` 残留下手清；`.old-*` 仅在 target（应用目录本身）在位时清
 *     （换新成功后的旧目录）。**target 缺席**（中断在「已改名未就位」窗）时 `.old-*` 是
 *     唯一回滚面——留着给助手的 recoverInterruptedSwap 还原，此处不得擦除（擦了回滚能力永久消失）。
 *  2. 缓存目录里版本 ≤ 当前版本的目录（升级完成后的旧包、或用户放弃的旧版包）与
 *     `*.part` 残迹；最新版（> 当前）与结果条一律保留。
 * 只在打包态跑：dev 态 execPath 指着 node_modules 里的 Electron 发行目录，扫它的兄弟
 * 目录纯属误伤；缓存面在 dev 态也可能是真实用户数据（不该被开发进程删）。
 */
export function runUpdateMaintenance(opts: UpdateMaintenanceOptions): void {
  if (opts.appDir) {
    const parent = dirname(opts.appDir)
    const base = opts.appDir.slice(parent.length + 1)
    // target 在位才清 `.old-*`：缺席时它是 recoverInterruptedSwap 的唯一还原源
    const targetPresent = existsSync(opts.appDir)
    let names: string[] = []
    try {
      names = readdirSync(parent)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!name.startsWith(base)) continue
      const isNew = name.startsWith(`${base}-new-`)
      const isOld = name.startsWith(`${base}.old-`)
      if (isNew || (isOld && targetPresent)) {
        log.info('update', `清理更新残留目录：${join(parent, name)}`)
        rmDirQuietly(join(parent, name))
      }
    }
  }

  const root = updateCacheRoot(opts.homeDir)
  if (!existsSync(root)) return
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (name === UPDATE_RESULT_FILENAME) continue
    const path = join(root, name)
    if (name.endsWith('.part')) {
      rmDirQuietly(path)
      continue
    }
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    // 只清「像版本号的目录且不高于当前版本」——非版本名目录（用户误放的）不动
    const cmp = compareSemver(opts.currentVersion, name)
    if (cmp > 0) {
      log.info('update', `清理更新缓存：${path}`)
      rmDirQuietly(path)
    }
  }
}

/** 启动维护排程（bootstrap 尾段调用一次；dev 态直接跳过，见 runUpdateMaintenance 注） */
export function scheduleUpdateMaintenance(): void {
  if (!app.isPackaged) return
  try {
    runUpdateMaintenance({
      appDir: process.platform === 'win32' ? appDirOf(process.execPath) : null,
      homeDir: appDataHomeDir(),
      currentVersion: app.getVersion(),
    })
  } catch (e) {
    log.warn('update', `更新残留清扫异常（不影响启动）：${errMsg(e)}`)
  }
}

// ── 更新检查宿主（主进程侧）────────────────────────────

export interface UpdateCheckHostDeps {
  /** 结果下发通道（main 接 `serverManager.postMessage`）；返回是否送达 */
  push: (message: unknown) => boolean
  /** 当前版本读数（缺省 `app.getVersion()`） */
  currentVersion?: () => string
  /** 检查实现（缺省真件：`netFetch` 走 Chromium 网络栈受系统代理，与下载腿同通道）；
   *  测试注入桩免打网 */
  runCheck?: () => Promise<void>
}

export interface UpdateCheckHost {
  /** 延迟跑一次检查并下发结果（幂等：本 app 生命周期只排一次；缺省延时 UPDATE_CHECK_DELAY_MS） */
  scheduleCheck(delayMs?: number): void
  /** 补发最近一次检查结果（child 崩溃重启 / session-end 自愈拉起新进程后调用——新 child 的
   *  模块态是空的，不补发则「已检查」结论随重启丢失）。返回是否送达。 */
  pushLastResult(): boolean
}

/**
 * 更新检查宿主（主进程侧）：跑检查 + 把结果下发子进程。
 *
 * 检查归主进程的动因：子进程全局 fetch 走 Node 网络栈，**不读系统代理**——「只配系统代理」
 * 的用户检查恒失败且静默（实测直连 api.github.com 超时），而下载腿的 `net.fetch` 受系统
 * 代理。检查搬到主进程后两腿同通道，代理面一并收敛；子进程经 parentPort 收结果落态
 * （server-utility），端点（api/app-info.ts）仍是只读口。
 *
 * 下发时机两处：延迟跑完一次（scheduleCheck）；child 重启后补发（pushLastResult——见其注）。
 * 未跑过检查（未到点 / 开关短路）不下发：子进程保持「未完成」态，端点语义同从前。
 */
export function createUpdateCheckHost(deps: UpdateCheckHostDeps): UpdateCheckHost {
  const currentVersion = deps.currentVersion ?? (() => app.getVersion())
  const runCheck =
    deps.runCheck ?? (() => runUpdateCheckOnce({ fetchImpl: netFetch, currentVersion: currentVersion() }))
  let scheduled = false

  const pushLastResult = (): boolean => {
    if (getUpdateCheckState() !== 'done') return false
    const delivered = deps.push({ type: UPDATE_RESULT_MESSAGE_TYPE, result: getUpdateCheckResult() })
    if (!delivered) {
      log.info('update', '更新检查结果未能下发子进程（服务不在位）——服务重启后会补发')
    }
    return delivered
  }

  return {
    scheduleCheck(delayMs: number = UPDATE_CHECK_DELAY_MS): void {
      // 本 app 生命周期只排一次：bootstrap 重跑（activate / 失败重试）不得重复出站——
      // 检查结论在进程内是「一次」语义（原实现随 child 生命周期，现随 app 生命周期）
      if (scheduled) return
      scheduled = true
      const timer = setTimeout(() => {
        void runCheck()
          .then(() => {
            pushLastResult()
          })
          .catch((e) => {
            log.warn('update', `更新检查宿主异常（不影响启动）：${errMsg(e)}`)
          })
      }, delayMs)
      timer.unref?.()
    },
    pushLastResult,
  }
}
