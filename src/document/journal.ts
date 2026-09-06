/**
 * 恢复 journal（W0-1 §7）—— 防丢字资产。
 *
 * 保存协议每步写 pending（含全文快照），落盘后追加 settled。崩溃后扫
 * 「有 pending 无 settled」的 opId 提示作者恢复。
 *
 * 追加写（appendFileSync + fsync），**不用 atomicWriteFile**——整文件替换会
 * O(n²) 且重写窗口崩了丢全历史；追加一行最多损坏末行，恢复扫描本就逐行容错。
 *
 * 膨胀治理（U-P2-9）：pending 含全文快照，日写一章 journal 线性涨 ~2MB。
 * settle/abort 后超过阈值触发 compact——只保留未结算 pending（崩溃恢复唯一
 * 依赖），已结算行整段丢弃；原子替换，压缩窗口崩溃则原文件不动，无净损失。
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { tryAcquireCrossProcessLock, acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { log } from '../log/index.js'
import { dirname } from 'node:path'
import { ulid } from './stable-id.js'
import { atomicWriteFile } from '../fs/atomic.js'
import type { Revision } from './revision.js'

export interface JournalPending {
  opId: string
  docId: string
  baseRevision: Revision
  ts: string
  status: 'pending'
  content: string // 发起时的全文快照（防丢字）；降级落盘行为头尾截断快照（R53-D-2，原为 ''）
  /** R31-21（三十一轮）：true = 本行在跨进程锁超时后降级裸写、快照经截断收敛行长——
   *  大快照 append 超文件系统原子窗，双进程同拍降级可交错损坏（坏行被
   *  findUnsettled 容错跳过 → 恢复失据）。恢复消费方只读 opId（state 健康
   *  扫描）不受截断快照影响。
   *  PM-3（性能与内存专项）：快照超 JOURNAL_PENDING_SNAPSHOT_MAX_BYTES 的主动
   *  降级同置本位（同样行短；见 appendPending 注释）。
   *  R53-D-2（五十三轮）：降级快照从整段剥离（content:''）改为保头尾截断
   *  （truncateSnapshotHeadTail）——空快照使崩窗内新内容零盘上副本（版本历史
   *  只含已保存部分，磁盘是保存前旧文，「编辑永不静默丢失」红线在降级窗失守）；
   *  截断后头部正文与尾部最新键入随行落盘，作者恢复有迹可考。 */
  degraded?: boolean
}

/** 移动/重命名 pending（P3-10：rename 与清单更新之间的非原子窗口兜底）。
 *  内容不变仅路径变——恢复是确定性的（按磁盘现状收口清单），无需作者决断。 */
export interface JournalMovePending {
  opId: string
  docId: string
  ts: string
  status: 'pending'
  kind: 'move'
  oldPath: string
  newPath: string
}

export interface JournalSettled {
  opId: string
  ts: string
  status: 'settled'
  newRevision: `sha256:${string}`
}

export interface JournalAborted {
  opId: string
  ts: string
  status: 'aborted'
  reason: string
}

export type JournalEntry = JournalPending | JournalMovePending | JournalSettled | JournalAborted

/** 未结算 pending（保存类或移动类）——恢复方按 kind 分流处理。 */
export type JournalAnyPending = JournalPending | JournalMovePending

/** 类型守卫：JournalPending（保存类）无 kind 字段，联合上取 kind 须经此收窄。 */
export function isMovePending(p: JournalAnyPending): p is JournalMovePending {
  return (p as JournalMovePending).kind === 'move'
}

type RawLine = { [k: string]: unknown }

/** R53-D-2（五十三轮）：降级快照头尾截断——超 2×keepBytes 的快照保头（正文开头）
 *  尾（崩溃前最新键入）各 keepBytes，中段以省略标记替代；≤ 2×keepBytes 原样返回
 *  （小快照锁超时降级不再无谓剥离——R31-21 的原子窗顾虑只在兆级行）。
 *  切点按 UTF-8 续字节（0b10xxxxxx）回退到字符首字节，不劈多字节字符；降级行
 *  JSON.parse 后 content 仍是合法 string（findUnsettled 字段校验兼容）。 */
function truncateSnapshotHeadTail(content: string, keepBytes: number): string {
  const buf = Buffer.from(content, 'utf-8')
  if (buf.length <= keepBytes * 2) return content
  const adjustBack = (i: number): number => {
    while (i > 0 && (buf[i]! & 0xc0) === 0x80) i--
    return i
  }
  const headEnd = adjustBack(keepBytes)
  const tailStart = adjustBack(buf.length - keepBytes)
  if (tailStart <= headEnd) return content // 防御：不可能（已过 2×keepBytes 闸）
  return (
    buf.subarray(0, headEnd).toString('utf-8') +
    `\n…〔快照超长已截断：中段 ${tailStart - headEnd} 字节未随行保存，全文以磁盘现状/版本历史为准〕…\n` +
    buf.subarray(tailStart).toString('utf-8')
  )
}

