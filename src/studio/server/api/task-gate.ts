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
 *
 * R0916-7-P3-12（2026-09-25 源码质量评审 P3-12）：忙闸互斥矩阵单源化——此前
 * 「哪类在途活动拦哪个端点、拦下说什么话」散在 7 处手写（stream 的 spawn/auto-write、
 * chat、audit 的清库族、books-lifecycle 的删/改名、documents-core 的结构操作、
 * review 三审、本文件的编排闸），已见漂移（半角/全角逗号两种、review 书级闸文案与
 * 成因不符）。现收敛为下面的 BUSY_MATRIX（行 = 请求方意图，列 = 在途活动信号），
 * 各端点入口只调 busyReason(book, intent) 一次；文案由 SIGNAL_TEXT + INTENT_TAIL
 * 单源拼装，句读统一全角顿号/逗号。
 *
 * R0916-7-P3-14（同批）：锁文件名由「截断 sha256(key)」改 `${action}.${hash(book)}.lock`
 * ——列目录即可枚举（不再需要动作注册表逐个哈希探测），排障一眼看出持有者；迁移策略
 * 见下方「锁文件名与旧格式迁移」段。
 *
 * R0916-7-P3-6（2026-09-25 源码质量评审 P3-6）：本模块的进程内闸表 / 三审登记表 /
 * 锁根三份模块级可变状态收进 **TaskGate 实例**（createTaskGate）——服务端组装根
 * （server/index.ts 的 createStudioServer）建实例并经各路由 ctx 显式传递，同进程内
 * 两个 server 实例因此互不干扰（判据用例见 test/studio/assembly-root-deps-injection.test.ts）。
 * 模块级函数（acquireTaskGate 等）保留为**进程默认实例**的委托壳：非路由消费方
 * （desktop/graceful-shutdown.ts 的退出等待、sweepStaleReviewDirs 的启动清扫、ai 侧
 * task-gate-port 的注册面）与既有测试按原签名调用，语义逐位不变。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import type { ServerResponse } from 'node:http' // 复审-0914-优化修复批（P1-2）：包装面 res 形参
