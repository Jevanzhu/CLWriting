import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import {
  aiCallBudgetPath,
  checkAiCallBudget,
  clearAiCallBudget,
  getAiCallBudgetState,
  recordAiCall,
  setAiCallTokens,
  setAiCallLimitOverride,
} from '../../src/ai/calls.js'
import type { BookConfig } from '../../src/format/types.js'

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), '北境调用-'))
}

function configWithLimit(limit: number): BookConfig {
  return { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, calls_per_chapter: limit } }
}

test('调用预算: 无记录视为本章 0 次', () => {
  const workDir = makeWorkDir()
  const state = getAiCallBudgetState(workDir, 12, DEFAULT_CONFIG)
  expect(state.ok).toBe(true)
  if (state.ok) {
    expect(state.used).toBe(0)
    expect(state.limit).toBe(8)
    expect(state.remaining).toBe(8)
  }
  rmSync(workDir, { recursive: true, force: true })
})

test('调用预算: 续跑继承已用次数，未超放行并记录留痕', () => {
  const workDir = makeWorkDir()
  const config = configWithLimit(8)

  const r1 = recordAiCall({ workDir, chapter: 12, config, step: 'outline', at: '2026-06-18T00:00:00.000Z' })
  expect(r1.ok).toBe(true)
  const r2 = recordAiCall({ workDir, chapter: 12, config, step: 'draft', calls: 3, at: '2026-06-18T00:01:00.000Z' })
  expect(r2.ok).toBe(true)

  const decision = checkAiCallBudget({ workDir, chapter: 12, config, plannedCalls: 3, label: '满审' })
  expect(decision.ok).toBe(true)
  if (decision.ok) {
    expect(decision.used).toBe(4)
    expect(decision.projected).toBe(7)
    expect(decision.remaining).toBe(1)
  }

  const state = getAiCallBudgetState(workDir, 12, config)
  expect(state.ok).toBe(true)
  if (state.ok) {
    expect(state.record?.entries).toHaveLength(2)
  }
  rmSync(workDir, { recursive: true, force: true })
})

test('调用预算: 将超上限时拒绝并给决策提示', () => {
  const workDir = makeWorkDir()
  const config = configWithLimit(4)
  recordAiCall({ workDir, chapter: 3, config, step: 'outline', calls: 1 })
  recordAiCall({ workDir, chapter: 3, config, step: 'draft', calls: 3 })

  const decision = checkAiCallBudget({ workDir, chapter: 3, config, plannedCalls: 1, label: '设定校对' })
  expect(decision.ok).toBe(false)
  if (!decision.ok) {
    expect(decision.reason).toContain('超过每章上限 4')
    expect(decision.reason).toContain('降低 best-of-N')
  }
  rmSync(workDir, { recursive: true, force: true })
})

test('调用预算 short: 将超上限时按篇提示', () => {
  const workDir = makeWorkDir()
  const config: BookConfig = { ...configWithLimit(4), kind: 'short' }
  recordAiCall({ workDir, chapter: 3, config, step: 'outline', calls: 1 })
  recordAiCall({ workDir, chapter: 3, config, step: 'draft', calls: 3 })

  const decision = checkAiCallBudget({ workDir, chapter: 3, config, plannedCalls: 1, label: '短篇满审' })
  expect(decision.ok).toBe(false)
  if (!decision.ok) {
    expect(decision.reason).toContain('本篇已调用 AI 4 次')
    expect(decision.reason).toContain('超过每篇上限 4')
    expect(decision.reason).not.toContain('每章上限')
  }
  rmSync(workDir, { recursive: true, force: true })
})

test('调用预算: recordAiCall 拒绝非正 calls，避免写出不可读计数', () => {
  const workDir = makeWorkDir()
  const config = configWithLimit(8)
  const record = recordAiCall({ workDir, chapter: 1, config, step: 'draft', calls: 0 })
  expect(record.ok).toBe(false)
  if (!record.ok) expect(record.reason).toContain('正整数')
  expect(existsSync(aiCallBudgetPath(workDir))).toBe(false)
  rmSync(workDir, { recursive: true, force: true })
})

test('调用预算: 损坏文件保守阻断，不静默归零', () => {
  const workDir = makeWorkDir()
  const config = configWithLimit(8)
  writeFileSync(aiCallBudgetPath(workDir), '{broken', 'utf-8')

  const state = getAiCallBudgetState(workDir, 8, config)
  expect(state.ok).toBe(false)
  if (!state.ok) {
    expect(state.used).toBe(8)
    expect(state.reason).toContain('按已达上限处理')
  }
  const record = recordAiCall({ workDir, chapter: 8, config, step: 'outline' })
  expect(record.ok).toBe(false)
  rmSync(workDir, { recursive: true, force: true })
})

