/**
 * trace-stats 聚合单测（AI Harness T3；P2 后从事件库 llm/call 派生）。
 *
 * 覆盖：空数据、单 task 多条聚合、通过率/attempt/百分位/token 趋势、多 task 分组、
 * 按天趋势（事件创建时间聚日）、userDataPath 缺失降级。
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { llmCallEvent } from '../../src/events/chain-bridge.js'
import { aggregateTrace } from '../../src/ai/trace-stats.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []

function tempUserData(): string {
  const d = mkdtempTracked(join(tmpdir(), 'clwriting-ud-'))
  dirs.push(d)
  return d
}

function tempBookRoot(): string {
  const d = mkdtempTracked(join(tmpdir(), 'clwriting-stats-'))
  dirs.push(d)
  return d
}

/** 写一条 llm/call 事件到 workspace 会话 */
function writeCall(
  userDataPath: string,
  bookRoot: string,
  p: {
    task: string
    attempt?: number
    ok?: boolean
    usage?: { input: number; output: number }
    durationMs?: number
    errCode?: string
  },
): void {
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    const sid = store.workspaceSession(bookHash(bookRoot))
    store.appendEvent(
      sid,
      llmCallEvent({
        runId: 'r-' + Math.random().toString(36).slice(2),
        task: p.task,
        tierKind: 'creative',
        model: 'm',
        attempt: p.attempt ?? 0,
        stopReason: p.ok === false ? 'error' : 'end_turn',
        usage: p.usage,
        durationMs: p.durationMs ?? 100,
        ok: p.ok ?? true,
        ...(p.errCode ? { errCode: p.errCode } : {}),
      }),
    )
  } finally {
    store.close()
  }
}

/** 把全部事件创建时间往前调 offsetDays 天（按天趋势测试用） */
function shiftEventDays(userDataPath: string, bookRoot: string, offsetDays: number): void {
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    const db = new DatabaseSync(store.dbPath)
    db.prepare('UPDATE events SET created_at = created_at - ?').run(offsetDays * 86400000)
    db.close()
  } finally {
    store.close()
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('aggregateTrace（P2：从事件库 llm/call 派生）', () => {
  it('空数据 → total=0', async () => {
    const user = tempUserData()
    const root = tempBookRoot()
    const stats = await aggregateTrace(user, root)
    expect(stats.total).toBe(0)
    expect(Object.keys(stats.byTask)).toHaveLength(0)
  })

  it('单 task 多条 → 通过率 / 平均 attempt / token 合计', async () => {
    const user = tempUserData()
    const root = tempBookRoot()
    writeCall(user, root, { task: 'self-heal', attempt: 0, ok: true, usage: { input: 100, output: 50 } })
    writeCall(user, root, { task: 'self-heal', attempt: 1, ok: true, usage: { input: 120, output: 60 } })
    writeCall(user, root, { task: 'self-heal', attempt: 2, ok: false, usage: { input: 130, output: 40 } })

    const stats = await aggregateTrace(user, root)
    expect(stats.total).toBe(3)
    const t = stats.byTask['self-heal']!
    expect(t.count).toBe(3)
    expect(t.successRate).toBeCloseTo(2 / 3, 2)
    expect(t.avgAttempts).toBeCloseTo(1, 2)
    expect(t.totalInputTokens).toBe(350)
    expect(t.totalOutputTokens).toBe(150)
  })

  it('百分位 p50/p95 从排序后的 durationMs 取值', async () => {
    const user = tempUserData()
    const root = tempBookRoot()
    for (let i = 1; i <= 10; i++) {
      writeCall(user, root, { task: 'review', durationMs: i * 100 })
    }
    const t = (await aggregateTrace(user, root)).byTask['review']!
    expect(t.durationP50).toBeGreaterThanOrEqual(500)
    expect(t.durationP50).toBeLessThanOrEqual(600)
    expect(t.durationP95).toBe(1000)
  })

  it('多 task 分组', async () => {
    const user = tempUserData()
    const root = tempBookRoot()
    writeCall(user, root, { task: 'self-heal' })
    writeCall(user, root, { task: 'analysis' })
    writeCall(user, root, { task: 'outline' })
    const stats = await aggregateTrace(user, root)
    expect(stats.total).toBe(3)
    expect(Object.keys(stats.byTask).sort()).toEqual(['analysis', 'outline', 'self-heal'])
  })

  it('按天趋势（事件创建时间聚日）', async () => {
    const user = tempUserData()
    const root = tempBookRoot()
    // 第一条往前调 1 天 → 昨天 successRate=1 tokens=150
    writeCall(user, root, { task: 't', ok: true, usage: { input: 100, output: 50 } })
    shiftEventDays(user, root, 1)
    // 今天：successRate=0 tokens=300
    writeCall(user, root, { task: 't', ok: false, usage: { input: 200, output: 100 } })

    const t = (await aggregateTrace(user, root)).byTask['t']!
    const days = Object.keys(t.byDay).sort()
    expect(days).toHaveLength(2)
    expect(t.byDay[days[0]!]!.successRate).toBe(1)
    expect(t.byDay[days[0]!]!.tokens).toBe(150)
    expect(t.byDay[days[1]!]!.successRate).toBe(0)
    expect(t.byDay[days[1]!]!.tokens).toBe(300)
  })

  it('userDataPath 缺失 → total=0（观测层降级）', async () => {
    const root = tempBookRoot()
    const stats = await aggregateTrace(null, root)
    expect(stats.total).toBe(0)
  })
})