import {
  tryAcquireCrossProcessLock,
  queryLockHeld,
  rmWithRetryQuiet,
  isProcessAlive as defaultIsProcessAlive,
} from '../../../fs/cross-process-lock.js'
import { isSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { isChatRunning } from '../../../ai/orchestrate/chat.js'
import { hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { isSpawnRunning } from '../../../ai/orchestrate/spawn-registry.js'
import { log } from '../../../log/index.js' // R37-21：锁根覆盖告警留痕
import { replyError } from '../http.js' // 复审-0914-优化修复批（P1-2/D4）：包装面 409/错误信封统一出口
import { productionDriverHost, type DriverHost } from '../driver-port.js' // R0916-7-P3-6：driver 经组装根注入
import type { Session } from '../../../driver/types.js' // R0916-7-P3-16 收尾：StudioDriver 必需契约单源在 driver/types.ts，本文件只消费注入宿主

// ── R0916-7-P3-6：闸实例状态（进程默认实例 / 工厂实例各持一份）────────────────

/** 闸实例的可变状态：锁根 + 进程内闸表 + 三审登记表。
 *  所有权：createTaskGate 的调用方（服务端组装根 / 进程默认实例）。 */
interface GateState {
  /** 跨进程锁根目录（书库 .clwriting/task-gate/）；null = 未配置（退化纯内存闸） */
  lockRoot: string | null
  /** 进程内闸：key = `${action}\0${book}` */
  running: Set<string>
  /** 三审运行登记：key = `${book}\0${docId}` */
  reviewRunning: Set<string>
}

const newGateState = (lockRoot: string | null): GateState => ({ lockRoot, running: new Set(), reviewRunning: new Set() })

// dd-P2 自查修正：action:book 冒号拼接在 heldTaskGatesFor 的后缀匹配下有歧义（闸
// "分析:A"会让书"A"误判持闸）。MP2-11（专项重评二轮顺修）注释勘误：首句「书名可含
// ':'」已过时——isInvalidBookName 现禁 \\/:*?"<>| 全集（win 非法字符集批）；分隔符
// 不回退冒号，NUL 分隔不依赖上游校验演进（改名规则再放宽也零歧义），书名/action
// 均不含 \0，键恒无歧义。
const SEP = '\u0000'
const keyOf = (bookName: string, action: string): string => `${action}${SEP}${bookName}`

// ── T2-4：跨进程文件锁 ──────────────────────────────

export function configureTaskGateLockRoot(dir: string | null): void {
  processGate.configureLockRoot(dir)
}

/**
 * 配锁根目录（workDir 缺省 → null，纯内存闸）——组装期调用。
 * R37-21（三十七轮）：覆盖非空旧值（且值实际变化）时 log.warn——此前静默覆盖，
 * 锁根漂移无从察觉。
 * R0916-7-P3-14：注入同时做一次旧格式锁清扫（见 sweepLegacyGateLocks）。
 *
 * 契约（R37-21 如实记）：单实例单锁根——重复 configure 即覆盖；覆盖本身是合法操作
 * （dev-api/脚本与测试重配 workDir 场景），但不该无声——组装只在启动时配一次，
 * 运行中再配多为接线错误（旧锁根下已持有的锁文件从此查询/续期失联）。 */
function configureLockRootIn(state: GateState, dir: string | null): void {
  if (state.lockRoot !== null && state.lockRoot !== dir) {
    log.warn('task-gate', `锁根目录被重复配置覆盖：${state.lockRoot} → ${dir}（单实例单锁根契约，运行中改配多为接线错误，旧锁根下在持锁文件将失联）`)
  }
  state.lockRoot = dir
  if (dir) sweepLegacyGateLocks(dir)
}


interface TaskGateOptions {
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

// ── R0916-7-P3-14：锁文件名（可枚举格式）+ 旧格式迁移 ──────────────────────

/** 书名段哈希：书名可含任意路径字符（isInvalidBookName 禁全集但历史书目/外部
 *  写入不保证），哈希后无路径注入/非法名/长度问题。 */
const bookTag = (bookName: string): string => createHash('sha256').update(bookName).digest('hex').slice(0, 16)

/** 锁文件名 = `${action}.${hash(book)}.lock`——action 段自描述，readdir 即得「本书
 *  有哪些任务在跑」，排障从文件名直读持有者（旧格式 = 截断 sha256(action+NUL+book)，
 *  两者都不可逆，只能靠注册表逐个哈希探测——P3-14 的问题面）。
 *  action 必须是文件名安全 token（不含 '.'，否则枚举解析歧义）——机器门见
 *  test/governance/known-actions-audit.test.ts（扫调用点字面量校验 token 形状）。 */
export function lockFileName(bookName: string, action: string): string {
  return `${action}.${bookTag(bookName)}.lock`
}

/** R0916-7-P3-14：旧格式锁文件名（P3-14 前的 key 哈希形态）。
 *  仅迁移期探测/清扫用，新代码不产出该名；保留到确认无旧版进程在跑为止——
 *  迁掉它 = 旧残留的双持风险重新露头（见 acquireTaskGate 的旧名探测）。 */
function legacyLockFileName(bookName: string, action: string): string {
  return `${createHash('sha256').update(keyOf(bookName, action)).digest('hex').slice(0, 16)}.lock`
}

/** 旧格式名型（16 hex + .lock）；新格式含两个 '.' 段，永不命中本式。 */
const LEGACY_LOCK_NAME_RE = /^[0-9a-f]{16}\.lock$/

/** R0916-7-P3-14：启动清扫旧格式残留（非在持的旧名锁文件）。在持的保留并留痕——
 *  那是混合版本运行（旧版进程还在跑），删它等于替旧版把闸放掉；这种形态由 acquire
 *  侧的旧名探测兜住（单侧不双持），残留不越积（非在持即清）。清扫失败不阻断启动。 */
function sweepLegacyGateLocks(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // 锁目录尚未创建（首次启动无任务闸）/不可读——无可清扫
  }
  for (const name of names) {
    if (!LEGACY_LOCK_NAME_RE.test(name)) continue
    const p = join(dir, name)
    if (queryLockHeld(p)) {
      log.warn('task-gate', `旧格式任务闸锁在持：${p}（混合版本运行——旧版进程持旧名锁，本侧占闸会一并探测旧名并退让，不双持；旧名不在列目录枚举面内，排障时留意）`)
      continue
    }
    rmWithRetryQuiet(p) // 重试后仍失败静默放弃：残留由下次启动清扫兜底
  }
}

/**
 * 占闸（实现体，state 显式传入——实例化见 createTaskGate）。
 *
 * 顺序：进程内 Set 快路径 → 跨进程 lockfile（O_EXCL 独占创建；EEXIST 时探测持有
 * 进程，已死 = stale 接管（删文件后重试一次），活着 = 占闸失败返回 null）。
 */
function acquireIn(state: GateState, bookName: string, action: string, opts?: TaskGateOptions): (() => void) | null {
  const key = keyOf(bookName, action)
  if (state.running.has(key)) return null
  const dir = opts?.lockDir !== undefined ? opts.lockDir : state.lockRoot
  // isAlive 未注入时传 undefined → 通用锁用缺省 process.kill(pid,0) 探测（同源）
  const isAlive = opts?.isProcessAlive
  let lockPath: string | null = null
  let lockRelease: (() => void) | null = null
  if (dir) {
    lockPath = join(dir, lockFileName(bookName, action))
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
    // R0916-7-P3-14：迁移期旧名探测——旧格式锁（同名 key 的哈希名）若仍在持，放掉刚
    // 占的新锁并退让。没有这一探，混合版本运行（旧版进程持旧名 + 新版进程持新名）会
    // 对同一任务双持双跑；新锁先占后放保证「先拿新再探旧」的竞态方向也安全（旧版进程
    // 只认旧名，不会因新名存在而误判空闲）。
    if (legacyGateHeld(bookName, action, dir, isAlive)) {
      lockRelease()
      return null
    }
  }
  state.running.add(key)
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
      // 残余窗口下会误删他人在位的旧锁、放行第三个进程；校验版读到不一致即不删。
      if (lockRelease) lockRelease()
    } catch {
      /* 锁文件残留交 stale 接管；进程内闸照常释放 */
    }
    state.running.delete(key)
  }
}

/** 占闸（进程默认实例）：成功返回 release（幂等）；同 book+action 已在跑返回 null
 *  （调用方回 409）。action 是本模块约定字面量（文件名安全 token，锁名可解析）。 */
export function acquireTaskGate(bookName: string, action: string, opts?: TaskGateOptions): (() => void) | null {
  return acquireIn(processState, bookName, action, opts)
}

/** R0916-7-P3-14：迁移期旧名探测——旧格式锁在持 → true（调用方退让）；非在持则顺手
 *  清掉残留（不越积），清理失败留给下次启动清扫。先探存在性：无旧残留是常态，省掉
 *  一次白删（rmSync force 对不存在路径静默成功，但退避壳会为空跑付重试代价）。 */
function legacyGateHeld(bookName: string, action: string, dir: string, isAlive: ((pid: number) => boolean) | undefined): boolean {
  const legacyPath = join(dir, legacyLockFileName(bookName, action))
  if (!existsSync(legacyPath)) return false
  if (queryLockHeld(legacyPath, { isProcessAlive: isAlive ?? defaultIsProcessAlive })) return true
  rmWithRetryQuiet(legacyPath)
  return false
}

