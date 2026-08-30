/**
 * A-6（二十九轮）：估计口径 token/cost 照实入账但 ai-calls.json 账本无 estimated 标记
 * ——账实对账无法区分实测/估计。修复：chapter 块与 tasks 块加性增加 estimated 布尔
 * （估计 usage 累入即粘性置位；readRecord 读侧加性收原样保留，错型按未标记丢弃不判
 * 损坏）。消费方（预算闸/报表）只读数值字段，加性安全。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordAiCall, recordTaskUsage } from '../../src/ai/calls.js'
import type { TokenUsage } from '../../src/ai/provider/types.js'

let bookRoot: string

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'r29-calls-'))
  mkdirSync(join(bookRoot, '.cache'), { recursive: true })
})

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

function rawRecord(): { chapter: Record<string, unknown>; tasks: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(bookRoot, '.cache', 'ai-calls.json'), 'utf8'))
}

test('A-6① 估计 usage 入账：chapter 与 tasks 块置 estimated 标记，数值照常累计', () => {
  const est: TokenUsage = { inputTokens: 100, outputTokens: 50, estimated: true }
  recordTaskUsage(bookRoot, 'self-heal', est)
  recordAiCall(bookRoot, 3, est, 0.0125)

  const rec = rawRecord()
  expect(rec.tasks['self-heal']).toMatchObject({ used: 1, inputTokens: 100, outputTokens: 50, estimated: true })
  expect(rec.chapter).toMatchObject({ num: 3, used: 1, inputTokens: 100, outputTokens: 50, estimated: true })
  expect(rec.chapter['costAccum']).toBeCloseTo(0.0125, 10) // 估计口径的 cost 也照实入账
})

test('A-6② 标记粘性 + 纯实测块不带标记 + 含标记记录往返不判损坏', () => {
  recordTaskUsage(bookRoot, 'review', { inputTokens: 10, outputTokens: 5, estimated: true })
  // 粘性：后续非估计记账不清标记（块内数字已是实测/估计混合）
  recordTaskUsage(bookRoot, 'review', { inputTokens: 1, outputTokens: 1 })
  // 纯实测块：无标记
  recordTaskUsage(bookRoot, 'analysis', { inputTokens: 1, outputTokens: 1 })

  const rec = rawRecord()
  expect(rec.tasks['review']).toMatchObject({ used: 2, estimated: true })
  expect(rec.tasks['analysis']).toMatchObject({ used: 1 })
  expect(rec.tasks['analysis']?.['estimated']).toBeUndefined()

  // 往返不损坏：含标记的账本继续记账照常推进（readRecord 若误判损坏会跳过记账，
  // used 恒 1 不再增长）
  recordTaskUsage(bookRoot, 'review', { inputTokens: 1, outputTokens: 1 })
  expect(rawRecord().tasks['review']).toMatchObject({ used: 3, estimated: true })
})

test('A-6③ 章块标记随换章重置（新章新账）', () => {
  recordAiCall(bookRoot, 1, { inputTokens: 10, outputTokens: 5, estimated: true })
  expect(rawRecord().chapter['estimated']).toBe(true)
  recordAiCall(bookRoot, 2, { inputTokens: 10, outputTokens: 5 }) // 换章重置
  const rec = rawRecord()
  expect(rec.chapter['num']).toBe(2)
  expect(rec.chapter['estimated']).toBeUndefined()
})
