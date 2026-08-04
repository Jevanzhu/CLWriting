/**
 * trace-stats 聚合单测（AI Harness T3）。
 *
 * 覆盖：空数据、单 task 多条聚合、通过率/attempt/百分位/token 趋势、多 task 分组。
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendTrace } from '../../src/ai/trace.js'
import { aggregateTrace } from '../../src/ai/trace-stats.js'

const dirs: string[] = []

function tempBookRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'clwriting-stats-'))
  dirs.push(d)
  mkdirSync(join(d, '.cache'), { recursive: true })
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('aggregateTrace', () => {
  it('空数据 → total=0', () => {
    const root = tempBookRoot()
    const stats = aggregateTrace(root)
    expect(stats.total).toBe(0)
    expect(Object.keys(stats.byTask)).toHaveLength(0)
  })

  it('单 task 多条 → 通过率 / 平均 attempt / token 合计', () => {
    const root = tempBookRoot()
    appendTrace(root, { runId: '1', ts: '2026-08-01T10:00:00Z', task: 'self-heal', tierKind: 'creative', model: 'm1', attempt: 0, stopReason: 'end_turn', promptMeta: { chars: 100, files: [], hash: 'a' }, usage: { input: 100, output: 50 }, durationMs: 1000, ok: true })
    appendTrace(root, { runId: '2', ts: '2026-08-01T11:00:00Z', task: 'self-heal', tierKind: 'creative', model: 'm1', attempt: 1, stopReason: 'end_turn', promptMeta: { chars: 100, files: [], hash: 'b' }, usage: { input: 200, output: 100 }, durationMs: 2000, ok: true })
    appendTrace(root, { runId: '3', ts: '2026-08-01T12:00:00Z', task: 'self-heal', tierKind: 'creative', model: 'm1', attempt: 2, stopReason: 'error', promptMeta: { chars: 100, files: [], hash: 'c' }, usage: { input: 50, output: 0 }, durationMs: 500, ok: false })

    const stats = aggregateTrace(root)
    expect(stats.total).toBe(3)

    const t = stats.byTask['self-heal']!
    expect(t.count).toBe(3)
    expect(t.successRate).toBeCloseTo(2 / 3, 2)
    expect(t.avgAttempts).toBeCloseTo(1, 2) // (0+1+2)/3
    expect(t.totalInputTokens).toBe(350)
    expect(t.totalOutputTokens).toBe(150)
  })

  it('百分位 p50/p95 从排序后的 durationMs 取值', () => {
    const root = tempBookRoot()
    // 10 条，durationMs 100~1000
    for (let i = 1; i <= 10; i++) {
      appendTrace(root, { runId: String(i), ts: '2026-08-01T10:00:00Z', task: 'review', tierKind: 'assistant', model: 'm', attempt: 0, stopReason: 'end_turn', promptMeta: { chars: 0, files: [], hash: '' }, usage: { input: 0, output: 0 }, durationMs: i * 100, ok: true })
    }

    const t = aggregateTrace(root).byTask['review']!
    // 排序后 [100, 200, ..., 1000]，p50 ≈ 500~600，p95 ≈ 1000
    expect(t.durationP50).toBeGreaterThanOrEqual(500)
    expect(t.durationP50).toBeLessThanOrEqual(600)
    expect(t.durationP95).toBe(1000)
  })

  it('多 task 分组', () => {
    const root = tempBookRoot()
    appendTrace(root, { runId: '1', ts: '2026-08-01T10:00:00Z', task: 'self-heal', tierKind: 'creative', model: 'm', attempt: 0, stopReason: 'end_turn', promptMeta: { chars: 0, files: [], hash: '' }, usage: { input: 0, output: 0 }, durationMs: 100, ok: true })
    appendTrace(root, { runId: '2', ts: '2026-08-01T10:00:00Z', task: 'analysis', tierKind: 'assistant', model: 'm', attempt: 0, stopReason: 'end_turn', promptMeta: { chars: 0, files: [], hash: '' }, usage: { input: 0, output: 0 }, durationMs: 200, ok: true })
    appendTrace(root, { runId: '3', ts: '2026-08-01T10:00:00Z', task: 'outline', tierKind: 'creative', model: 'm', attempt: 0, stopReason: 'end_turn', promptMeta: { chars: 0, files: [], hash: '' }, usage: { input: 0, output: 0 }, durationMs: 300, ok: false })

    const stats = aggregateTrace(root)
    expect(stats.total).toBe(3)
    expect(Object.keys(stats.byTask).sort()).toEqual(['analysis', 'outline', 'self-heal'])
  })

  it('按天趋势', () => {
    const root = tempBookRoot()
    appendTrace(root, { runId: '1', ts: '2026-08-01T10:00:00Z', task: 't', tierKind: 'creative', model: 'm', attempt: 0, stopReason: 'end_turn', promptMeta: { chars: 0, files: [], hash: '' }, usage: { input: 100, output: 50 }, durationMs: 100, ok: true })
    appendTrace(root, { runId: '2', ts: '2026-08-02T10:00:00Z', task: 't', tierKind: 'creative', model: 'm', attempt: 0, stopReason: 'end_turn', promptMeta: { chars: 0, files: [], hash: '' }, usage: { input: 200, output: 100 }, durationMs: 200, ok: false })

    const t = aggregateTrace(root).byTask['t']!
    expect(Object.keys(t.byDay).sort()).toEqual(['2026-08-01', '2026-08-02'])
    expect(t.byDay['2026-08-01']!.successRate).toBe(1)
    expect(t.byDay['2026-08-02']!.successRate).toBe(0)
    expect(t.byDay['2026-08-01']!.tokens).toBe(150)
    expect(t.byDay['2026-08-02']!.tokens).toBe(300)
  })
})
