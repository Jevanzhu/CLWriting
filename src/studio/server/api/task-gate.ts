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
import { readdirSync } from 'node:fs'
import {
  tryAcquireCrossProcessLock,
  queryLockHeld,
  isProcessAlive as defaultIsProcessAlive,
} from '../../../fs/cross-process-lock.js'
import { isSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { isChatRunning } from '../../../ai/orchestrate/chat.js'
import { hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { isSpawnRunning } from '../../../ai/orchestrate/spawn-registry.js'
import { log } from '../../../log/index.js' // R37-21：锁根覆盖告警留痕

const running = new Set<string>()

// dd-P2 自查修正：action:book 冒号拼接在 heldTaskGatesFor 的后缀匹配下有歧义（闸
// "分析:A"会让书"A"误判持闸）。MP2-11（专项重评二轮顺修）注释勘误：首句「书名可含
// ':'」已过时——isInvalidBookName 现禁 \\/:*?"<>| 全集（win 非法字符集批）；分隔符
// 不回退冒号，NUL 分隔不依赖上游校验演进（改名规则再放宽也零歧义），书名/action
// 均不含 \0，键恒无歧义。
const SEP = '\u0000'
const keyOf = (bookName: string, action: string): string => `${action}${SEP}${bookName}`

// ── T2-4：跨进程文件锁 ──────────────────────────────

/** 模块级锁根目录（书库 .clwriting/task-gate/）——单 server 进程一个 workDir，
 *  startServer 启动时注入；null = 未配置（退化纯内存闸，与旧行为一致）。
 *  契约（R37-21 如实记）：单进程单锁根——重复 configure 即覆盖，且覆盖非空旧值
 *  时 log.warn 留痕（旧/新路径）。覆盖本身是合法操作（dev-api/脚本与测试重配
 *  workDir 场景），但不该无声——startServer 只在启动时配一次，运行中再配多为
 *  接线错误（旧锁根下已持有的锁文件从此查询/续期失联）。 */
let lockRoot: string | null = null

/** startServer 注入锁根目录（workDir 缺省 → null，纯内存闸）。
 *  R37-21（三十七轮）：覆盖非空旧值（且值实际变化）时 log.warn——此前静默覆盖，
 *  锁根漂移无从察觉。 */
export function configureTaskGateLockRoot(dir: string | null): void {
  if (lockRoot !== null && lockRoot !== dir) {
    log.warn('task-gate', `锁根目录被重复配置覆盖：${lockRoot} → ${dir}（单进程单锁根契约，运行中改配多为接线错误，旧锁根下在持锁文件将失联）`)
  }
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
 * R75-5（批 D）收口：跨进程面已由下方 crossProcessHeldTaskGatesFor 补齐（busyGate
 * 合并两侧后判 409）；本函数保持纯进程内语义（audit/stream/graceful-shutdown 等
 * 调用方只关心本进程编排态）。
 */
export function heldTaskGatesFor(bookName: string): string[] {
  const actions: string[] = []
  for (const key of running) {
    const i = key.indexOf(SEP)
    if (i !== -1 && key.slice(i + SEP.length) === bookName) actions.push(key.slice(0, i))
  }
  return actions
}

// ── R75-5（批 D）：跨进程持闸查询（只读扫描）────────────────────────

/** R75-5：全库任务闸 action 注册表——锁文件名是 key（action+NUL+书名）的单向 sha256
 *  截断，查询侧无法从文件名反解出 action，只能对已知 action 正向枚举 hash 比对。
 *  新增 acquireTaskGate 调用点时须同步登记此处（漏登记只削弱跨进程 busyGate 查询的
 *  完备性——少报一个在途 action，不影响 acquire 侧互斥本身）。
 *  R77-2（二十五轮批 E）：导出 + test/governance/known-actions-audit.test.ts 静态对账
 *  （扫全库调用点字面量 == 注册表）——漏登记从「注释自觉」变机器门。 */
export const KNOWN_ACTIONS: readonly string[] = [
  'analyze',
  'analyze-style',
  'autotag',
  'batch-finalize',
  'export',
  'infer-meta',
  'learn',
  'lead-updates',
  'onboard-ai',
  'onboard-save',
  'outline',
  'rag-build',
  'relations-mine',
  'review',
  'rewrite',
  'versions-prune', // R26-67（二十六轮）：快照清理端点（snapshots.ts POST /versions/prune）
]

/** R75-5：跨进程查询注入项（语义同 TaskGateOptions 对应字段）。 */
export interface CrossProcessQueryOptions {
  /** 显式锁目录（测试注入用）；缺省用模块级 lockRoot。 */
  lockDir?: string | null
  /** 进程存活判定（测试注入用）；缺省 process.kill(pid,0) 探测（与锁原语同源）。 */
  isProcessAlive?: (pid: number) => boolean
}

/**
 * R75-5（批 D）：该书当前被**其他进程**持有的任务闸（action 名列表）——扫任务闸锁
 * 文件目录，对已知 action 正向枚举锁文件名，陈锁判定复用锁原语语义（queryLockHeld：
 * 死 pid / 活 pid 超龄无续期 / 超龄半写均不算在持——勿把崩溃残留陈锁算成在持导致
 * 删书/改名被永久 409）。只读扫描、不取锁、不清理。
 *
 * 背景：dev-api/脚本与 GUI 多进程并存时，进程 B 的 DELETE/RENAME 书此前只查进程 A
 * 看不见的进程内 Set——分钟级任务（analyze/outline/rag-build/review…）在途时放行
 * 删/改，收尾原子写会在旧路径重建孤儿目录并白烧 API 费。busyGate 将本函数与
 * heldTaskGatesFor 合并去重后判 409（本进程闸在锁目录里也有锁文件，去重防双报）。
 * 锁目录不可读/未配置 → 返回空（退化旧纯内存行为，fail-open 与 lockRoot=null 同口径）。
 */
export function crossProcessHeldTaskGatesFor(bookName: string, opts?: CrossProcessQueryOptions): string[] {
  const dir = opts?.lockDir !== undefined ? opts.lockDir : lockRoot
  if (!dir) return []
  let names: Set<string>
  try {
    names = new Set(readdirSync(dir))
  } catch {
    return [] // 目录不存在（书库从未有过跨进程闸）/不可读——无在持
  }
  const isAlive = opts?.isProcessAlive ?? defaultIsProcessAlive
  const actions: string[] = []
  for (const action of KNOWN_ACTIONS) {
    const fname = lockFileName(keyOf(bookName, action))
    if (!names.has(fname)) continue
    if (queryLockHeld(join(dir, fname), { isProcessAlive: isAlive })) actions.push(action)
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
