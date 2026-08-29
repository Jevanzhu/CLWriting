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
 * 账本级互斥；账本（ai-calls）/journal 的跨进程真锁已随 J7 落地（fs/cross-process-lock.ts），
 * 本文件锁原语同源收敛（T2-4 复制版已删）。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tryAcquireCrossProcessLock } from '../../../fs/cross-process-lock.js'
import { isSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { isChatRunning } from '../../../ai/orchestrate/chat.js'
import { hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { isSpawnRunning } from '../../../ai/orchestrate/spawn-registry.js'

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

export interface TaskGateOptions {
  /** 显式锁目录（测试注入临时目录用）；缺省用模块级 lockRoot。传 null 强制纯内存。 */
  lockDir?: string | null
  /** 进程存活判定（测试注入用）；缺省 process.kill(pid,0) 探测。 */
  isProcessAlive?: (pid: number) => boolean
  /** R71-3（十九轮）：锁续期周期注入（测试用）；缺省 TASK_GATE_RENEW_MS。 */
  renewIntervalMs?: number
}

/** R71-3（十九轮）：任务闸续期周期——闸持有段是分钟级 AI 任务（analyze/review/
 *  rag-build/大书导出现实可超 Z-19 的 10min 超龄线），不续期会被第二进程按
 *  「活 pid 超龄」接管成双持锁。30s 刷一次 mtime，远低于超龄门槛。 */
const TASK_GATE_RENEW_MS = 30_000

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
  // isAlive 未注入时传 undefined → 通用锁用缺省 process.kill(pid,0) 探测（同源）
  const isAlive = opts?.isProcessAlive
  let lockPath: string | null = null
  let lockRelease: (() => void) | null = null
  if (dir) {
    lockPath = join(dir, lockFileName(key))
    // J7：锁原语收敛到 fs/cross-process-lock.ts 单一实现（本文件原 T2-4 复制版删除）
    // R71-3（十九轮）：接线 N6 续期——任务闸持有段为分钟级（rag-build 整书 embed、
    // 大书多镜 review 现实可超 Z-19 的 10min 超龄线），此前不传 renewIntervalMs 会被
    // 第二进程按「活 pid 超龄」接管成双持锁（dev-api + 桌面双进程形态，真双进程实验
    // 已复现）。续期让活闸的 mtime 恒新，超龄接管只打击真死进程的 pid 复用残留。
    lockRelease = tryAcquireCrossProcessLock(lockPath, {
      isProcessAlive: isAlive,
      renewIntervalMs: opts?.renewIntervalMs ?? TASK_GATE_RENEW_MS,
    })
    if (!lockRelease) return null
  }
  running.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    // R66-29（十四轮）：释放失败会永久占死进程内闸——包 try/catch 保证清理必达；
    // 残留锁文件由 tryAcquireCrossProcessLock 的 stale 接管清理兜底，不致永锁。
    try {
      // 先删锁文件再清 Set：反序会让并发 acquire 在文件已删、Set 未清的窗口读到双闸。
      // R71-3（十九轮）：改用锁原语返回的 payload 校验版释放（R65-35②）——读回内容
      // 与本进程写入串一致才删。此前无条件 rmSync 在「被超龄接管 + 他人重建新锁」的
      // 残余窗口下会误删他人在位的新锁、放行第三个进程；校验版读到不一致即不删。
      if (lockRelease) lockRelease()
    } catch {
      /* 锁文件残留交 stale 接管；进程内闸照常释放 */
    }
    running.delete(key)
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

/**
 * R67-13（十五轮）：编排互斥矩阵补角。写稿系编排（self-heal 写章 / 对话在途 / 后台
 * 收尾任务）与覆盖写其输入文件的生成长任务（细纲/账本推进/onboard/风格分析）此前
 * 只有 per-action 的 acquireTaskGate（同 action 互斥，不跨类）：self-heal 在途时仍可
 * 并发生成细纲/账本草稿——细纲与账本恰是写稿的上下文注入源，覆盖写落盘 = self-heal
 * 后续章拿到混合态上下文（双费 + 机检误报红可触发多余重写；原子写保证无数据损坏）。
 * 生成类端点入口先查本闸再占自身 action 闸；在途 → 409 BUSY（与删书 busyGate 同口径）。
 */
export function orchestrationBusyFor(bookName: string): string | null {
  if (isSelfHealRunning(bookName)) return `本书自愈写稿进行中，等它完成后再生成（防写稿上下文被覆盖写混态）`
  if (isChatRunning(bookName)) return `本书对话进行中，等它完成后再生成（防写稿上下文被覆盖写混态）`
  // R74-3（二十二轮）：spawn 面（互斥矩阵补面，R67-13/R70-3 同族收口）——本闸此前
  // 只查 self-heal/chat/后台收尾，手动写稿（分钟级）在途时 outline/analysis/onboard/
  // lead-updates 等生成端点照常放行：覆盖写与写稿并发、后续章拿到混合态上下文，正是
  // R67-13 要防的场景（rewrite.ts R70-3 注释自认全库唯该面单独补查——本闸补齐后统一收口）。
  if (isSpawnRunning(bookName)) return `本书手动写稿进行中，等它完成后再生成（防写稿上下文被覆盖写混态）`
  if (hasBackgroundTasks(bookName)) return `本书有后台任务收尾中，稍后再生成`
  return null
}