/** 状态查询（测试用）：该闸当前是否被持有。 */
export function isTaskGateHeld(bookName: string, action: string): boolean {
  return isHeldIn(processState, bookName, action)
}

function isHeldIn(state: GateState, bookName: string, action: string): boolean {
  return state.running.has(keyOf(bookName, action))
}

/**
 * 该书当前被持有的全部任务闸（action 名列表，字典序——文案稳定）。
 * dd-P2：删书/改名前拒收——分钟级 AI 任务（analyze/rewrite/outline/rag-build 等）
 * 无 abort 通道，带着跑会让旧目录被收尾落盘重建 + 白烧 API 费用；入口拒 409 最省。
 * T2-4 注：只反映本进程持有（进程内 Set）；跨进程持有由锁文件体现，不在此列表
 * （删书闸本就要求任务与删书同进程才有 abort 收尾问题，跨进程场景交由真锁 J7 收口）。
 * R75-5（批 D）收口：跨进程面已由下方 crossProcessHeldTaskGatesFor 补齐（allHeldTaskGatesFor
 * 合并两侧后判 409）；本函数保持纯进程内语义（audit/stream/graceful-shutdown 等
 * 调用方只关心本进程编排态）。
 */
export function heldTaskGatesFor(bookName: string): string[] {
  return heldIn(processState, bookName)
}

function heldIn(state: GateState, bookName: string): string[] {
  const actions: string[] = []
  for (const key of state.running) {
    const i = key.indexOf(SEP)
    if (i !== -1 && key.slice(i + SEP.length) === bookName) actions.push(key.slice(0, i))
  }
  return actions.sort()
}

// ── R75-5（批 D）：跨进程持闸查询（只读扫描）────────────────────────

/** R75-5：跨进程查询注入项（语义同 TaskGateOptions 对应字段）。 */
interface CrossProcessQueryOptions {
  /** 显式锁目录（测试注入用）；缺省用模块级 lockRoot。 */
  lockDir?: string | null
  /** 进程存活判定（测试注入用）；缺省 process.kill(pid,0) 探测（与锁原语同源）。 */
  isProcessAlive?: (pid: number) => boolean
}

/**
 * R75-5（批 D）：该书当前被**其他进程**持有的任务闸（action 名列表，字典序）——扫任务
 * 闸锁文件目录，按新格式名 `${action}.${hash(book)}.lock` 反解本书记录，陈锁判定复用锁
 * 原语语义（queryLockHeld：死 pid / 活 pid 超龄无续期 / 超龄半写均不算在持——勿把崩溃
 * 残留陈锁算成在持导致删书/改名被永久 409）。只读扫描、不取锁、不清理。
 *
 * R0916-7-P3-14：旧实现的「KNOWN_ACTIONS/GATED_ACTIONS 注册表 + 逐格哈希探测」随文件名
 * 自描述而删——列目录即得持有者，新增闸占用点无需登记。迁移边界（如实记）：旧格式名
 * 只含 key 哈希、不含书信息，无法归属到书，故**不在本枚举面内**（混合版本运行期间旧版
 * 进程的在途闸对本查询不可见）；双持由 acquireTaskGate 的旧名探测阻断（单侧不双持），
 * 旧残留由启动清扫收口。
 *
 * 背景：dev-api/脚本与 GUI 多进程并存时，进程 B 的 DELETE/RENAME 书此前只查进程 A
 * 看不见的进程内 Set——分钟级任务（analyze/outline/rag-build/review…）在途时放行
 * 删/改，收尾原子写会在旧路径重建孤儿目录并白烧 API 费。allHeldTaskGatesFor 将本函数与
 * heldTaskGatesFor 合并去重后判 409（本进程闸在锁目录里也有锁文件，去重防双报）。
 * 锁目录不可读/未配置 → 返回空（退化旧纯内存行为，fail-open 与 lockRoot=null 同口径）。
 */
export function crossProcessHeldTaskGatesFor(bookName: string, opts?: CrossProcessQueryOptions): string[] {
  return crossProcessHeldIn(processState, bookName, opts)
}

function crossProcessHeldIn(state: GateState, bookName: string, opts?: CrossProcessQueryOptions): string[] {
  const dir = opts?.lockDir !== undefined ? opts.lockDir : state.lockRoot
  if (!dir) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return [] // 目录不存在（书库从未有过跨进程闸）/不可读——无在持
  }
  const isAlive = opts?.isProcessAlive ?? defaultIsProcessAlive
  // 本书标签段（含前导 '.'）；action 段 = 去掉后缀的余串，含 '.' 的名（旧格式等）自然落选
  const suffix = `.${bookTag(bookName)}.lock`
  const actions: string[] = []
  for (const name of names) {
    if (!name.endsWith(suffix)) continue
    const action = name.slice(0, -suffix.length)
    if (!action || action.includes('.')) continue
    if (queryLockHeld(join(dir, name), { isProcessAlive: isAlive })) actions.push(action)
  }
  return actions.sort()
}

/**
 * R29-9（二十九轮）：任务闸「进程内 + 跨进程」合并查询——books.ts busyGate（R75-5）
 * 同口径。heldTaskGatesFor 只看进程内 Set，双进程形态（dev-api/脚本与 GUI 并存）下
 * B 进程分钟级任务在途时，A 进程的删/改名/清库/写端点看不见该闸，放行后任务收尾继续
 * 写已删路径或已清 session。Set 去重防本进程闸两侧双报；两侧各自已排序，合并后再排一次
 * 保证文案里的动作清单稳定（不随目录顺序/Set 插入顺序抖动）。
 *
 * R0916-7-P3-12：原在 audit.ts（因「模式三处重复」而就近落点），本批迁回本模块——
 * audit.ts 与 stream.ts 互相 import 的环（audit 取 stream 的 isSpawnRunning、stream 取
 * audit 的 allHeldTaskGatesFor）随之解开，忙闸查询与忙闸判定同居单源。
 */
