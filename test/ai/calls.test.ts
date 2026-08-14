/**
 * 预算闸单测（C 档计量接回）。
 *
 * 覆盖：recordAiCall 落账 + tokens 累加、checkAiCallBudget 超限判定、换章重置。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordAiCall, checkAiCallBudget, recordTaskUsage } from '../../src/ai/calls.js'
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

describe('recordTaskUsage 任务维度记账（T5）', () => {
  it('一次 task 调用 → tasks 块出现对应键', () => {
    const root = tempBook()
    recordTaskUsage(root, 'analysis', { inputTokens: 100, outputTokens: 200 })
    const rec = JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8'))
    expect(rec.tasks['analysis']).toEqual(expect.objectContaining({ used: 1, inputTokens: 100 }))
    expect(rec.tasks['analysis'].used).toBe(1)
    expect(rec.tasks['analysis'].inputTokens).toBe(100)
  })

  it('多次同 task → 累计计数', () => {
    const root = tempBook()
    recordTaskUsage(root, 'review', { inputTokens: 50, outputTokens: 50 })
    recordTaskUsage(root, 'review', { inputTokens: 30, outputTokens: 70 })
    const rec = JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8'))
    expect(rec.tasks['review'].used).toBe(2)
    expect(rec.tasks['review'].inputTokens).toBe(80)
  })

  it('换章不影响 task 块（不重置）', () => {
    const root = tempBook()
    recordTaskUsage(root, 'outline', null)
    recordAiCall(root, 1, null) // 记 chapter 块
    recordAiCall(root, 2, null) // 换章
    // task 块应仍在
    const rec = JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8'))
    expect(rec.tasks['outline'].used).toBe(1)
  })

  it('多 task 共存', () => {
    const root = tempBook()
    recordTaskUsage(root, 'analysis', null)
    recordTaskUsage(root, 'review', null)
    recordTaskUsage(root, 'outline', null)
    const rec = JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8'))
    expect(Object.keys(rec.tasks).sort()).toEqual(['analysis', 'outline', 'review'])
  })
})

describe('旧格式迁移（T5）', () => {
  it('旧 flat 格式自动迁移为新 chapter+tasks 结构', () => {
    const root = tempBook()
    // 手写旧格式
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(
      join(root, '.cache', 'ai-calls.json'),
      JSON.stringify({ chapter: 5, used: 2, inputTokens: 100, outputTokens: 200 }) + '\n',
    )
    // 读触发迁移（checkAiCallBudget → readRecord）
    const b = checkAiCallBudget(root, 5, CONFIG)
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.used).toBe(2)

    // 再读确认迁移后结构正确
    const rec = JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8'))
    expect(rec.chapter).toEqual({ num: 5, used: 2, inputTokens: 100, outputTokens: 200 })
    expect(rec.tasks).toEqual({})
  })
})

// ── V-P2-10：记账文件损坏 → 预算闸保守阻断（与头注释承诺一致，此前静默放行归零）──

describe('ai-calls.json 损坏保守阻断（V-P2-10）', () => {
  it('JSON 损坏 → ok=false + 人话提示（不再当无记录放行）', () => {
    const root = tempBook()
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'ai-calls.json'), '{ 损坏的 JSON', 'utf8')
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toContain('损坏')
  })

  it('形状不对（chapter 非法）→ 同样阻断', () => {
    const root = tempBook()
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'ai-calls.json'), JSON.stringify({ chapter: { num: 'x' }, tasks: {} }), 'utf8')
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(false)
  })

  it('无文件（新书）→ 正常放行不受影响', () => {
    const root = tempBook()
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(true)
  })

  it('损坏后记账不重置（W-P2-8）：recordAiCall/recordTaskUsage 跳过，阻断保持', () => {
    const root = tempBook()
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'ai-calls.json'), 'garbage', 'utf8')
    recordAiCall(root, 1, { inputTokens: 1, outputTokens: 1 })
    recordTaskUsage(root, 'review', null)
    // 文件保持损坏（未被新账本覆盖）→ 保守阻断持续，只能人工删除恢复
    expect(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8')).toBe('garbage')
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(false)
  })
})
