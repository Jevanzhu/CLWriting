/**
 * 每章/篇 AI 调用预算闸 —— 依据 M4 #23。
 *
 * 管「单章/篇调用几次」，与 #12 输入预算闸（每次多大）正交。
 * 计数存在工作区机器域，续跑继承；损坏时保守阻断，避免静默归零绕过预算。
 *
 * 读侧（路径/读/归一化）已下沉 format/ai-calls.ts（纯文件读，G5 E2.1 治理，
 * 消除编辑器 metrics → AI 反向依赖）；本模块留写侧（记账/清账/锁）+ 预算判定，
 * 并 re-export 读侧保持外部调用零感知。
 */

import { existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BookConfig } from '../format/types.js'
import {
  CALL_BUDGET_FILE,
  aiCallBudgetPath,
  readAiCallBudget,
  type AiCallBudgetRecord,
  type AiCallEntry,
  type AiCallStep,
} from '../format/ai-calls.js'

// 读侧 re-export（外部模块从 ai/calls 引用，下沉后零感知）
export { aiCallBudgetPath, readAiCallBudget } from '../format/ai-calls.js'
export type { AiCallStep, AiCallEntry, AiCallBudgetRecord, AiCallBudgetRead } from '../format/ai-calls.js'

const CALL_BUDGET_LOCK_DIR = '.ai-calls.lock'
const CALL_BUDGET_LOCK_TIMEOUT_MS = 2000
const CALL_BUDGET_LOCK_STALE_MS = 30000

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

function aiCallBudgetLockPath(workDir: string): string {
  return join(workDir, CALL_BUDGET_LOCK_DIR)
}

/** 预算展示单位：短篇集按篇解释 calls_per_chapter，长篇按章解释。 */
export function aiCallUnit(config: BookConfig): '章' | '篇' {
  return (config.kind ?? 'long') === 'short' ? '篇' : '章'
}

/** 当前章调用预算状态。 */
export function getAiCallBudgetState(
  workDir: string,
  chapter: number,
  config: BookConfig,
): AiCallBudgetState {
  const limit = config.budget.calls_per_chapter
  const unit = aiCallUnit(config)
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
      reason: `调用计数属于第 ${read.record.chapter} ${unit}，不是第 ${chapter} ${unit}；请先处理工作区残留`,
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
  const unit = aiCallUnit(input.config)
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
      `本${unit}已调用 AI ${state.used} 次；要执行「${input.label}」还要 +${planned}，` +
      `合计 ${projected}，超过每${unit}上限 ${state.limit}。` +
      `请选择：临时提高本${unit}上限、调高 book.yaml 的 budget.calls_per_chapter、降低 best-of-N，或按审查规格降级后重试。`,
  }
}

/** 记录一次已发生的 AI 调用。调用方应在每次模型请求后调用。 */
export function recordAiCall(input: {
  workDir: string
  chapter: number
  config: BookConfig
  step: AiCallStep
  calls?: number
  /** 可选：本次调用 token 消耗（宿主拿得到 usage 就填；与 calls 透传进 entry） */
  tokens?: number
  note?: string
  at?: string
}): AiCallRecordResult {
  const calls = input.calls ?? 1
  if (!Number.isSafeInteger(calls) || calls < 1) {
    return { ok: false, reason: `调用次数必须是正整数，当前为 ${String(input.calls)}` }
  }

  return withAiCallBudgetLock(input.workDir, () => {
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
          ...(input.tokens !== undefined && Number.isFinite(input.tokens) ? { tokens: input.tokens } : {}),
        },
      ],
      updated_at: now,
    }
    writeAiCallBudget(input.workDir, next)
    return { ok: true, record: next }
  })
}

