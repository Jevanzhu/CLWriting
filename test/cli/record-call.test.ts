import { test, expect, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordCallCommand } from '../../src/cli/record-call.js'
import { aiCallBudgetPath } from '../../src/ai/calls.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

/** 造一个 git 书仓库（含 工作区 + book.yaml） */
function makeBook(limit = 8, kind: 'long' | 'short' = 'long'): string {
  const root = mkdtempSync(join(tmpdir(), 'record-call-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  const config: BookConfig = {
    ...DEFAULT_CONFIG,
    ...(kind === 'short' ? { kind: 'short' as const } : {}),
    budget: { ...DEFAULT_CONFIG.budget, calls_per_chapter: limit },
  }
  writeBookConfig(join(root, 'book.yaml'), config)
  mkdirSync(join(root, '工作区'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

interface Capture {
  out: string
  err: string
  exitCalled: boolean
}

/** 跑命令并捕获 console.log/error + process.exit */
function run(args: string[], bookRoot: string): Capture {
  const out: string[] = []
  const err: string[] = []
  let exitCalled = false
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')))
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')))
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    exitCalled = true
    throw new Error(`process.exit ${String(code)}`)
  }) as typeof process.exit)
  try {
    recordCallCommand([...args, bookRoot])
  } catch {
    // process.exit 抛出，正常
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
    exitSpy.mockRestore()
  }
  return { out: out.join('\n'), err: err.join('\n'), exitCalled }
}

function readBudget(root: string): { used: number; entries: { step: string; calls: number; tokens?: number }[] } {
  const raw = JSON.parse(readFileSync(aiCallBudgetPath(join(root, '工作区')), 'utf-8')) as {
    used: number
    entries: { step: string; calls: number; tokens?: number }[]
  }
  return { used: raw.used, entries: raw.entries }
}

test('record-call --step outline → 写入 outline entry，默认 calls=1', () => {
  const root = makeBook()
  const { out, exitCalled } = run(['1', '--step', 'outline'], root)
  expect(exitCalled).toBe(false)
  expect(out).toContain('outline')
  expect(existsSync(aiCallBudgetPath(join(root, '工作区')))).toBe(true)
  const budget = readBudget(root)
  expect(budget.used).toBe(1)
  expect(budget.entries).toHaveLength(1)
  expect(budget.entries[0]!.step).toBe('outline')
  expect(budget.entries[0]!.calls).toBe(1)
  rmSync(root, { recursive: true, force: true })
})

test('record-call --step draft --calls N --tokens M → 透传 calls 与 tokens', () => {
  const root = makeBook()
  const { exitCalled } = run(['1', '--step', 'draft', '--calls', '3', '--tokens', '2500'], root)
  expect(exitCalled).toBe(false)
  const budget = readBudget(root)
  expect(budget.used).toBe(3)
  expect(budget.entries[0]!.step).toBe('draft')
  expect(budget.entries[0]!.calls).toBe(3)
  expect(budget.entries[0]!.tokens).toBe(2500)
  rmSync(root, { recursive: true, force: true })
})

test('record-call short: 文案按篇展示，超限提示用每篇上限', () => {
  const root = makeBook(3, 'short')
  const first = run(['1', '--step', 'outline', '--calls', '2'], root)
  expect(first.exitCalled).toBe(false)
  expect(first.out).toContain('第 1 篇')
  expect(first.out).toContain('本篇累计 2/3')
  expect(first.out).not.toContain('本章累计')

  const second = run(['1', '--step', 'draft', '--calls', '2'], root)
  expect(second.exitCalled).toBe(true)
  expect(second.err).toContain('超过每篇上限 3')
  expect(second.err).not.toContain('超过每章上限')
  rmSync(root, { recursive: true, force: true })
})

test('record-call --set-tokens → 回填最近一次 step，不增加 calls', () => {
  const root = makeBook()
  run(['1', '--step', 'draft', '--calls', '2'], root)
  const { out, exitCalled } = run(['1', '--step', 'draft', '--set-tokens', '4096'], root)

  expect(exitCalled).toBe(false)
  expect(out).toContain('已回填')
  const budget = readBudget(root)
  expect(budget.used).toBe(2)
  expect(budget.entries).toHaveLength(1)
  expect(budget.entries[0]!.tokens).toBe(4096)
  rmSync(root, { recursive: true, force: true })
})

test('record-call --set-tokens 无对应 step → 拒绝且不新增调用', () => {
  const root = makeBook()
  run(['1', '--step', 'outline'], root)
  const { err, exitCalled } = run(['1', '--step', 'draft', '--set-tokens', '123'], root)

  expect(exitCalled).toBe(true)
  expect(err).toContain('没有 draft 调用记录')
  const budget = readBudget(root)
  expect(budget.used).toBe(1)
  expect(budget.entries).toHaveLength(1)
  rmSync(root, { recursive: true, force: true })
})

test('record-call --step review 被拒（review 由 review collect 自动记）', () => {
  const root = makeBook()
  const { err, exitCalled } = run(['1', '--step', 'review'], root)
  expect(exitCalled).toBe(true)
  expect(err).toContain('review')
  expect(err).toContain('outline / draft')
  expect(existsSync(aiCallBudgetPath(join(root, '工作区')))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('record-call outline 后再 draft：累计 used 正确（预算闸续跑）', () => {
  const root = makeBook()
  run(['1', '--step', 'outline'], root)
  run(['1', '--step', 'draft', '--calls', '2'], root)
  const budget = readBudget(root)
  expect(budget.used).toBe(3) // 1 outline + 2 draft
  expect(budget.entries.map((e) => e.step)).toEqual(['outline', 'draft'])
  rmSync(root, { recursive: true, force: true })
})

test('record-call: 清理过期写锁后继续记账', () => {
  const root = makeBook()
  const lockDir = join(root, '工作区', '.ai-calls.lock')
  mkdirSync(lockDir)
  const old = new Date(Date.now() - 60_000)
  utimesSync(lockDir, old, old)

  const { out, exitCalled } = run(['1', '--step', 'outline'], root)

  expect(exitCalled).toBe(false)
  expect(out).toContain('outline')
  expect(existsSync(lockDir)).toBe(false)
  const budget = readBudget(root)
  expect(budget.used).toBe(1)
  expect(budget.entries).toHaveLength(1)
  rmSync(root, { recursive: true, force: true })
})

test('record-call 合计触顶 calls_per_chapter → 预算闸拒绝', () => {
  const root = makeBook(3) // 上限 3
  run(['1', '--step', 'outline', '--calls', '2'], root) // used=2
  const { err, exitCalled } = run(['1', '--step', 'draft', '--calls', '2'], root) // 2+2=4 超限
  expect(exitCalled).toBe(true)
  expect(err).toContain('超过每章上限')
  // 上一次成功记账未被覆盖
  expect(readBudget(root).used).toBe(2)
  rmSync(root, { recursive: true, force: true })
})

test('record-call 章号与已有计数不符 → 拒绝（复用 recordAiCall 守卫）', () => {
  const root = makeBook()
  run(['5', '--step', 'outline'], root) // 记到第 5 章
  const { err, exitCalled } = run(['6', '--step', 'draft'], root) // 第 6 章撞残留
  expect(exitCalled).toBe(true)
  expect(err).toContain('不是第 6 章')
  rmSync(root, { recursive: true, force: true })
})

test('record-call 非法章号 → 拒绝', () => {
  const root = makeBook()
  const { err, exitCalled } = run(['abc', '--step', 'outline'], root)
  expect(exitCalled).toBe(true)
  expect(err).toContain('正整数')
  rmSync(root, { recursive: true, force: true })
})

test('record-call --calls 0 → 拒绝且不写坏调用计数', () => {
  const root = makeBook()
  const { err, exitCalled } = run(['1', '--step', 'draft', '--calls', '0'], root)
  expect(exitCalled).toBe(true)
  expect(err).toContain('--calls')
  expect(err).toContain('正整数')
  expect(existsSync(aiCallBudgetPath(join(root, '工作区')))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('record-call 非法数值参数 → 拒绝，不静默退回默认值', () => {
  const root = makeBook()

  for (const args of [
    ['1', '--step', 'draft', '--calls', 'bad'],
    ['1', '--step', 'draft', '--calls'],
    ['1', '--step', 'draft', '--tokens', 'bad'],
    ['1', '--step', 'draft', '--tokens', '-1'],
    ['1', '--step', 'draft', '--set-tokens', 'bad'],
    ['1', '--step', 'draft', '--set-tokens', '-1'],
  ]) {
    const { err, exitCalled } = run(args, root)
    expect(exitCalled).toBe(true)
    expect(err).toMatch(/--calls|--tokens|--set-tokens/)
  }

  expect(existsSync(aiCallBudgetPath(join(root, '工作区')))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('record-call 缺 --step → 打印用法并退出', () => {
  const root = makeBook()
  const { err, exitCalled } = run(['1'], root)
  expect(exitCalled).toBe(true)
  expect(err).toContain('用法')
  rmSync(root, { recursive: true, force: true })
})

test('record-call --help → 含用法与参数说明', () => {
  const root = makeBook()
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => lines.push(a.map(String).join(' ')))
  try {
    recordCallCommand(['--help'])
  } finally {
    spy.mockRestore()
  }
  const out = lines.join('\n')
  expect(out).toContain('用法')
  expect(out).toContain('--step')
  expect(out).toContain('--calls')
  expect(out).toContain('--tokens')
  expect(out).toContain('--set-tokens')
  rmSync(root, { recursive: true, force: true })
})
