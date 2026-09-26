/**
 * R0916-7-P3-15 / R0916-7-P3-16（2026-09-24 全项目源码质量与优雅度评审）回归：runTask
 * 对 run 回调返回值的抽取。
 *
 * 两件事在这里锁住：
 * ① stopReason 不再静默兜底 'end_turn'——值域内原样透出；域外字符串 / 非字符串 / 字段
 *    缺失一律显式归 'unknown' 并日志留痕（此前缺字段时 llm/call 与 step/end 双双谎报
 *    「正常完成」，截断被当成功记账）；
 * ② run 回调壳的抽取统一经显式类型守卫（非对象返回值不再各自为政地判）。
 */
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { runTask } from '../../src/ai/runner.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []

function tempUserData(): string {
  const d = mkdtempTracked(join(tmpdir(), 'clwriting-rsr-ud-'))
  dirs.push(d)
  return d
}

function tempBookRoot(): string {
  const d = mkdtempTracked(join(tmpdir(), 'clwriting-rsr-book-'))
  dirs.push(d)
  return d
}

function writeProviders(userDataPath: string): void {
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-test',
          name: 'test',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'http://127.0.0.1:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'prov-test',
      currentModel: 'gpt-4o',
    }),
  )
}

/** 取本次调用的 llm/call 与 step/end（成功路径各恰一条） */
function readCallAndStep(
  userDataPath: string,
  bookRoot: string,
): { call: Record<string, unknown>; stepEnd: Record<string, unknown> } {
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    const evs = store.listEvents(bookHash(bookRoot))
    return {
      call: evs.find((e) => e.type === 'llm/call')!.data as Record<string, unknown>,
      stepEnd: evs.find((e) => e.type === 'step/end')!.data as Record<string, unknown>,
    }
  } finally {
    store.close()
  }
}

/** 本用例关注的 stopReason 留痕（过滤环境噪声） */
function stopReasonWarns(spy: MockInstance<typeof log.warn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => (c[0] === 'runner' ? String(c[1]) : ''))
    .filter((m) => m.includes('stopReason 非值域成员'))
    .map((m) => JSON.parse(m) as Record<string, unknown>)
}

async function runWithResult(
  data: unknown,
): Promise<{ call: Record<string, unknown>; stepEnd: Record<string, unknown> }> {
  const ud = tempUserData()
  writeProviders(ud)
  const root = tempBookRoot()
  const out = await runTask<unknown>({
    userDataPath: ud,
    bookRoot: root,
    task: 'chat',
    run: () => Promise.resolve(data),
  })
  expect(out.ok).toBe(true)
  return readCallAndStep(ud, root)
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('R0916-7-P3-15：runTask 抽 stopReason（无静默兜底）', () => {
  it("值域内原样透出（'max_tokens' → llm/call + step/end 'max-tokens'）", async () => {
    const spy = vi.spyOn(log, 'warn')
    const { call, stepEnd } = await runWithResult({
      stopReason: 'max_tokens',
      usage: { inputTokens: 5, outputTokens: 9 },
    })
    expect(call['stopReason']).toBe('max_tokens')
    expect(stepEnd['reason']).toBe('max-tokens')
    expect(stopReasonWarns(spy)).toHaveLength(0)
  })

  it("值域内拼写不再改写（'stop' 原样；step/end 'completed'）", async () => {
    const { call, stepEnd } = await runWithResult({ stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } })
    expect(call['stopReason']).toBe('stop')
    expect(stepEnd['reason']).toBe('completed')
  })

  it("显式 'unknown'（流缺 done 的归类值）原样透出，不再被二次改写、不留域外痕", async () => {
    const spy = vi.spyOn(log, 'warn')
    const { call, stepEnd } = await runWithResult({
      stopReason: 'unknown',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    expect(call['stopReason']).toBe('unknown')
    expect(stepEnd['reason']).toBe('completed')
    expect(stopReasonWarns(spy)).toHaveLength(0)
  })

  it("域外字符串 → 'unknown' + 留痕（此前原样透出任意字符串进 llm/call 重放口径）", async () => {
    const spy = vi.spyOn(log, 'warn')
    const { call, stepEnd } = await runWithResult({ stopReason: 'eos', usage: { inputTokens: 1, outputTokens: 1 } })
    expect(call['stopReason']).toBe('unknown')
    expect(stepEnd['reason']).toBe('completed')
    const warns = stopReasonWarns(spy)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ task: 'chat', reason: 'off-union', stopReason: 'eos' })
  })

  it("字段缺失 → 'unknown' + 留痕（此前静默落 'end_turn' 谎报正常完成）", async () => {
    const spy = vi.spyOn(log, 'warn')
    const { call, stepEnd } = await runWithResult({ usage: { inputTokens: 2, outputTokens: 3 } })
    expect(call['stopReason']).toBe('unknown')
    expect(stepEnd['reason']).toBe('completed')
    const warns = stopReasonWarns(spy)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ reason: 'absent', stopReason: null })
  })

  it("非字符串值 → 'unknown' + 留痕（此前 String() 化任意值）", async () => {
    const spy = vi.spyOn(log, 'warn')
    const { call } = await runWithResult({ stopReason: 429 })
    expect(call['stopReason']).toBe('unknown')
    expect(stopReasonWarns(spy)[0]).toMatchObject({ reason: 'non-string' })
  })

  it('run 回调返回非对象（字符串）：抽取统一走类型守卫——usage 缺失、stopReason 归 unknown', async () => {
    const spy = vi.spyOn(log, 'warn')
    const { call } = await runWithResult('ok')
    expect(call['stopReason']).toBe('unknown')
    expect(call['usage']).toBeUndefined()
    expect(stopReasonWarns(spy)).toHaveLength(1)
  })

  it('留痕不重复：一次调用恰一条（trace 与 step/end 同源单次抽取）', async () => {
    const spy = vi.spyOn(log, 'warn')
    await runWithResult({ usage: { inputTokens: 1, outputTokens: 1 } })
    expect(stopReasonWarns(spy)).toHaveLength(1)
  })
})
