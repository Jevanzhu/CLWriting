/**
 * 每章 AI 调用预算闸 + 任务维度计量（T5 泛化）。
 *
 * 记账存储在书库 .cache/ai-calls.json；超限阻断自动写章循环烧钱（Q2 甲）。
 * 无目录锁（当前无并行生成场景——文档 §八「不做的事」）；损坏时保守阻断。
 *
 * 数据结构（T5 泛化后）：
 *   chapter 块 — 预算闸专用，换章重置（仅 self-heal 记，通过 runTask chapter 参数）
 *   tasks 块   — 按任务类型累计、不重置（runTask 自动记账，7/7 端点覆盖）
 *
 * 与旧版差异：去掉目录锁 / limit_override / stale lock 检测（YAGNI）。
 * 旧格式（flat { chapter, used, ... }）读到即一次性迁移。
 */
import { existsSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import type { BookConfig } from '../format/types.js'
import type { TokenUsage } from './provider/types.js'

/** chapter 块（预算闸专用） */
interface ChapterUsage {
  num: number
  used: number
  inputTokens: number
  outputTokens: number
}

/** task 块（全端点覆盖） */
interface TaskUsage {
  used: number
  inputTokens: number
  outputTokens: number
}

/** 磁盘记录格式 */
interface CallRecord {
  chapter: ChapterUsage
  tasks: Record<string, TaskUsage>
}

const FILE = 'ai-calls.json'

function budgetPath(bookRoot: string): string {
  return join(bookRoot, '.cache', FILE)
}

/**
 * 读记录；缺失 / 损坏 → null。
 * 旧格式（flat { chapter: number, used: number, ... }）自动迁移。
 */
function readRecord(bookRoot: string): CallRecord | null {
  const fp = budgetPath(bookRoot)
  if (!existsSync(fp)) return null
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, unknown>
    // 旧格式检测：raw.chapter 是 number（而非 object）→ 迁移写回
    if (typeof raw['chapter'] === 'number') {
      const migrated = migrateOldFormat(raw as unknown as OldFormat)
      writeRecord(bookRoot, migrated)
      return migrated
    }
    // 新格式
    const chapter = raw['chapter'] as ChapterUsage | undefined
    if (!chapter || typeof chapter.num !== 'number' || typeof chapter.used !== 'number') return null
    return {
      chapter: {
        num: chapter.num,
        used: chapter.used,
        inputTokens: typeof chapter.inputTokens === 'number' ? chapter.inputTokens : 0,
        outputTokens: typeof chapter.outputTokens === 'number' ? chapter.outputTokens : 0,
      },
      tasks: typeof raw['tasks'] === 'object' && raw['tasks'] !== null
        ? raw['tasks'] as Record<string, TaskUsage>
        : {},
    }
  } catch {
    return null
  }
}

/** 旧格式（flat record） */
interface OldFormat {
  chapter: number
  used: number
  inputTokens?: number
  outputTokens?: number
}

/** 旧格式 → 新格式迁移 */
function migrateOldFormat(old: OldFormat): CallRecord {
  return {
    chapter: {
      num: old.chapter,
      used: old.used,
      inputTokens: old.inputTokens ?? 0,
      outputTokens: old.outputTokens ?? 0,
    },
    tasks: {},
  }
}

/** 原子写记录（全局 atomicWriteFile + fsync + 权限收敛 0600） */
function writeRecord(bookRoot: string, rec: CallRecord): void {
  const fp = budgetPath(bookRoot)
  atomicWriteFile(fp, JSON.stringify(rec, null, 2) + '\n', { fsync: true })
  chmodSync(fp, 0o600)
}

/** 预算判定：超限 → ok=false + 人话提示（三条出路在文档 §五） */
export function checkAiCallBudget(
  bookRoot: string,
  chapter: number,
  config: BookConfig,
): { ok: true; used: number; limit: number } | { ok: false; used: number; limit: number; reason: string } {
  const limit = config.budget.calls_per_chapter
  const rec = readRecord(bookRoot)

  if (!rec || rec.chapter.num !== chapter) {
    // 无记录或已换章 → 计数从零开始
    return { ok: true, used: 0, limit }
  }
  if (rec.chapter.used >= limit) {
    return {
      ok: false,
      used: rec.chapter.used,
      limit,
      reason: `本章已调用 ${rec.chapter.used} 次（上限 ${limit}）。可临时提高 book.yaml 的 budget.calls_per_chapter，或降低重写次数`,
    }
  }
  return { ok: true, used: rec.chapter.used, limit }
}

/**
 * 记一次 chapter 维度 AI 调用（预算闸用；换章重置）。
 *
 * 由 runTask 在 self-heal 场景（传了 chapter 参数）自动调用。
 */
export function recordAiCall(bookRoot: string, chapter: number, usage: TokenUsage | null): void {
  let rec = readRecord(bookRoot)
  if (!rec || rec.chapter.num !== chapter) {
    rec = { chapter: { num: chapter, used: 0, inputTokens: 0, outputTokens: 0 }, tasks: rec?.tasks ?? {} }
  }
  rec.chapter.used += 1
  if (usage) {
    rec.chapter.inputTokens += usage.inputTokens
    rec.chapter.outputTokens += usage.outputTokens
  }
  writeRecord(bookRoot, rec)
}

/**
 * 记一次 task 维度 AI 调用（全端点覆盖；不重置）。
 *
 * 由 runTask 末尾自动调用（有 bookRoot + task 时）。
 */
export function recordTaskUsage(bookRoot: string, task: string, usage: TokenUsage | null): void {
  let rec = readRecord(bookRoot)
  if (!rec) {
    rec = { chapter: { num: 0, used: 0, inputTokens: 0, outputTokens: 0 }, tasks: {} }
  }
  const t = rec.tasks[task] ?? { used: 0, inputTokens: 0, outputTokens: 0 }
  t.used += 1
  if (usage) {
    t.inputTokens += usage.inputTokens
    t.outputTokens += usage.outputTokens
  }
  rec.tasks[task] = t
  writeRecord(bookRoot, rec)
}