export function allHeldTaskGatesFor(bookName: string): string[] {
  return allHeldIn(processState, bookName)
}

function allHeldIn(state: GateState, bookName: string): string[] {
  return [...new Set([...heldIn(state, bookName), ...crossProcessHeldIn(state, bookName)])].sort()
}

// ── R0916-7-P3-12：三审运行登记（book + docId）────────────────────────

/** 三审运行登记：键 = bookName + NUL + docId。原 review.ts 私有 Set 整表迁入本模块——
 *  忙闸矩阵的 review 信号（列）要按书判定在途三审，而 review.ts → task-gate.ts 是既有
 *  单向依赖（三审占 'review' 闸经本模块取），登记留在 review.ts 会让矩阵反向依赖成环。
 *  进程内语义、键格式与判据逐位不变；按文档维度的闸（review-verdict 竞窗、三审端点自身）
 *  走 isReviewRunningForDoc/tryHoldReviewRun。R0916-7-P3-6：随闸状态入实例。 */

/** 二轮复审（低级）：三审运行闸组键（NUL 分隔，书名/文档 ID 任一含 '/' 时前缀匹配理论
 *  可误报；NUL 不可能出现在两侧实值里——书名净化 + docId 为生成哈希）。 */
function reviewRunKey(bookName: string, docId: string): string {
  return `${bookName}${SEP}${docId}`
}

/** hh-P1：本书任一文档三审在跑（删书/改名/清库/写端点反向互斥用）——三审是分钟级长任务，
 *  闸内放行删书/改名会在旧路径重建孤儿目录并白烧 API 费用（与 spawn/task-gate 同模式）。 */
export function isReviewRunningForBook(bookName: string): boolean {
  return isReviewRunningForBookIn(processState, bookName)
}

function isReviewRunningForBookIn(state: GateState, bookName: string): boolean {
  const prefix = bookName + SEP
  for (const k of state.reviewRunning) if (k.startsWith(prefix)) return true
  return false
}

/** 该文档三审在跑（三审端点自身并发闸 + review-verdict 完成写竞窗闸）。 */
export function isReviewRunningForDoc(bookName: string, docId: string): boolean {
  return processState.reviewRunning.has(reviewRunKey(bookName, docId))
}

/** 占「按文档三审运行」登记：false = 该文档三审已在跑（调用方 409 不排队）。 */
export function tryHoldReviewRun(bookName: string, docId: string): boolean {
  return tryHoldReviewRunIn(processState, bookName, docId)
}

function tryHoldReviewRunIn(state: GateState, bookName: string, docId: string): boolean {
  const key = reviewRunKey(bookName, docId)
  if (state.reviewRunning.has(key)) return false
  state.reviewRunning.add(key)
  return true
}

/** 放「按文档三审运行」登记（幂等；成功/失败/中断三路必达）。 */
export function releaseReviewRun(bookName: string, docId: string): void {
  processState.reviewRunning.delete(reviewRunKey(bookName, docId))
}

/** 测试钩子（同 stream.ts __setSpawnRunning 先例）：不经真实三审直接置/清本书运行闸，
 *  供 books 删书/改名 409 接线测用。可选 docId（缺省 '__test__'）——review-verdict 竞窗
 *  闸按真实文档 docId 查闸，须能预置到具体文档键上；用例负责同参清理。
 *  R0916-7-P3-12：随登记表迁入本模块（原 review.ts 导出面同批改指向）。 */
export function __setReviewRunning(bookName: string, running: boolean, docId = '__test__'): void {
  if (running) processState.reviewRunning.add(reviewRunKey(bookName, docId))
  else processState.reviewRunning.delete(reviewRunKey(bookName, docId))
}

// ── R0916-7-P3-12：忙闸互斥矩阵（行 = 请求方意图，列 = 在途活动信号）─────────────

/** 在途活动信号（矩阵的「列」）——每格谓词见 signalClause 单源。 */
export type BusySignal =
  /** self-heal 全自动写章编排在途 */
  | 'self-heal'
  /** 对话编排在途（含嵌套生成工具） */
  | 'chat'
  /** 手动写稿（/spawn）在途 */
  | 'spawn'
  /** 本书任一任务闸被持（含跨进程锁文件面） */
  | 'task-gate'
  /** 本书任一文档三审在途 */
  | 'review'
  /** 后台收尾任务（定稿摘要/账本草稿等）在途 */
  | 'background'

/** 请求方意图（矩阵的「行」）= 端点要启动的动作；决定查哪些列、按什么次序、尾句说什么。 */
export type BusyIntent =
  /** POST /spawn 手动写稿 */
  | 'spawn'
  /** POST /auto-write 全自动写章 */
  | 'auto-write'
  /** chat.send / chat.regenerate 对话 */
  | 'chat'
  /** 生成类长任务（outline/analysis/rewrite/onboard-ai/relations-mine/lead-updates/rag/prune…） */
  | 'generate'
  /** 章节结构操作（structure-plan/apply、merge-undo） */
  | 'structure'
  /** 删书 */
  | 'book-delete'
  /** 改名 */
  | 'book-rename'
  /** 清空对话（chat/clear） */
  | 'clear-chat'
  /** 清除事件史（DELETE /audit） */
  | 'clear-events'
  /** 三审（documents/:docId/review） */
  | 'review'

