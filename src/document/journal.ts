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
  content: string // 发起时的全文快照（防丢字）；降级落盘行为 ''（R31-21）
  /** R31-21（三十一轮）：true = 本行在跨进程锁超时后降级裸写、快照已剥离——
   *  大快照 append 超文件系统原子窗，双进程同拍降级可交错损坏（坏行被
   *  findUnsettled 容错跳过 → 恢复失据）。恢复消费方只读 opId（state 健康
   *  扫描）不受空快照影响；正文恢复以 .版本 留底/磁盘现状为准。 */
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
  // R31-21（三十一轮）：锁超时降级时剥离全文快照（行长收敛回原子窗）——
  // 带全快照的降级裸写是本轮评审实证的交错损坏面。
  const degradedFallback = JSON.stringify({ ...entry, content: '', degraded: true })
  await appendLineAsync(journalPath, JSON.stringify(entry), degradedFallback)
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

/** compact 阈值：journal 字节数超过此值时在 settle/abort 后压缩（只留未结算 pending）。 */
export const JOURNAL_COMPACT_BYTES = 2 * 1024 * 1024

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
    if (statSync(journalPath).size < JOURNAL_COMPACT_BYTES) return
    // J7：跨进程锁（append 侧同锁）——持锁期间他进程 append 被阻塞。非阻塞占锁
    // （best-effort：拿不到直接弃本轮）。
    const release = tryAcquireCrossProcessLock(`${journalPath}.lock`)
    if (!release) return
    try {
      // N4：锁内基线 stat（行数以 size 折算——任何 append 必改 size，等价且免二次全读）
      const before = statSync(journalPath)
      if (before.size < JOURNAL_COMPACT_BYTES) return
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
