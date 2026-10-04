/**
 * 应用实例文件锁守卫。
 *
 * Electron requestSingleInstanceLock 在提权差异（管理员/普通用户各开一份）下失效
 * ——锁按会话/提权上下文隔离，两侧各自返回 true → 双开互踩 workdir.json /
 * window-state.json（atomic 写只防文件撕裂，防不了语义层竞态）。本守卫用 fs 跨进程
 * 锁（fs/cross-process-lock.ts，open 'wx' O_EXCL 原子 + pid 存活探测）补一道：锁文件
 * 落 userData（与 Electron 锁同一身份域），持有 pid 跨提权可见（process.kill(pid,0)
 * 对他人进程 EPERM → 按存活保守处理 → 拒绝第二实例）。
 *
 * 生命周期：持有方每 60s 续期（utimes 刷 mtime，防活 pid 超 10min MAX_HELD_MS 被
 * 陈锁接管误判——长活应用必须续期）；正常退出经 process 'exit' 钩子即刻释放（多道
 * 守卫逐条释放，见 activeReleases），崩溃/硬杀残留的死 pid 锁由 stale 接管自愈。
 * 多道守卫的消费点：main 在「实例 key 与实际采用库不一致」的残余形态下补挂实际库
 * 的守卫（见 main.ts bootstrap 尾注），其余调用方仍单道。
 *
 * 失败语义 fail-open：锁面异常（权限/磁盘/路径不可用）**放行**（acquired=true）——
 * 本守卫只是 Electron 锁的补充防线，同用户双开仍由 Electron 锁兜底，锁基建故障
 * 不应升级为应用无法启动。同进程重复获取（测试态 vi.resetModules 模块重载形态）
 * 视为同一实例放行（持有 pid 为自身）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log/index.js'
import { tryAcquireCrossProcessLock } from '../fs/cross-process-lock.js'

export const APP_INSTANCE_LOCK_FILE = 'app-instance.lock'

export interface AppInstanceGuard {
  /** true = 本实例放行（文件锁在持 / 同进程已在持 / 锁面异常 fail-open）；
   *  false = 检测到他实例在持（含跨提权形态），调用方应退出 */
  acquired: boolean
  /** 幂等释放（process.once('exit') 内部退出钩子消费——批起不再挂
   *  will-quit〔与 main.test.ts Electron 假件交互致 worker OOM，如实记档〕；未真持
   * 锁时为 no-op，生产路径无需调用）。JSDoc 过时指针记正。 */
  release(): void
}

/** 锁文件持有 pid 是否为本进程（同进程重复获取 = 同一实例）。 */
function selfHolds(lockPath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown }
    return raw.pid === process.pid
  } catch {
    return false
  }
}

/** 当前真持锁的释放函数集（进程退出钩子消费；未持锁为空集）。
 *  多库多窗残余形态：main 在「实例 key 与实际采用库不一致」时补挂第二道守卫
 *  （实际库的实例目录），故持锁面可为多条——exit 钩子与 releaseAllGuards 逐条释放。 */
const activeReleases = new Set<() => void>()
let exitHookRegistered = false

/** 释放本进程当前持有的全部实例锁（幂等；同步 rm 面安全）。
 *  出口有二：进程正常退出钩子（ensureExitHook）与测试直调（行为锚——单槽存储形态下
 *  先持锁的释放函数会被后持锁覆盖，本函数只会释放最后一道，据此可回退即红）。
 *  不走 Electron 'will-quit'——本模块不依赖 Electron（scripts/无 Electron 的入口也可
 *  复用），且崩溃/硬杀路径本就由锁的死 pid 陈锁接管自愈（头注），本函数只是常态退出
 *  即刻清盘的卫生面。 */
export function releaseAllGuards(): void {
  for (const r of activeReleases) {
    try {
      r()
    } catch {
      /* best-effort：失败留残锁交下次启动陈锁接管自愈 */
    }
  }
}

function ensureExitHook(): void {
  if (exitHookRegistered) return
  exitHookRegistered = true
  process.once('exit', () => {
    releaseAllGuards()
  })
}

export function acquireAppInstanceGuard(userDataDir: string): AppInstanceGuard {
  const lockPath = join(userDataDir, APP_INSTANCE_LOCK_FILE)
  if (selfHolds(lockPath)) {
    return { acquired: true, release: () => {} } // 同一实例重复获取：不自删锁面记录
  }
  try {
    const release = tryAcquireCrossProcessLock(lockPath, { renewIntervalMs: 60_000 })
    if (release) {
      const wrapped = (): void => {
        activeReleases.delete(wrapped)
        release()
      }
      activeReleases.add(wrapped)
      ensureExitHook()
      return { acquired: true, release: wrapped }
    }
  } catch (e) {
    log.warn(
      'desktop',
      `应用实例文件锁获取异常（fail-open 放行，Electron 单实例锁仍兜底）：${e instanceof Error ? e.message : String(e)}`,
    )
    return { acquired: true, release: () => {} }
  }
  return { acquired: false, release: () => {} }
}
