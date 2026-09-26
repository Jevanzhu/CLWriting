/**
 * R0917-6-P3-5（2026-09-17 全库源码重评六轮修复批）：checkAiTaskCallBudget 文案参数化
 * 回归门。
 *
 * 缺陷形态：本闸签名通用（task/limit），但两条 reason 原写死「chat 调用上限 / 本书对话
 * / budget.chat_max_calls」；当前唯一调用方（runner.ts:510）恒传 'chat' 故无实害，第二类
 * 任务复用本闸时文案会指错配置键（误导作者去改无关的 book.yaml 项）。
 *
 * 修复口径：taskLabel / configKey 两参带**缺省值**（'chat' / 'budget.chat_max_calls'）
 * ——缺省调用输出字符串逐字节不变（免动调用点、免动既有测试钉值），显式传参才改文案。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { checkAiTaskCallBudget } from '../../src/ai/calls.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const CHAPTER = { num: 0, used: 0, inputTokens: 0, outputTokens: 0 }

/** 合法账本形态（chapter 块必填四数字，tasks 逐条同形——形状不对会被判 corrupt）。 */
function tempBook(record: { tasks: Record<string, number> }): string {
  const d = mkdtempTracked(join(tmpdir(), 'clwriting-task-budget-i18n-'))
  mkdirSync(join(d, '.cache'), { recursive: true })
  const tasks: Record<string, unknown> = {}
  for (const [k, used] of Object.entries(record.tasks)) tasks[k] = { used, inputTokens: 0, outputTokens: 0 }
  writeFileSync(join(d, '.cache', 'ai-calls.json'), JSON.stringify({ chapter: CHAPTER, tasks }), 'utf-8')
  return d
}

afterEach(() => {
  /* mkdtempTracked 自管清理 */
})

describe('R0917-6-P3-5：checkAiTaskCallBudget 文案参数化', () => {
  it('缺省调用（chat 口径）：两条 reason 与改前逐字节一致', () => {
    const root = tempBook({ tasks: { chat: 3 } })
    const zero = checkAiTaskCallBudget(root, 'chat', 0)
    expect(zero.ok).toBe(false)
    if (!zero.ok) {
      expect(zero.reason).toBe(
        'chat 调用上限为 0（budget.chat_max_calls），按「一次都不许调」拦截。如需恢复对话请把 book.yaml 的 budget.chat_max_calls 调回正数',
      )
    }
    const over = checkAiTaskCallBudget(root, 'chat', 2)
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.reason).toBe(
        '本书对话已调用 3 次（上限 2，budget.chat_max_calls）。可临时提高 book.yaml 的 budget.chat_max_calls，或降低对话/压缩频率',
      )
    }
  })

  it('显式传 taskLabel/configKey：reason 指向第二类任务自己的配置键（不再误导去改 chat 项）', () => {
    const root = tempBook({ tasks: { review: 5 } })
    const over = checkAiTaskCallBudget(root, 'review', 3, '评审', 'budget.review_max_calls', '评审', '评审')
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.reason).toContain('本书评审已调用 5 次')
      expect(over.reason).toContain('或降低评审频率')
      expect(over.reason).toContain('budget.review_max_calls')
      expect(over.reason).not.toContain('chat_max_calls')
    }
    const zero = checkAiTaskCallBudget(root, 'review', 0, '评审', 'budget.review_max_calls', '评审', '评审')
    expect(zero.ok).toBe(false)
    if (!zero.ok) expect(zero.reason).not.toContain('chat_max_calls')
  })

  it('缺省 limit（未配键）：放行且零行为变化（连账本都不读）', () => {
    const root = tempBook({ tasks: { chat: 99 } })
    expect(checkAiTaskCallBudget(root, 'chat', undefined)).toEqual({ ok: true, used: 0 })
  })

  it('已达限判定按 task 维度分账（tasks[task].used），非 chat 任务不被 chat 计数牵连', () => {
    const root = tempBook({ tasks: { chat: 9 } })
    expect(checkAiTaskCallBudget(root, 'review', 5, '评审', 'budget.review_max_calls')).toEqual({ ok: true, used: 0 })
  })

  it('账本损坏仍保守阻断（文案与 task 无关，V-P2-10 口径不变）', () => {
    const d = mkdtempTracked(join(tmpdir(), 'clwriting-task-budget-i18n-'))
    mkdirSync(join(d, '.cache'), { recursive: true })
    writeFileSync(join(d, '.cache', 'ai-calls.json'), '{ 坏 JSON', 'utf-8')
    const r = checkAiTaskCallBudget(d, 'chat', 5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('损坏')
    // 读回不被本闸改写（纯读）
    expect(readFileSync(join(d, '.cache', 'ai-calls.json'), 'utf-8')).toBe('{ 坏 JSON')
  })
})