/** 信号侧子句单源（矩阵的「列」文案）：同一在途活动在所有意图下同一句开头，句读统一
 *  全角（P3-12 前 stream.ts 同一句一处半角一处全角）。$ACTIONS = 持闸动作清单占位。 */
const SIGNAL_TEXT: Record<BusySignal, string> = {
  'self-heal': '本书正在全自动写章，先等它跑完或中断',
  chat: '本书对话进行中，先等它结束或中断',
  spawn: '本书正在手动写稿，先等它跑完或中断',
  'task-gate': '本书有任务在跑（$ACTIONS），先等它完成或中断',
  review: '本书三审进行中，先等它完成',
  background: '本书有后台任务收尾中（如定稿摘要），稍等片刻',
}

/** 意图侧尾句单源：告诉作者「等完之后本来想做什么」。 */
const INTENT_TAIL: Record<BusyIntent, string> = {
  spawn: '再手动写稿',
  'auto-write': '再自动写章',
  chat: '再对话',
  generate: '再生成',
  structure: '再做结构操作',
  'book-delete': '后再删',
  'book-rename': '后再改名',
  'clear-chat': '后再清空对话',
  'clear-events': '后再清除事件史',
  review: '再发起三审',
}

/** 「同书另一次三审在跑」的文案单源——三审端点占 (book,'review') 闸失败时回它。
 *  为什么不做成矩阵格：那是**同 action 自冲突**（同一本书同时只跑一次三审——三审 ctrl 以
 *  `review:<书名>` 单 owner 槽登记，两个文档并发会互相 abort），由 per-action 闸本体承担；
 *  矩阵只表达跨活动互斥（列 = 别人在跑什么）。P3-12 前这句写的是「本书有其他任务在跑」——
 *  按 (book,'review') 取键的闸只可能被同书另一次三审占住，文案与成因不符，现点名。 */
export const REVIEW_BUSY_TEXT = '本书已有三审在跑（同一本书同时只跑一次三审），先等它完成后再发起'

interface BusyCell {
  signal: BusySignal
  /** 整句覆盖：仅语义特殊的格子用（自身面文案）；缺省 = 子句 + 尾句。 */
  text?: string
}

/** 忙闸互斥矩阵单源：行 = 意图，列 = 信号；**表内顺序即判定顺序**（首命中即返回），
 *  缺格 = 该端点有意不查该活动（不是漏，改表前先读两侧沿革）。
 *
 *  各行的沿革（顺序逐位保留自原手写实现，P3-12 只收敛不重排）：
 *  - spawn：自身闸先于交叉闸（写手在途的自查文案最贴切）；self-heal/chat 反向互斥
 *    R-9/AI-1；task-gate R71-1（outline 等分钟级任务与草稿覆写互踩）；review R71-1
 *    （三审在途覆写正文 → 审稿单 draft_hash 必失配）。
 *  - auto-write：self-heal 自查 → chat（M-2/R-9 预算章块互覆）→ spawn（双写手覆草稿）
 *    → task-gate（收尾覆盖写细纲/账本，后续章拿混合态上下文）。首查与 await 后复检
 *    同表（复检仍是同一单源的一次调用，不是第二份手写闸）。
 *  - chat：self-heal → spawn → task-gate，均带 R76-12 嵌套豁免（chat 自己的 write_chapter
 *    在途时 isSelfHealRunning 为真而闸是本会话工具持的，原样 409 会把作者的 steer 追加话
 *    拒之门外）；regenerate 的 readJson 后中段复检历史上只查编排两闸（taskGate:false）。
 *  - generate：orchestrationBusyFor 原表——self-heal/chat/spawn 覆盖写其输入文件（细纲/
 *    账本推进.md 是写稿上下文注入源）→ 后台收尾。task-gate/review 有意不在列：生成类
 *    端点各自占自身 action 闸，跨生成类并发是既定面（R67-13 只管写稿系 × 生成系）。
 *  - structure：self-heal/spawn 单独文案 → chat/background（编排面）→ review。task-gate
 *    不在列：'structure' 闸由调用方在守卫之后另占（占闸点保持各站原位原样）。
 *  - book-delete/book-rename：spawn → review → task-gate（三闸都无 abort 通道，带着跑会
 *    让收尾写旧路径重建孤儿目录；闸后 abort 编排才是合法中断，R32-6 闸序）。
 *  - clear-chat/clear-events：chat 在跑则清不彻底（任务收尾事件复活到已清 session）→
 *    task-gate → self-heal → review → background → spawn（重评二轮-P3-2 六闸收编时的序）。
 *  - review：编排四面（写稿中发起三审 → 草稿漂移 → 审稿单不成立白烧费用，R74-20）。
 *    本行**有意不含 review 列**：同书另一次三审属同 action 自冲突，由 (book,'review') 闸
 *    本体拦（文案 REVIEW_BUSY_TEXT，见其注）；且端点内按文档闸先于书级闸，同文档重复点击
 *    拿的仍是文档级文案 REVIEW_RUNNING。P3-12 前该处写「本书有其他任务在跑」——按
 *    (book,'review') 取键只可能与同书另一次三审冲突，文案与成因不符，本批修正。
 *  另：matrix 不查「任意任务闸被持」给 book-delete 之外的正向自由面（例如 outline 在途
 *  时仍可 review）是现状语义，本批不改。 */
