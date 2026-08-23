/**
 * RB-SV-P2-2：API 层长任务并发闸（per book+action）。
 *
 * 分钟级 AI 任务端点重复点击 = 双倍费用 + 落盘互踩。各 handler 入口同步占位
 * （无 TOCTOU 窗口）、finally 释放；同 key 已在跑 → 409（与 /spawn、/auto-write
 * 闸同口径）。「随客户端断开中止 AI」不在本闸范围（接线面大，转后续轮次）。
 *
 * T2-4：进程内 Set 对双进程开同书无效（dev-api/脚本与 app 并行、Electron 拆分形态
 * fork 的 server 与主进程等）——加跨进程文件锁兜底：书库 .clwriting/ 下 lockfile
 * （O_EXCL 创建 + 写 pid + 进程启动时间；持有进程不存活（process.kill(pid,0) ESRCH）
 * 判 stale 接管清理——崩溃残留不永锁）。进程内 Set 语义保留作快路径（同进程重复
 * 点击零文件 IO）。acquire 失败仍返回 null（调用方回 409，锁不等待，语义同现状）。
 *
 * 边界声明：events/store.ts 的「写互斥」靠 SQLite busy_timeout，本闸不做事件库
 * 账本级互斥——真正的登记口径锁归 J7 轮次；本文件只管 task-gate 层（book+action
 * 粒度的长任务单飞）。
 */
import { mkdirSync, openSync, writeSync, closeSync, rmSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const running = new Set<string>()

// dd-P2 自查修正：书名可含 ":"（isInvalidBookName 只禁 \/ 与路径段），action:book 冒号拼接
// 在 heldTaskGatesFor 的后缀匹配下有歧义（闸"分析:A"会让书"A"误判持闸）。
// NUL 做分隔——书名经 isInvalidBookName 不含 \0，action 是代码字面量亦然，键无歧义。
const SEP = '\u0000'
const keyOf = (bookName: string, action: string): string => `${action}${SEP}${bookName}`

// ── T2-4：跨进程文件锁 ──────────────────────────────

/** 模块级锁根目录（书库 .clwriting/task-gate/）——单 server 进程一个 workDir，
 *  startServer 启动时注入；null = 未配置（退化纯内存闸，与旧行为一致）。 */
let lockRoot: string | null = null

/** startServer 注入锁根目录（workDir 缺省 → null，纯内存闸）。 */
export function configureTaskGateLockRoot(dir: string | null): void {
  lockRoot = dir
}

/** 本进程启动时刻（epoch ms，由 uptime 反推）——写入锁文件作诊断/未来 pid 复用
 *  判别依据；当前 stale 判定以进程存活探测为主（见 defaultIsProcessAlive）。 */
function processBootTime(): number {
  return Date.now() - Math.round(process.uptime() * 1000)
}

/** 进程存活探测：process.kill(pid, 0) 不发信号只做权限/存在性检查；ESRCH = 不存在
 *  （stale）。EPERM（存在但属他人）按存活处理——保守不接管。 */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface TaskGateOptions {
  /** 显式锁目录（测试注入临时目录用）；缺省用模块级 lockRoot。传 null 强制纯内存。 */
  lockDir?: string | null
  /** 进程存活判定（测试注入用）；缺省 process.kill(pid,0) 探测。 */
  isProcessAlive?: (pid: number) => boolean
}

/** key → 锁文件名：sha256 前 16 hex——书名可含任意路径字符，hash 后无路径注入/非法名。 */
function lockFileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex').slice(0, 16)}.lock`
}

/**
 * 占闸：成功返回 release（幂等）；同 book+action 已在跑返回 null（调用方回 409）。
 * action 是本模块约定字面量（不含 ":"），保证 key 无歧义。
 *
 * 顺序：进程内 Set 快路径 → 跨进程 lockfile（O_EXCL 独占创建；EEXIST 时探测持有
 * 进程，已死 = stale 接管（删文件后重试一次），活着 = 占闸失败返回 null）。
 */
export function acquireTaskGate(bookName: string, action: string, opts?: TaskGateOptions): (() => void) | null {
  const key = keyOf(bookName, action)
  if (running.has(key)) return null
  const dir = opts?.lockDir !== undefined ? opts.lockDir : lockRoot
  const isAlive = opts?.isProcessAlive ?? defaultIsProcessAlive
  let lockPath: string | null = null
  if (dir) {
    lockPath = join(dir, lockFileName(key))
    if (!acquireLockFile(lockPath, isAlive)) return null
  }
  running.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    // 先删锁文件再清 Set：反序会让并发 acquire 在文件已删、Set 未清的窗口读到双闸
    if (lockPath) rmSync(lockPath, { force: true })
    running.delete(key)
  }
}

/** O_EXCL 创建锁文件；EEXIST 时做 stale 判定与接管（至多重试一次，防竞态循环）。 */
function acquireLockFile(lockPath: string, isAlive: (pid: number) => boolean): boolean {
  mkdirSync(join(lockPath, '..'), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined
    try {
      // 'wx' = O_CREAT|O_EXCL：独占创建，创建与检查之间无 TOCTOU 窗口
      fd = openSync(lockPath, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }))
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw e // 非冲突类故障（权限/磁盘）上抛，由 dispatch 兜 500
      // 已被占：读持有者 pid，探测存活
      const holder = readHolderPid(lockPath)
      if (holder !== null && isAlive(holder)) return false // 活着 → 占闸失败（409）
      // 持有进程已死（或文件损坏读不出 pid——视同 stale，崩溃半写兜底）：接管清理重试
      rmSync(lockPath, { force: true })
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // 重复 close（上面 EEXIST 分支已关）best-effort
        }
      }
    }
  }
  // 第二次仍 EEXIST（接管与并发对手竞争输了）→ 占闸失败，同 409 口径
  return false
}

/** 读锁文件持有者 pid；损坏/空文件返回 null（视同 stale 可接管）。 */
function readHolderPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown }
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null
  } catch {
    return null
  }
}

/** 状态查询（测试用）：该闸当前是否被持有。 */
export function isTaskGateHeld(bookName: string, action: string): boolean {
  return running.has(keyOf(bookName, action))
}

/**
 * 该书当前被持有的全部任务闸（action 名列表）。
 * dd-P2：删书/改名前拒收——分钟级 AI 任务（analyze/rewrite/outline/rag-build 等）
 * 无 abort 通道，带着跑会让旧目录被收尾落盘重建 + 白烧 API 费用；入口拒 409 最省。
 * T2-4 注：只反映本进程持有（进程内 Set）；跨进程持有由锁文件体现，不在此列表
 * （删书闸本就要求任务与删书同进程才有 abort 收尾问题，跨进程场景交由真锁 J7 收口）。
 */
export function heldTaskGatesFor(bookName: string): string[] {
  const actions: string[] = []
  for (const key of running) {
    const i = key.indexOf(SEP)
    if (i !== -1 && key.slice(i + SEP.length) === bookName) actions.push(key.slice(0, i))
  }
  return actions
}
