/**
 * trace 模块单测（AI Harness T2）。
 *
 * 覆盖：appendTrace 写入、readTraceLines 读取、轮转（>5MB rename）、
 * 损坏行容错（坏行跳过不炸）、promptMeta 脱敏（不落原文）。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendTrace,
  readTraceLines,
  promptMeta,
  newRunId,
  type TraceEntry,
} from '../../src/ai/trace.js'

const dirs: string[] = []

function tempBookRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'clwriting-trace-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeEntry(runId: string, task: string, overrides?: Partial<TraceEntry>): TraceEntry {
  return {
    runId,
    ts: new Date().toISOString(),
    task,
    tierKind: 'creative',
    model: 'test-model',
    attempt: 0,
    stopReason: 'end_turn',
    promptMeta: { chars: 100, files: [], hash: 'abc123' },
    usage: { input: 50, output: 30 },
    durationMs: 500,
    ok: true,
    ...overrides,
  }
}

describe('appendTrace + readTraceLines', () => {
  it('写入一条 → 读回一条，字段完整', () => {
    const root = tempBookRoot()
    const id = newRunId()
    appendTrace(root, makeEntry(id, 'self-heal'))

    const lines = readTraceLines(root)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.runId).toBe(id)
    expect(lines[0]!.task).toBe('self-heal')
    expect(lines[0]!.ok).toBe(true)
  })

  it('写入多条 → 按时间序读回', () => {
    const root = tempBookRoot()
    appendTrace(root, makeEntry(newRunId(), 'outline'))
    appendTrace(root, makeEntry(newRunId(), 'self-heal'))
    appendTrace(root, makeEntry(newRunId(), 'review'))

    const lines = readTraceLines(root)
    expect(lines.map((l) => l.task)).toEqual(['outline', 'self-heal', 'review'])
  })
})

describe('轮转', () => {
  it('文件超 5MB → rename 为 ai-trace.1.jsonl', () => {
    const root = tempBookRoot()
    // 手动写一个 > 5MB 的文件
    const cacheDir = join(root, '.cache')
    
    mkdirSync(cacheDir, { recursive: true })
    const big = 'x'.repeat(5 * 1024 * 1024 + 100)
    writeFileSync(join(cacheDir, 'ai-trace.jsonl'), big)

    // appendTrace 应触发轮转
    appendTrace(root, makeEntry(newRunId(), 'after-rotate'))

    // 旧文件 → ai-trace.1.jsonl
    expect(existsSync(join(cacheDir, 'ai-trace.1.jsonl'))).toBe(true)
    // 新文件应该是小的（只有一条 trace）
    const newSize = statSync(join(cacheDir, 'ai-trace.jsonl')).size
    expect(newSize).toBeLessThan(1000)
    // 轮转代 + 当前代都能读
    const lines = readTraceLines(root)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(lines.at(-1)!.task).toBe('after-rotate')
  })
})

describe('损坏行容错', () => {
  it('坏行跳过不炸，好行正常读回', () => {
    const root = tempBookRoot()
    const fp = join(root, '.cache', 'ai-trace.jsonl')
    
    mkdirSync(join(root, '.cache'), { recursive: true })

    // 写入：好行 + 坏行 + 好行
    const good1 = JSON.stringify(makeEntry(newRunId(), 'good-1'))
    const bad = '{ this is not valid json }}}'
    const good2 = JSON.stringify(makeEntry(newRunId(), 'good-2'))
    writeFileSync(fp, `${good1}\n${bad}\n${good2}\n`)

    const lines = readTraceLines(root)
    expect(lines).toHaveLength(2) // 坏行跳过
    expect(lines[0]!.task).toBe('good-1')
    expect(lines[1]!.task).toBe('good-2')
  })
})

describe('promptMeta 脱敏', () => {
  it('只记录字符数 + hash，不落原文', () => {
    const text = '这是一段需要脱敏的 prompt 文本，不应出现在 trace 中'
    const meta = promptMeta('', text)

    expect(meta.chars).toBe(text.length)
    expect(meta.hash).toHaveLength(16)
    expect(meta.hash).toMatch(/^[0-9a-f]+$/)
    // 确认原文不在 meta 中
    expect(JSON.stringify(meta)).not.toContain('需要脱敏')
  })

  it('相同 prompt → 相同 hash', () => {
    const text = '一致性测试'
    expect(promptMeta('', text).hash).toBe(promptMeta('', text).hash)
  })

  it('不同 prompt → 不同 hash', () => {
    expect(promptMeta('', 'A').hash).not.toBe(promptMeta('', 'B').hash)
  })
})

describe('runId 唯一性', () => {
  it('每次调用生成不同 ID', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) ids.add(newRunId())
    expect(ids.size).toBe(100)
  })
})
