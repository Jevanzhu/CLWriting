/**
 * AI 调用预算记录的读取与归一化（数据格式域，G5 E2.1 下沉）。
 *
 * 仅含纯文件读 + JSON 归一化，无 AI 行为——下沉底座 format 域供 metrics 等编辑器/
 * 底座模块复用，消除「编辑器 → AI 层」反向依赖。写侧（记账/清账/锁）仍留 ai/calls.ts。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 调用计数文件名（工作区/.ai-calls.json）。ai/calls 写侧造 tmp 名时也用。 */
export const CALL_BUDGET_FILE = '.ai-calls.json'

/** 写章流程内会计入预算的 AI 步骤 */
export type AiCallStep = 'outline' | 'draft' | 'review' | 'review-combined'

/** 单次计数留痕 */
export interface AiCallEntry {
  step: AiCallStep
  calls: number
  at: string
  note?: string
  /** 可选：本次调用的 token 消耗（宿主拿得到 usage 就填，否则省略） */
  tokens?: number
}

/** 每章/篇调用计数记录（工作区机器域）；字段名沿用 chapter 以保持兼容。 */
export interface AiCallBudgetRecord {
  chapter: number
  used: number
  limit_override?: number
  entries: AiCallEntry[]
  updated_at: string
}

export type AiCallBudgetRead =
  | { ok: true; record: AiCallBudgetRecord | null }
  | { ok: false; reason: string }

/** 调用计数文件路径（工作区/.ai-calls.json） */
export function aiCallBudgetPath(workDir: string): string {
  return join(workDir, CALL_BUDGET_FILE)
}

/** 读调用预算记录；不存在表示本章还未调用。 */
export function readAiCallBudget(workDir: string): AiCallBudgetRead {
  const fp = aiCallBudgetPath(workDir)
  if (!existsSync(fp)) return { ok: true, record: null }

  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as unknown
    return { ok: true, record: normalizeRecord(raw) }
  } catch {
    return { ok: false, reason: '调用计数文件损坏，不能确认本章已用次数' }
  }
}

function normalizeRecord(raw: unknown): AiCallBudgetRecord {
  if (typeof raw !== 'object' || raw === null) throw new Error('bad record')
  const obj = raw as Record<string, unknown>
  const chapter = Number(obj['chapter'])
  const used = Number(obj['used'])
  if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error('bad chapter')
  if (!Number.isSafeInteger(used) || used < 0) throw new Error('bad used')

  const entriesRaw = Array.isArray(obj['entries']) ? obj['entries'] : []
  const entries: AiCallEntry[] = entriesRaw.map((entry) => normalizeEntry(entry))
  const updatedAt = typeof obj['updated_at'] === 'string' ? obj['updated_at'] : ''
  const limitOverride = obj['limit_override'] === undefined ? undefined : Number(obj['limit_override'])

  const record: AiCallBudgetRecord = {
    chapter,
    used,
    entries,
    updated_at: updatedAt,
  }
  if (limitOverride !== undefined && Number.isSafeInteger(limitOverride) && limitOverride > 0) {
    record.limit_override = limitOverride
  }
  return record
}

function normalizeEntry(raw: unknown): AiCallEntry {
  if (typeof raw !== 'object' || raw === null) throw new Error('bad entry')
  const obj = raw as Record<string, unknown>
  const step = String(obj['step'] ?? '')
  const calls = Number(obj['calls'])
  const at = String(obj['at'] ?? '')
  if (!isAiCallStep(step) || !Number.isSafeInteger(calls) || calls < 1 || at === '') {
    throw new Error('bad entry')
  }
  const tokensRaw = obj['tokens']
  const tokens = typeof tokensRaw === 'number' && Number.isFinite(tokensRaw) && tokensRaw >= 0 ? tokensRaw : undefined
  return {
    step,
    calls,
    at,
    ...(typeof obj['note'] === 'string' ? { note: obj['note'] } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  }
}

function isAiCallStep(step: string): step is AiCallStep {
  return step === 'outline' || step === 'draft' || step === 'review' || step === 'review-combined'
}