/** 追加 pending 行（含全文快照）。返回 opId 供后续 appendSettled 配对。 */
export async function appendPending(
  journalPath: string,
  docId: string,
  baseRevision: Revision,
  content: string,
): Promise<string> {
  const entry: JournalPending = {
    opId: ulid(),
    docId,
    baseRevision,
    ts: new Date().toISOString(),
    status: 'pending',
    content,
  }
  // R31-21（三十一轮）：锁超时降级收敛行长——降级行经 truncateSnapshotHeadTail 截断
  // （≤ 2×KEEP + 标记 ≈64KB，回原子窗内；R31-21 的交错损坏顾虑只在兆级行），不再
  // 整段剥离。R53-D-2（五十三轮）：content:'' 使崩窗内新内容零盘上副本——版本历史
  // 只含已保存部分、磁盘是保存前旧文，降级窗「编辑永不静默丢失」失守；截断保头
  // （正文开头）尾（最新键入），作者恢复有迹可考。
  const degradedFallback = JSON.stringify({
    ...entry,
    content: truncateSnapshotHeadTail(content, journalDegradedKeepBytes),
    degraded: true,
  })
  // PM-3（性能与内存专项·2026-09-05）：超大快照主动降级——快照超阈值时直接落降级行
  // （与锁超时同款 degraded:true 形态），不再追加全文。动因：恢复消费方
  // （state.ts assembleStatus）只读 opId——pending.content 全仓零程序性消费方（R31-21
  // 已实证），作者侧恢复路径是版本历史/磁盘现状；而全量快照进 journal 的代价是每笔
  // 保存 IO 翻倍（大章 2MB 快照 = 正文写 2MB + journal 追加 2MB + fsync ×2），且
  // journal 一笔即越过 2MB compact 阈值 → 每笔保存触发整文件重读+逐行重解析（含对
  // 兆级行的 JSON.parse）。阈值取 256KB：常规章（数千至数万字）全文照旧完整入
  // journal；仅超大文档（10 万字级）降级为头尾截断（R53-D-2，原为空快照）。
  const line =
    Buffer.byteLength(content, 'utf-8') > JOURNAL_PENDING_SNAPSHOT_MAX_BYTES
      ? degradedFallback
      : JSON.stringify(entry)
  await appendLineAsync(journalPath, line, degradedFallback)
  return entry.opId
}

/** 追加移动/重命名 pending 行（P3-10）。返回 opId 供配对 settle/abort。 */
export async function appendMovePending(
  journalPath: string,
  docId: string,
  oldPath: string,
  newPath: string,
): Promise<string> {
  const entry: JournalMovePending = {
    opId: ulid(),
    docId,
    ts: new Date().toISOString(),
    status: 'pending',
    kind: 'move',
    oldPath,
    newPath,
  }
  await appendLineAsync(journalPath, JSON.stringify(entry))
  return entry.opId
}

/** 追加 settled 行，标记某 opId 已成功落盘。 */
export async function appendSettled(
  journalPath: string,
  opId: string,
  newRevision: `sha256:${string}`,
): Promise<void> {
  const entry: JournalSettled = {
    opId,
    ts: new Date().toISOString(),
    status: 'settled',
    newRevision,
  }
  await appendLineAsync(journalPath, JSON.stringify(entry))
  maybeCompactJournal(journalPath)
}

/** 追加 aborted 行，标记某 opId 保存失败（不落盘）。 */
export async function appendAborted(journalPath: string, opId: string, reason: string): Promise<void> {
  const entry: JournalAborted = {
    opId,
    ts: new Date().toISOString(),
    status: 'aborted',
    reason,
  }
  await appendLineAsync(journalPath, JSON.stringify(entry))
  maybeCompactJournal(journalPath)
}