const BUSY_MATRIX: Record<BusyIntent, ReadonlyArray<BusyCell>> = {
  spawn: [
    { signal: 'spawn', text: '本书正在生成（手动写稿），先等它跑完或中断' },
    { signal: 'self-heal' },
    { signal: 'chat' },
    { signal: 'task-gate' },
    { signal: 'review' },
  ],
  'auto-write': [{ signal: 'self-heal' }, { signal: 'chat' }, { signal: 'spawn' }, { signal: 'task-gate' }],
  chat: [{ signal: 'self-heal' }, { signal: 'spawn' }, { signal: 'task-gate' }],
  generate: [{ signal: 'self-heal' }, { signal: 'chat' }, { signal: 'spawn' }, { signal: 'background' }],
  structure: [
    { signal: 'self-heal' },
    { signal: 'spawn' },
    { signal: 'chat' },
    { signal: 'background' },
    { signal: 'review' },
  ],
  'book-delete': [{ signal: 'spawn' }, { signal: 'review' }, { signal: 'task-gate' }],
  'book-rename': [{ signal: 'spawn' }, { signal: 'review' }, { signal: 'task-gate' }],
  'clear-chat': [
    { signal: 'chat' },
    { signal: 'task-gate' },
    { signal: 'self-heal' },
    { signal: 'review' },
    { signal: 'background' },
    { signal: 'spawn' },
  ],
  'clear-events': [
    { signal: 'chat' },
    { signal: 'task-gate' },
    { signal: 'self-heal' },
    { signal: 'review' },
    { signal: 'background' },
    { signal: 'spawn' },
  ],
  review: [{ signal: 'self-heal' }, { signal: 'chat' }, { signal: 'spawn' }, { signal: 'background' }],
}

/** 逐次调用的格过滤（只影响「查哪些格」，不动表格与文案）：
 *  chat 家族的两处历史语义靠它保真——R76-12 嵌套写章豁免（skip self-heal/task-gate）、
 *  R32-7 regenerate 中段复检只看编排两闸（skip task-gate）。 */
export interface BusyReasonOptions {
  skip?: readonly BusySignal[]
}

/** 信号谓词单源：命中返回该列子句（task-gate 列带持闸动作清单），未命中 null。 */
function signalClause(state: GateState, signal: BusySignal, book: string): string | null {
  switch (signal) {
    case 'self-heal':
      return isSelfHealRunning(book) ? SIGNAL_TEXT['self-heal'] : null
    case 'chat':
      return isChatRunning(book) ? SIGNAL_TEXT.chat : null
    case 'spawn':
      return isSpawnRunning(book) ? SIGNAL_TEXT.spawn : null
    case 'review':
      return isReviewRunningForBookIn(state, book) ? SIGNAL_TEXT.review : null
    case 'background':
      return hasBackgroundTasks(book) ? SIGNAL_TEXT.background : null
    case 'task-gate': {
      const held = allHeldIn(state, book)
      return held.length > 0 ? SIGNAL_TEXT['task-gate'].replace('$ACTIONS', held.join('、')) : null
    }
  }
}

/**
 * 忙闸判定单源（P3-12）：输入「书 + 意图」，输出 null（放行）或 409 的人话文案。
 * 各端点入口只调本函数一次（首检/await 后复检是同一次调用的两处落点）；文案 = 命中列的
 * 子句 + 意图尾句（个别格整句覆盖），句读统一全角。
 */
export function busyReason(book: string, intent: BusyIntent, opts?: BusyReasonOptions): string | null {
  return busyReasonIn(processState, book, intent, opts)
}

function busyReasonIn(state: GateState, book: string, intent: BusyIntent, opts?: BusyReasonOptions): string | null {
  for (const cell of BUSY_MATRIX[intent]) {
    if (opts?.skip?.includes(cell.signal)) continue
    const clause = signalClause(state, cell.signal, book)
    if (clause === null) continue
    return cell.text ?? `${clause}${INTENT_TAIL[intent]}`
  }
  return null
}

/**
 * R67-13（十五轮）：编排互斥矩阵补角。写稿系编排（self-heal 写章 / 对话在途 / 后台
 * 收尾任务）与覆盖写其输入文件的生成长任务（细纲/账本推进/onboard/风格分析）此前
 * 只有 per-action 的 acquireTaskGate（同 action 互斥，不跨类）：self-heal 在途时仍可
 * 并发生成细纲/账本草稿——细纲与账本恰是写稿的上下文注入源，覆盖写落盘 = self-heal
 * 后续章拿到混合态上下文（双费 + 机检误报红可触发多余重写；原子写保证无数据损坏）。
 * 生成类端点入口先查本闸再占自身 action 闸；在途 → 409 BUSY（与删书 busyGate 同口径）。
 * R74-3（二十二轮）：补 spawn 面（手动写稿在途同样覆写上下文）。
 *
 * R0916-7-P3-12：实现改为矩阵 'generate' 行的薄别名（文案随之统一：self-heal 列由
 * 「本书自愈写稿进行中，等它完成后再生成（防写稿上下文被覆盖写混态）」改为全库统一
 * 句；防混态的成因留在矩阵行注释里，不再进作者可见文案）。导出面保留——调用点遍布
 * rag/snapshots/documents-structure/review 与 runGatedGeneration 包装。
 */
export function orchestrationBusyFor(bookName: string): string | null {
  return busyReason(bookName, 'generate')
}

