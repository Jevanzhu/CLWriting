/**
 * 每章 / 篇 AI 调用预算闸（精简版）。
 *
 * 记账存储在书库 .cache/ai-calls.json；超限阻断自动写章循环烧钱（Q2 甲）。
 * 无目录锁（当前无并行生成场景——文档 §八「不做的事」）；损坏时保守阻断。
 *
 * 记账范围：仅自动写章（self-heal）——预算闸专为防写章循环烧钱设计；
 * 审稿/分析/改写等端点不记账（无 chapter 上下文，且无预算控制需求）。
 *
 * 与旧版差异（旧版随 P2 清理删除）：去掉目录锁 / limit_override /
 * stale lock 检测 / token 回填重试——YAGNI，需要时再加。
 */
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { BookConfig } from '../format/types.js'
import type { TokenUsage } from './provider/types.js'

/** 磁盘记录格式（单章/篇一条，换章覆盖） */
interface CallRecord {
  chapter: number
  used: number
  inputTokens: number
  outputTokens: number
}

const FILE = 'ai-calls.json'

function budgetPath(bookRoot: string): string {
  return join(bookRoot, '.cache', FILE)
}

/** 读记录；缺失 / 损坏 → null */
function readRecord(bookRoot: string): CallRecord | null {
  const fp = budgetPath(bookRoot)
  if (!existsSync(fp)) return null
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as CallRecord
    if (typeof raw.chapter !== 'number' || typeof raw.used !== 'number') return null
    return {
      chapter: raw.chapter,
      used: raw.used,
      inputTokens: typeof raw.inputTokens === 'number' ? raw.inputTokens : 0,
      outputTokens: typeof raw.outputTokens === 'number' ? raw.outputTokens : 0,
    }
  } catch {
    return null
  }
}

/** 原子写记录 */
function writeRecord(bookRoot: string, rec: CallRecord): void {
  const fp = budgetPath(bookRoot)
  mkdirSync(dirname(fp), { recursive: true })
  const tmp = `${fp}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, fp)
}

/** 预算判定：超限 → ok=false + 人话提示（三条出路在文档 §五） */
export function checkAiCallBudget(
  bookRoot: string,
  chapter: number,
  config: BookConfig,
): { ok: true; used: number; limit: number } | { ok: false; used: number; limit: number; reason: string } {
  const limit = config.budget.calls_per_chapter
  const rec = readRecord(bookRoot)

  if (!rec || rec.chapter !== chapter) {
    // 无记录或已换章 → 计数从零开始
    return { ok: true, used: 0, limit }
  }
  if (rec.used >= limit) {
    return {
      ok: false,
      used: rec.used,
      limit,
      reason: `本章已调用 ${rec.used} 次（上限 ${limit}）。可临时提高 book.yaml 的 budget.calls_per_chapter，或降低重写次数`,
    }
  }
  return { ok: true, used: rec.used, limit }
}

/** 记一次 AI 调用（生成成功后调用） */
export function recordAiCall(bookRoot: string, chapter: number, usage: TokenUsage | null): void {
  let rec = readRecord(bookRoot)
  if (!rec || rec.chapter !== chapter) {
    rec = { chapter, used: 0, inputTokens: 0, outputTokens: 0 }
  }
  rec.used += 1
  if (usage) {
    rec.inputTokens += usage.inputTokens
    rec.outputTokens += usage.outputTokens
  }
  writeRecord(bookRoot, rec)
}