/** 扫 journal，找 pending 但无 settled/aborted 的条目（崩溃恢复用）。非法行跳过。 */
export function findUnsettled(journalPath: string): JournalAnyPending[] {
  if (!existsSync(journalPath)) return []
  let text: string
  try {
    text = readFileSync(journalPath, 'utf-8')
  } catch {
    return []
  }
  const pending = new Map<string, JournalAnyPending>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj: RawLine
    try {
      obj = JSON.parse(line) as RawLine
    } catch {
      continue // 非法行跳过
    }
    if (obj.status === 'pending' && typeof obj.opId === 'string') {
      // 字段校验（P2-A3）：损坏 journal 缺字段的 pending 行不救（内容快照不完整，恢复无意义）。
      // baseRevision 允许 null（无基线场景合法），docId/ts/content 必须为 string；
      // move 类（P3-10）按 kind 分流——oldPath/newPath 必须为 string。
      if (obj.kind === 'move') {
        if (
          typeof obj.docId === 'string' &&
          typeof obj.ts === 'string' &&
          typeof obj.oldPath === 'string' &&
          typeof obj.newPath === 'string'
        ) {
          pending.set(obj.opId, obj as unknown as JournalMovePending)
        }
      } else if (
        typeof obj.docId === 'string' &&
        (obj.baseRevision == null || typeof obj.baseRevision === 'string') &&
        typeof obj.ts === 'string' &&
        typeof obj.content === 'string'
      ) {
        pending.set(obj.opId, obj as unknown as JournalPending)
      }
    } else if ((obj.status === 'settled' || obj.status === 'aborted') && typeof obj.opId === 'string') {
      pending.delete(obj.opId)
    }
  }
  return [...pending.values()]
}

/**
 * R33D-5（三十三轮）：appendLine 的异步孪生——executeSave/saveDraft 服务进程保存链
 * 每笔 2-3 次 journal 追加，此前走同步 Atomics.wait 锁等待（双进程争用冻结事件循环
 * 最长 2s）。降级语义原样平移（锁超时 → 精简降级行裸写）；R35-5 后服务进程全部
 * journal 写路径（含 healMovePending 自愈回写）均走本异步版。原同步 appendLine 随
 * appendSettledSync/appendAbortedSync 一并删除（R36-11：生产零调用死码，自 R35-5
 * 起无任何调用方）。
 */
async function appendLineAsync(filePath: string, line: string, degradedLine?: string): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true })
  const release = await acquireCrossProcessLockAsync(`${filePath}.lock`, journalLockTimeoutMs)
  if (release) {
    try {
      appendFileSync(filePath, line + '\n', 'utf-8')
      fsyncFile(filePath)
    } finally {
      release()
    }
    return
  }
  log.warn('journal', `跨进程锁超时，降级裸写（${filePath}）——与 compact 的互斥窗口回到守卫口径`)
  appendFileSync(filePath, (degradedLine ?? line) + '\n', 'utf-8')
  fsyncFile(filePath)
}

/** fsync 已存在文件（追加后同步数据落盘）。best-effort。 */
function fsyncFile(filePath: string): void {
  let fd: number | undefined
  try {
    // R33-7（三十三轮）：'r' → 'r+'——win FlushFileBuffers 要求句柄具写访问权，只读
    // fd 调 fsyncSync 恒抛 EPERM 被下方 catch 吞掉：fsync 纪律（模块头注「确保崩溃前
    // 已落盘」）在主力平台从未生效（实测 win32：'r'→EPERM、'r+'→OK）。'r+' 不截断，
    // 追加后刷盘语义不变。
    fd = openSync(filePath, 'r+')
    fsyncSync(fd)
  } catch {
    // 平台/权限问题——best-effort
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best-effort
      }
    }
  }
}

// ── 膨胀治理（U-P2-9）────────────────────────────

/** compact 阈值：journal 字节数超过此值时在 settle/abort 后压缩（只留未结算 pending）。
 *  R30-18 口径：export const + 模块内可变生效值 + 注入钩子——测试经钩子改档
 *  （PM-3 批起 compact 用例以低阈值+小内容建仓，不再依赖 MB 级 pending 全文撑破
 *  2MB——快照超 256KB 已被 appendPending 降级，撑不破），生产恒用常量。 */
export const JOURNAL_COMPACT_BYTES = 2 * 1024 * 1024

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改。 */
let journalCompactBytes = JOURNAL_COMPACT_BYTES

/** 测试注入钩子（生产零调用）。 */
export function __setJournalCompactBytesForTest(bytes: number): void {
  journalCompactBytes = bytes
}

/** PM-3：pending 全文快照尺寸闸——超过此字节数的快照不进 journal（降级行替代），
 *  见 appendPending 注释。测试可经注入钩子改档（生产恒用常量，R30-18 口径）。 */
export const JOURNAL_PENDING_SNAPSHOT_MAX_BYTES = 256 * 1024

/** R53-D-2（五十三轮）：降级行快照保留预算——头尾各保此字节数（UTF-8 安全切点）。
 *  降级行总长 ≤ 2×预算 + 标记（≈64KB）：远小于 R31-21 的原子窗顾虑（兆级行交错
 *  损坏），也不回到 PM-3 要消除的每笔保存 journal IO 翻倍（256KB 级）。
 *  R30-18 口径：常量 + 模块内可变生效值 + 注入钩子（生产恒用常量）。 */
