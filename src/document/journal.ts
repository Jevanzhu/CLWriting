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
  content: string // 发起时的全文快照（防丢字）
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

export type JournalEntry = JournalPending | JournalSettled | JournalAborted

type RawLine = { [k: string]: unknown }

/** 追加 pending 行（含全文快照）。返回 opId 供后续 appendSettled 配对。 */
export function appendPending(
  journalPath: string,
  docId: string,
  baseRevision: Revision,
  content: string,
): string {
  const entry: JournalPending = {
    opId: ulid(),
    docId,
    baseRevision,
    ts: new Date().toISOString(),
    status: 'pending',
    content,
  }
  appendLine(journalPath, JSON.stringify(entry))
  return entry.opId
}

/** 追加 settled 行，标记某 opId 已成功落盘。 */
export function appendSettled(
  journalPath: string,
  opId: string,
  newRevision: `sha256:${string}`,
): void {
  const entry: JournalSettled = {
    opId,
    ts: new Date().toISOString(),
    status: 'settled',
    newRevision,
  }
  appendLine(journalPath, JSON.stringify(entry))
  maybeCompactJournal(journalPath)
}

/** 追加 aborted 行，标记某 opId 保存失败（不落盘）。 */
export function appendAborted(journalPath: string, opId: string, reason: string): void {
  const entry: JournalAborted = {
    opId,
    ts: new Date().toISOString(),
    status: 'aborted',
    reason,
  }
  appendLine(journalPath, JSON.stringify(entry))
  maybeCompactJournal(journalPath)
}

/** 扫 journal，找 pending 但无 settled/aborted 的条目（崩溃恢复用）。非法行跳过。 */
export function findUnsettled(journalPath: string): JournalPending[] {
  if (!existsSync(journalPath)) return []
  let text: string
  try {
    text = readFileSync(journalPath, 'utf-8')
  } catch {
    return []
  }
  const pending = new Map<string, JournalPending>()
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
      // baseRevision 允许 null（无基线场景合法），docId/ts/content 必须为 string。
      if (
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

/** 追加一行 jsonl + fsync（防丢字：确保崩溃前已落盘）。 */
function appendLine(filePath: string, line: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, line + '\n', 'utf-8')
  fsyncFile(filePath)
}

/** fsync 已存在文件（追加后同步数据落盘）。best-effort。 */
function fsyncFile(filePath: string): void {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
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
 * 调用时机在 appendSettled/appendAborted 之后（本进程内 per-docId 串行，无并发写）。
 */
function maybeCompactJournal(journalPath: string): void {
  try {
    if (!existsSync(journalPath)) return
    if (statSync(journalPath).size < JOURNAL_COMPACT_BYTES) return
    const unsettled = findUnsettled(journalPath)
    const text = unsettled.map((p) => JSON.stringify(p)).join('\n')
    atomicWriteFile(journalPath, unsettled.length > 0 ? text + '\n' : '', { fsync: true })
  } catch {
    // best-effort：压缩失败不影响保存结果，下次再试
  }
}