test('调用预算: 章节不匹配时阻断，避免工作区残留串章', () => {
  const workDir = makeWorkDir()
  const config = configWithLimit(8)
  recordAiCall({ workDir, chapter: 5, config, step: 'outline' })

  const decision = checkAiCallBudget({ workDir, chapter: 6, config, plannedCalls: 1, label: '细纲' })
  expect(decision.ok).toBe(false)
  if (!decision.ok) {
    expect(decision.reason).toContain('属于第 5 章')
  }
  rmSync(workDir, { recursive: true, force: true })
})

test('调用预算: 本章临时提额只写机器域记录，clear 会删除', () => {
  const workDir = makeWorkDir()
  const config = configWithLimit(4)
  recordAiCall({ workDir, chapter: 9, config, step: 'outline', calls: 4 })

  const before = checkAiCallBudget({ workDir, chapter: 9, config, plannedCalls: 1, label: '满审' })
  expect(before.ok).toBe(false)

  const override = setAiCallLimitOverride(workDir, 9, config, 6)
  expect(override.ok).toBe(true)
  const after = checkAiCallBudget({ workDir, chapter: 9, config, plannedCalls: 1, label: '满审' })
  expect(after.ok).toBe(true)

  clearAiCallBudget(workDir)
  expect(existsSync(aiCallBudgetPath(workDir))).toBe(false)
  rmSync(workDir, { recursive: true, force: true })
})

test('recordAiCall: tokens 可选透传进 entry，缺省不写字段', () => {
  const workDir = makeWorkDir()
  const config = configWithLimit(8)
  // outline 不带 tokens
  recordAiCall({ workDir, chapter: 1, config, step: 'outline', at: 't1' })
  // draft 带 tokens
  recordAiCall({ workDir, chapter: 1, config, step: 'draft', calls: 2, tokens: 1800, at: 't2' })

  const state = getAiCallBudgetState(workDir, 1, config)
  expect(state.ok).toBe(true)
  if (state.ok && state.record) {
    const [outline, draft] = state.record.entries
    expect(outline!.step).toBe('outline')
    expect(outline!.tokens).toBeUndefined() // 缺省不写
    expect(draft!.step).toBe('draft')
    expect(draft!.tokens).toBe(1800)
  }
  rmSync(workDir, { recursive: true, force: true })
})

test('recordAiCall: tokens 持久化往返（写盘 → 重读 normalizeEntry 保留 tokens）', () => {
  const workDir = makeWorkDir()
  const config = configWithLimit(8)
  recordAiCall({ workDir, chapter: 7, config, step: 'draft', calls: 1, tokens: 4096, at: 't' })

  // 重新读盘（normalizeRecord → normalizeEntry）
  const reRead = getAiCallBudgetState(workDir, 7, config)
  expect(reRead.ok).toBe(true)
  if (reRead.ok && reRead.record) {
    expect(reRead.record.entries[0]!.tokens).toBe(4096)
  }

  // 非法 tokens（字符串）被 normalizeEntry 容错丢弃，不阻断读取
  const raw = JSON.parse(readFileSync(aiCallBudgetPath(workDir), 'utf-8')) as { entries: { tokens: unknown }[] }
  raw.entries[0]!.tokens = 'bad'
  writeFileSync(aiCallBudgetPath(workDir), JSON.stringify(raw), 'utf-8')
  const afterBad = getAiCallBudgetState(workDir, 7, config)
  expect(afterBad.ok).toBe(true)
  if (afterBad.ok && afterBad.record) {
    expect(afterBad.record.entries[0]!.tokens).toBeUndefined()
  }
  rmSync(workDir, { recursive: true, force: true })
})

test('setAiCallTokens: 事后回填最近一次 step 的 token，不增加调用次数', () => {
  const workDir = makeWorkDir()
  const config = configWithLimit(8)
  recordAiCall({ workDir, chapter: 1, config, step: 'outline', at: 't1' })
  recordAiCall({ workDir, chapter: 1, config, step: 'draft', calls: 2, at: 't2' })

  const updated = setAiCallTokens({ workDir, chapter: 1, config, step: 'draft', tokens: 3600, at: 't3' })

  expect(updated.ok).toBe(true)
  const state = getAiCallBudgetState(workDir, 1, config)
  expect(state.ok).toBe(true)
  if (state.ok && state.record) {
    expect(state.record.used).toBe(3)
    expect(state.record.entries).toHaveLength(2)
    expect(state.record.entries[0]!.tokens).toBeUndefined()
    expect(state.record.entries[1]!.tokens).toBe(3600)
    expect(state.record.updated_at).toBe('t3')
  }
  rmSync(workDir, { recursive: true, force: true })
})