/** 事后回填某一步最近一次调用的 token 真值；不增加 calls。 */
export function setAiCallTokens(input: {
  workDir: string
  chapter: number
  config: BookConfig
  step: AiCallStep
  tokens: number
  at?: string
}): AiCallRecordResult {
  const unit = aiCallUnit(input.config)
  if (!Number.isSafeInteger(input.tokens) || input.tokens < 0) {
    return { ok: false, reason: `token 数必须是非负整数，当前为 ${String(input.tokens)}` }
  }
  return withAiCallBudgetLock(input.workDir, () => {
    const state = getAiCallBudgetState(input.workDir, input.chapter, input.config)
    if (!state.ok) return { ok: false, reason: state.reason }
    if (!state.record) {
      return { ok: false, reason: `第 ${input.chapter} ${unit}还没有调用记录，不能回填 token` }
    }

    let targetIndex = -1
    for (let i = state.record.entries.length - 1; i >= 0; i--) {
      if (state.record.entries[i]!.step === input.step) {
        targetIndex = i
        break
      }
    }
    if (targetIndex === -1) {
      return { ok: false, reason: `第 ${input.chapter} ${unit}没有 ${input.step} 调用记录，不能回填 token` }
    }

    const now = input.at ?? new Date().toISOString()
    const entries = state.record.entries.map((entry, index) =>
      index === targetIndex ? { ...entry, tokens: input.tokens } : entry,
    )
    const next: AiCallBudgetRecord = {
      chapter: input.chapter,
      used: state.record.used,
      ...(state.record?.limit_override !== undefined ? { limit_override: state.record.limit_override } : {}),
      entries,
      updated_at: now,
    }
    writeAiCallBudget(input.workDir, next)
    return { ok: true, record: next }
  })
}

/** 设置本章临时上限；只影响当前工作区章节，不改 book.yaml 默认值。 */
export function setAiCallLimitOverride(
  workDir: string,
  chapter: number,
  config: BookConfig,
  limit: number,
  at?: string,
): AiCallRecordResult {
  return withAiCallBudgetLock(workDir, () => {
    const state = getAiCallBudgetState(workDir, chapter, config)
    if (!state.ok) return { ok: false, reason: state.reason }
    if (!Number.isSafeInteger(limit) || limit < state.used) {
      return { ok: false, reason: `临时上限不能低于已调用次数 ${state.used}` }
    }

    const now = at ?? new Date().toISOString()
    const next: AiCallBudgetRecord = {
      chapter,
      used: state.used,
      limit_override: limit,
      entries: state.record?.entries ?? [],
      updated_at: now,
    }
    writeAiCallBudget(workDir, next)
    return { ok: true, record: next }
  })
}

/** 定稿清空工作区时删除调用计数。 */
export function clearAiCallBudget(workDir: string): void {
  const result = withAiCallBudgetLock(workDir, () => {
    const fp = aiCallBudgetPath(workDir)
    if (existsSync(fp)) unlinkSync(fp)
    return { ok: true as const }
  })
  // 锁竞争失败时计数文件未删;下次进同章可能读到旧计数误阻断,记 warning 供排查
  if (!result.ok) console.warn(`⚠️ clearAiCallBudget 未拿到锁:${result.reason}`)
}

function writeAiCallBudget(workDir: string, record: AiCallBudgetRecord): void {
  const target = aiCallBudgetPath(workDir)
  const tmp = join(workDir, `${CALL_BUDGET_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8')
  renameSync(tmp, target)
}

function withAiCallBudgetLock<T>(workDir: string, fn: () => T): T | AiCallRecordResult {
  const acquired = acquireAiCallBudgetLock(workDir)
  if (!acquired.ok) return { ok: false, reason: acquired.reason }
  try {
    return fn()
  } finally {
    releaseAiCallBudgetLock(workDir)
  }
}

function acquireAiCallBudgetLock(workDir: string): { ok: true } | { ok: false; reason: string } {
  const lockDir = aiCallBudgetLockPath(workDir)
  const deadline = Date.now() + CALL_BUDGET_LOCK_TIMEOUT_MS
  while (Date.now() <= deadline) {
    try {
      mkdirSync(lockDir)
      return { ok: true }
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') {
        return { ok: false, reason: `调用计数加锁失败：${error instanceof Error ? error.message : String(error)}` }
      }
      clearStaleAiCallBudgetLock(lockDir)
      sleepSync(20)
    }
  }
  return { ok: false, reason: '调用计数文件正被其他进程写入，请稍后重试' }
}

function releaseAiCallBudgetLock(workDir: string): void {
  rmSync(aiCallBudgetLockPath(workDir), { recursive: true, force: true })
}

function clearStaleAiCallBudgetLock(lockDir: string): void {
  try {
    const ageMs = Date.now() - statSync(lockDir).mtimeMs
    if (ageMs > CALL_BUDGET_LOCK_STALE_MS) rmSync(lockDir, { recursive: true, force: true })
  } catch {
    // The lock may have been released between mkdir attempts.
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4)
  const view = new Int32Array(buffer)
  Atomics.wait(view, 0, 0, ms)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error
}