export const JOURNAL_PENDING_DEGRADED_KEEP_BYTES = 32 * 1024

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改。 */
let journalDegradedKeepBytes = JOURNAL_PENDING_DEGRADED_KEEP_BYTES

/** 测试注入钩子（生产零调用）。 */
export function __setJournalDegradedKeepBytesForTest(bytes: number): void {
  journalDegradedKeepBytes = bytes
}

/**
 * 超阈值时压缩 journal：已结算（settled/aborted 配对完成）的行全部丢弃，
 * 只保留未结算 pending（崩溃恢复的唯一依赖，含全文快照）。
 *
 * 安全条件：settled 行的使命仅是配对消除 pending（findUnsettled 语义），其
 * pending 已不在保留集内，丢弃无损失。原子替换（tmp+rename）：压缩窗口崩溃
 * 则原 journal 完好，tmp 残留下次覆盖。best-effort——失败不影响保存主流程。
 * 调用时机在 appendSettled/appendAborted 之后（本进程内 per-docId 串行）。
 *
 * KN-H-1（2026-08-23，bb 轮挂起销账·轻量守卫）：原「无并发写」假设仅限单进程——
 * CLI/脚本与 GUI 双进程操作同一书时，compact 的「读→算→整文件替换」窗口可吞掉
 * 对方刚 append 的 pending 行（崩溃恢复唯一依据，丢了恢复链失据）。守卫：读前后
 * 各 stat 一次，size/mtime 任变（= 有他进程追加过）→ 放弃本轮压缩（compact 本就
 * best-effort，下次再试）。J7（2026-08-23）：跨进程文件锁已落地
 * （fs/cross-process-lock.ts，含 win 语义评估）——compact 与 append 共享 journal
 * 锁文件，「末次 stat → rename」理论窗口彻底闭合；stat 守卫保留作双保险。
 * N4（五十九轮）：基线 stat 移入锁内——原「锁外 before stat → 等锁 → 锁内 after
 * stat」对比，等锁期间他进程的合法 append 也会误判为「压缩窗口内有变」白白弃压；
 * 且 append 锁超时降级裸写时，after-stat 与 rename 之间仍各有 µs 级窗口。现锁内
 * 先 stat（基线）→ 读算 → rename 前重 stat 对比行数（size 变 = 有新行）→ 变则
 * 放弃本轮。锁内基线 + rename 前复核把「读算期间被裸写 append 插行」的丢失窗口
 * 收敛到 stat 与 rename 之间的µs 级（与 J7 锁语义的残余窗口同级，如实记档）。
 */
function maybeCompactJournal(journalPath: string): void {
  try {
    if (!existsSync(journalPath)) return
    if (statSync(journalPath).size < journalCompactBytes) return
    // J7：跨进程锁（append 侧同锁）——持锁期间他进程 append 被阻塞。非阻塞占锁
    // （best-effort：拿不到直接弃本轮）。
    const release = tryAcquireCrossProcessLock(`${journalPath}.lock`)
    if (!release) return
    try {
      // N4：锁内基线 stat（行数以 size 折算——任何 append 必改 size，等价且免二次全读）
      const before = statSync(journalPath)
      if (before.size < journalCompactBytes) return
      const unsettled = findUnsettled(journalPath)
      // N4：rename 前重 stat 复核——读算期间若被他进程（锁超时降级裸写的 append 路径）
      // 追加新行（size 变 = 有新行），放弃本轮压缩，新行随原文件完整保留
      const after = statSync(journalPath)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return
      const text = unsettled.map((p) => JSON.stringify(p)).join('\n')
      atomicWriteFile(journalPath, unsettled.length > 0 ? text + '\n' : '', { fsync: true })
    } finally {
      release()
    }
  } catch {
    // best-effort：压缩失败不影响保存结果，下次再试
  }
}

/** J7 锁等待超时（毫秒）——争用为文件 IO 级毫秒。
 *  R30-18（三十轮）：常量化——export let 可被任一 import 方静默改写（同 events/store.ts
 *  R26-105 的收口认定），改 const + 内部可变生效值；测试只能经注入钩子改档，生产恒用常量。 */
export const JOURNAL_LOCK_TIMEOUT_MS = 2_000

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改。 */
let journalLockTimeoutMs = JOURNAL_LOCK_TIMEOUT_MS

/** 测试注入钩子（生产零调用）。 */
export function __setJournalLockTimeoutForTest(ms: number): void {
  journalLockTimeoutMs = ms
}