// ── 复审-0914-优化修复批（P1-2/D4）：长任务门控 handler 高阶包装 ─────────────
// 「orchestrationBusyFor → acquireTaskGate → getDriver → ensureSession → new
// AbortController → driver.registerCtrl(session, ctrl, `action:${book}`) →
// finally{unregisterCtrl+release}」十段此前在 9+ 个生成长任务端点逐字复制
// （analysis ×4 / rewrite / outline / settings(relations-mine) / lead-updates /
// onboard-ai；RB-SV-P2-2 立闸、R0912-P2-① 接中断通道、R67-13 接编排互斥——三批
// 沿革各自复制成 ten-fold）。本包装收编为单源，端点改薄调用：
//
// 时序契约（与各端点原实现逐位一致）：
//   ① busyReason(book,'generate') 预检（R67-13；R0916-7-P3-12 前为 orchestrationBusyFor）
//     → 409 BUSY（文案即闸返回的人话）；
//   ② acquireTaskGate（RB-SV-P2-2）→ 占不上 409 BUSY busyText（各端点专用文案
//     逐字保留）；
//   ③ ensureSession → 新 ctrl → driver.registerCtrl（R0912-P2-①；owner 分槽
//     `${action}:${book}`——同 action 重入已被任务闸 409 挡住，串行换新安全，
//     跨书/跨端点互不误伤；onboard-ai 的历史字面量 'onboard:<书名>' 经
//     ownerLabel 逐位保留）；
//   ④ fn(ctrl) 执行端点主体（响应在 fn 内经 reply/replyError 发出）；
//   ⑤ finally 统一 unregisterCtrl + release（成功/失败/中断三路必达；ensureSession
//     失败未注册时跳过注销，cc X-P2-11 口径）。
//
// R0916-7-P3-14：包装内的 acquireTaskGate 调用点已无「注册表登记」义务（锁名自描述），
// 原 KNOWN_ACTIONS/GATED_ACTIONS 两表与两份静态对账测试同批删除；剩余纪律 = action
// 字面量须为文件名安全 token（含 '.' 会让枚举解析歧义），机器门见
// test/governance/known-actions-audit.test.ts。

interface GatedGenerationOptions {
  /** 书名（闸键 / ensureSession / owner 标签）。 */
  book: string
  /** workDir（ensureSession 实参；调用方 handler 已 resolveBook 成功，非 null）。 */
  workDir: string
  /** 任务闸 action（文件名安全 token；新增调用点的字面量受治理门扫描）。 */
  action: string
  /** 闸被持时 409 BUSY 的人话文案（各端点原文逐字保留）。 */
  busyText: string
  /** driver ctrl owner 标签；缺省 `${action}:${book}`（onboard-ai 传 'onboard' 保历史字面量 'onboard:<书名>'）。 */
  ownerLabel?: string
}

// ── R0916-7-P3-16：中断通道 = driver 契约必需成员（收尾）────────────────────

/** 中断通道收口沿革：P3-16 前半条（批 2）曾在本文件以结构类型 + resolveInterruptChannel
 *  把「可中断」从 StudioDriver 的可选成员里显式解析（缺能力 → log.warn 带 action@book
 *  留痕的显式降级）。收尾批（必需能力接口）把 registerCtrl/unregisterCtrl 随全族提为
 *  `driver/types.ts` 的**必需成员**——「缺实现」在编译期不可表达，本文件的结构探测、
 *  warn 档与 InterruptChannel 中间面一并删除，注册/注销直调注入宿主的能力面
 *  （mock 的「不支持中断」以显式 no-op 声明，见 mock.ts；运行时语义逐位不变）。 */

/**
 * 生成长任务端点的门控包装（busy 预检 → 任务闸 → 中断通道注册 → fn → finally 注销释放）。
 * fn 内完成端点主体（readJson/校验/AI 调用/落盘/响应），中断收口经 replyGenerationFailure。
 *
 * R0916-7-P3-6：driver 与会话面改由组装根经 DriverHost 注入（原直调 getDriver()/
 * ensureSession 的进程单例），实现体收在闸实例上（runGatedGenerationIn），模块级
 * 同名导出保留为进程默认实例的委托壳。
 */
export async function runGatedGeneration(
  res: ServerResponse,
  opts: GatedGenerationOptions,
  fn: (ctrl: AbortController) => Promise<void>,
): Promise<void> {
  return runGatedGenerationIn(processState, processDriver, res, opts, fn)
}

async function runGatedGenerationIn(
  state: GateState,
  host: DriverHost,
  res: ServerResponse,
  opts: GatedGenerationOptions,
  fn: (ctrl: AbortController) => Promise<void>,
): Promise<void> {
  // R67-13（十五轮）：编排互斥矩阵补角——写稿系编排在途（self-heal/对话/手动写稿/
  // 后台收尾）时拒收生成长任务（细纲/账本是写稿上下文注入源，在途覆盖写 = 混合态上下文）
  const busyOrch = busyReasonIn(state, opts.book, 'generate')
  if (busyOrch) return replyError(res, 409, 'BUSY', busyOrch)
  // RB-SV-P2-2：长任务并发闸（分钟级 AI 任务，重复点击=双倍费用）
  const release = acquireIn(state, opts.book, opts.action)
  if (!release) return replyError(res, 409, 'BUSY', opts.busyText)
  // R0912-P2-①（2026-09-11 重评-0911c 修复批）：接入中断通道——接法照抄 stream.ts
  // spawn/self-heal 的 register/unregister 形态：编排段新建 ctrl → driver.registerCtrl
  // → settle（外层 finally）统一注销。实现移位：复审-0914-优化修复批（P1-2）十段
  // 复制收编本包装；owner 分槽语义与 ctrl 注册名逐位保留。
  // R0916-7-P3-16 收尾：中断通道是 StudioDriver 必需成员（driver/types.ts），直调
  // 注入宿主——原 resolveInterruptChannel 的「缺能力 → warn 留痕」降级档随必需化删除。
  let registeredSession: Session | null = null
  let registeredCtrl: AbortController | null = null
  try {
    const session = await host.ensureSession(opts.book, opts.workDir)
    registeredSession = session
    const ctrl = new AbortController()
    host.driver.registerCtrl(session, ctrl, opts.ownerLabel ?? `${opts.action}:${opts.book}`)
    registeredCtrl = ctrl
    await fn(ctrl)
  } finally {
    // R0912-P2-①：settle（成功/失败/中断）统一注销——isRunning 归 false（cc X-P2-11 口径）；
    // ensureSession 失败（未注册）时跳过
    if (registeredCtrl && registeredSession) host.driver.unregisterCtrl(registeredSession, registeredCtrl)
    release()
  }
}

