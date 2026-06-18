import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import {
  aiCallBudgetPath,
  checkAiCallBudget,
  clearAiCallBudget,
  getAiCallBudgetState,
  recordAiCall,
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
