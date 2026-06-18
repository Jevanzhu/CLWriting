/**
 * 每章 AI 调用预算闸 —— 依据 M4 #23。
 *
 * 管「单章调用几次」，与 #12 输入预算闸（每次多大）正交。
 * 计数存在工作区机器域，续跑继承；损坏时保守阻断，避免静默归零绕过预算。
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { BookConfig } from '../format/types.js'

const CALL_BUDGET_FILE = '.ai-calls.json'

/** 写章流程内会计入预算的 AI 步骤 */
export type AiCallStep = 'outline' | 'draft' | 'review' | 'review-combined'

/** 单次计数留痕 */
export interface AiCallEntry {
  step: AiCallStep
  calls: number
  at: string
  note?: string
}

/** 每章调用计数记录（工作区机器域） */
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

export type AiCallBudgetState =
  | {
      ok: true
      chapter: number
      used: number
      limit: number
      remaining: number
      record: AiCallBudgetRecord | null
    }
  | {
      ok: false
      chapter: number
      used: number
      limit: number
      remaining: 0
      reason: string
    }

export type AiCallBudgetDecision =
  | {
      ok: true
      chapter: number
      used: number
      limit: number
      remaining: number
      projected: number
    }
  | {
      ok: false
      chapter: number
      used: number
      limit: number
      remaining: number
      projected: number
      reason: string
    }

export type AiCallRecordResult =
  | { ok: true; record: AiCallBudgetRecord }
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

/** 当前章调用预算状态。 */
export function getAiCallBudgetState(
  workDir: string,
  chapter: number,
  config: BookConfig,
): AiCallBudgetState {
  const limit = config.budget.calls_per_chapter
  const read = readAiCallBudget(workDir)
  if (!read.ok) {
    return { ok: false, chapter, used: limit, limit, remaining: 0, reason: `${read.reason}，按已达上限处理` }
  }

  if (read.record === null) {
    return { ok: true, chapter, used: 0, limit, remaining: limit, record: null }
  }

  if (read.record.chapter !== chapter) {
    return {
      ok: false,
      chapter,
      used: limit,
      limit,
      remaining: 0,
      reason: `调用计数属于第 ${read.record.chapter} 章，不是第 ${chapter} 章；请先处理工作区残留`,
    }
  }

  const effectiveLimit = read.record.limit_override ?? limit
  return {
    ok: true,
    chapter,
    used: read.record.used,
    limit: effectiveLimit,
    remaining: Math.max(0, effectiveLimit - read.record.used),
    record: read.record,
  }
}

/** AI 步执行前预算判定：未超放行，将超则给人话选项。 */
export function checkAiCallBudget(input: {
  workDir: string
  chapter: number
  config: BookConfig
  plannedCalls: number
  label: string
}): AiCallBudgetDecision {
  const state = getAiCallBudgetState(input.workDir, input.chapter, input.config)
  if (!state.ok) {
    return {
      ok: false,
      chapter: input.chapter,
      used: state.used,
      limit: state.limit,
      remaining: 0,
      projected: state.used + Math.max(0, input.plannedCalls),
      reason: state.reason,
    }
  }

  const planned = Math.max(0, input.plannedCalls)
  const projected = state.used + planned
  if (projected <= state.limit) {
    return {
      ok: true,
      chapter: input.chapter,
      used: state.used,
      limit: state.limit,
      remaining: state.limit - projected,
      projected,
    }
  }

  return {
    ok: false,
    chapter: input.chapter,
    used: state.used,
    limit: state.limit,
    remaining: state.remaining,
    projected,
    reason:
      `这章已调用 AI ${state.used} 次；要执行「${input.label}」还要 +${planned}，` +
      `合计 ${projected}，超过每章上限 ${state.limit}。` +
      '请选择：临时提高本章上限、调高 book.yaml 的 budget.calls_per_chapter、降低 best-of-N，或按审查规格降级后重试。',
  }
}

/** 记录一次已发生的 AI 调用。调用方应在每次模型请求后调用。 */
export function recordAiCall(input: {
  workDir: string
  chapter: number
  config: BookConfig
  step: AiCallStep
  calls?: number
  note?: string
  at?: string
}): AiCallRecordResult {
  const calls = input.calls ?? 1
  const decision = checkAiCallBudget({
    workDir: input.workDir,
    chapter: input.chapter,
    config: input.config,
    plannedCalls: calls,
    label: input.step,
  })
  if (!decision.ok) return { ok: false, reason: decision.reason }

  const state = getAiCallBudgetState(input.workDir, input.chapter, input.config)
  if (!state.ok) return { ok: false, reason: state.reason }

  const now = input.at ?? new Date().toISOString()
  const next: AiCallBudgetRecord = {
    chapter: input.chapter,
    used: state.used + calls,
    ...(state.record?.limit_override !== undefined ? { limit_override: state.record.limit_override } : {}),
    entries: [
      ...(state.record?.entries ?? []),
      {
        step: input.step,
        calls,
        at: now,
        ...(input.note ? { note: input.note } : {}),
      },
    ],
    updated_at: now,
  }
  writeFileSync(aiCallBudgetPath(input.workDir), JSON.stringify(next, null, 2), 'utf-8')
  return { ok: true, record: next }
}

/** 设置本章临时上限；只影响当前工作区章节，不改 book.yaml 默认值。 */
export function setAiCallLimitOverride(
  workDir: string,
  chapter: number,
  config: BookConfig,
  limit: number,
): AiCallRecordResult {
  const state = getAiCallBudgetState(workDir, chapter, config)
  if (!state.ok) return { ok: false, reason: state.reason }
  if (!Number.isSafeInteger(limit) || limit < state.used) {
    return { ok: false, reason: `临时上限不能低于已调用次数 ${state.used}` }
  }

  const now = new Date().toISOString()
  const next: AiCallBudgetRecord = {
    chapter,
    used: state.used,
    limit_override: limit,
    entries: state.record?.entries ?? [],
    updated_at: now,
  }
  writeFileSync(aiCallBudgetPath(workDir), JSON.stringify(next, null, 2), 'utf-8')
  return { ok: true, record: next }
}

/** 定稿清空工作区时删除调用计数。 */
export function clearAiCallBudget(workDir: string): void {
  const fp = aiCallBudgetPath(workDir)
  if (existsSync(fp)) unlinkSync(fp)
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
  return {
    step,
    calls,
    at,
    ...(typeof obj['note'] === 'string' ? { note: obj['note'] } : {}),
  }
}

function isAiCallStep(step: string): step is AiCallStep {
  return step === 'outline' || step === 'draft' || step === 'review' || step === 'review-combined'
}