/**
 * D4（复审-0914-优化修复批）：生成失败的状态映射单源——NO_* 族（NO_USERDATA/
 * NO_PROVIDER/NO_MODEL 等配置缺失，客户端可处置）→ 400；ABORTED（用户中断，请求
 * 被取消语义）→ 499；其余（GEN_FAIL/TIMEOUT_TOTAL/EMPTY_OUTPUT 等）→ 500。
 * code/error 一律透传（R43-24 透传口径：错误文案不变，信封 {code,error} 形状不变）。
 * analysis 族（runAnalyst/runOnboard 已把配置缺失坍缩 GEN_FAIL，无 NO_* 码面）与
 * rewrite/outline（透传码）共用；settings relations-mine 的文案变体（ABORTED 固定
 * 「已中断」、其余组装「AI 梳理失败:…」）经形状归一后仍走本单源映射。
 */
export function replyGenerationFailure(
  res: ServerResponse,
  fail: { ok: false; code: string; error: string },
): void {
  if (fail.code.startsWith('NO_')) return replyError(res, 400, fail.code, fail.error)
  if (fail.code === 'ABORTED') return replyError(res, 499, fail.code, fail.error)
  replyError(res, 500, fail.code, fail.error)
}

// ── R0916-7-P3-6：闸实例（组装根注入面）──────────────────────────────────

/**
 * 组装根注入面：一个闸实例 = 一份「锁根 + 进程内闸表 + 三审登记表」。
 *
 * 所有权：调用方（服务端组装根）创建并持有；同一进程内建两个实例即两套互不可见的
 * 闸（本项的可测判据）。消费方（路由 handler）经 ctx.gate 使用，不自行取模块级壳。
 */
export interface TaskGate {
  /** 配锁根（组装期一次；见 configureLockRootIn 契约） */
  configureLockRoot(dir: string | null): void
  acquire(bookName: string, action: string, opts?: TaskGateOptions): (() => void) | null
  isHeld(bookName: string, action: string): boolean
  heldFor(bookName: string): string[]
  crossProcessHeldFor(bookName: string, opts?: CrossProcessQueryOptions): string[]
  allHeldFor(bookName: string): string[]
  isReviewRunningForBook(bookName: string): boolean
  isReviewRunningForDoc(bookName: string, docId: string): boolean
  tryHoldReviewRun(bookName: string, docId: string): boolean
  releaseReviewRun(bookName: string, docId: string): void
  busyReason(book: string, intent: BusyIntent, opts?: BusyReasonOptions): string | null
  /** 生成长任务门控包装（R67-13 编排互斥 + 任务闸 + 中断通道，见实现体头注） */
  runGatedGeneration(res: ServerResponse, opts: GatedGenerationOptions, fn: (ctrl: AbortController) => Promise<void>): Promise<void>
}

/** 闸实例依赖：锁根（workDir 缺省 → null）与 driver 宿主（会话面 + 中断通道解析）。 */
export interface TaskGateDeps {
  lockRoot: string | null
  driver: DriverHost
}

/** 路由 ctx 的闸注入面（各端点 ctx 组合本接口即可拿到本实例的闸）。 */
export interface TaskGateInjected {
  readonly gate: TaskGate
}

export function createTaskGate(deps: TaskGateDeps): TaskGate {
  return createTaskGateOnState(newGateState(deps.lockRoot), deps.driver)
}

/** 实例构造（状态外部传入——进程默认实例要与模块级委托壳共享同一份状态）。 */
function createTaskGateOnState(state: GateState, driver: DriverHost): TaskGate {
  return {
    configureLockRoot: (dir) => configureLockRootIn(state, dir),
    acquire: (bookName, action, opts) => acquireIn(state, bookName, action, opts),
    isHeld: (bookName, action) => isHeldIn(state, bookName, action),
    heldFor: (bookName) => heldIn(state, bookName),
    crossProcessHeldFor: (bookName, opts) => crossProcessHeldIn(state, bookName, opts),
    allHeldFor: (bookName) => allHeldIn(state, bookName),
    isReviewRunningForBook: (bookName) => isReviewRunningForBookIn(state, bookName),
    isReviewRunningForDoc: (bookName, docId) => state.reviewRunning.has(reviewRunKey(bookName, docId)),
    tryHoldReviewRun: (bookName, docId) => tryHoldReviewRunIn(state, bookName, docId),
    releaseReviewRun: (bookName, docId) => state.reviewRunning.delete(reviewRunKey(bookName, docId)),
    busyReason: (book, intent, opts) => busyReasonIn(state, book, intent, opts),
    runGatedGeneration: (res, opts, fn) => runGatedGenerationIn(state, driver, res, opts, fn),
  }
}

/** 进程默认实例：模块级委托壳（acquireTaskGate/heldTaskGatesFor/…）的状态归属。
 *  为什么保留：非路由消费方不在本批改动面（desktop/graceful-shutdown.ts 的退出前
 *  「等闸释放」、ai/orchestrate/task-gate-port.ts 的 chat 工具取闸注册面、review.ts 的
 *  启动期 sweepStaleReviewDirs），它们按模块级函数取用；生产组装（startServer）把
 *  本实例交给 server，故两侧看到同一份闸表。 */
const processState = newGateState(null)
const processDriver: DriverHost = productionDriverHost()
const processGate = createTaskGateOnState(processState, processDriver)

/** 进程默认闸实例（生产组装根取用；测试要隔离闸表请自行 createTaskGate）。 */
export function processTaskGate(): TaskGate {
  return processGate
}
