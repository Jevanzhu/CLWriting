/**
 * 预算闸单测（C 档计量接回）。
 *
 * 覆盖：recordAiCall 落账 + tokens 累加、checkAiCallBudget 超限判定、换章重置。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordAiCall, checkAiCallBudget } from '../../src/ai/calls.js'
import type { BookConfig } from '../../src/format/types.js'

const dirs: string[] = []
function tempBook(): string {
  const d = mkdtempSync(join(tmpdir(), 'clwriting-calls-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CONFIG = { budget: { calls_per_chapter: 3 } } as unknown as BookConfig

describe('recordAiCall 记账', () => {
  it('一次生成后落账', () => {
    const root = tempBook()
    recordAiCall(root, 1, { inputTokens: 100, outputTokens: 200 })
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.used).toBe(1)
  })

  it('多次调用累计计数', () => {
    const root = tempBook()
    recordAiCall(root, 1, { inputTokens: 100, outputTokens: 200 })
    recordAiCall(root, 1, { inputTokens: 50, outputTokens: 150 })
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.used).toBe(2)
  })

  it('usage 为 null 时只计数', () => {
    const root = tempBook()
    recordAiCall(root, 1, null)
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.used).toBe(1)
  })
})

describe('checkAiCallBudget 预算判定', () => {
  it('未超限 → ok=true', () => {
    const root = tempBook()
    recordAiCall(root, 1, { inputTokens: 100, outputTokens: 200 })
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.used).toBe(1)
  })

  it('达到上限 → ok=false + reason 含上限值', () => {
    const root = tempBook()
    recordAiCall(root, 1, null)
    recordAiCall(root, 1, null)
    recordAiCall(root, 1, null)
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toContain('3')
  })

  it('换章 → 计数重置为 0', () => {
    const root = tempBook()
    recordAiCall(root, 1, null)
    recordAiCall(root, 1, null)
    recordAiCall(root, 1, null)
    const b = checkAiCallBudget(root, 2, CONFIG)
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.used).toBe(0)
  })
})
