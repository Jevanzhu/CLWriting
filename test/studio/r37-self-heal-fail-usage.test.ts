/**
 * R37-7（三十七轮批 A）回归——self-heal 失败分支把 TaskErr 封套携带的 usage
 * 并入 state.usage（done 事件）。
 *
 * 缺陷（R35-17 登记点收口）：runGenerate 的 !out.ok 分支此前只判 ABORTED/透传 error，
 * runner 失败封套无 attemptsUsage 可取——失败前已按次入账 ai-calls 的真实消耗在
 * done 事件（usage/cost）里漏记，前端成本/预算显示与账本口径分叉。修复：TaskErr 携
 * attemptsUsage + model，失败分支与成功路径同款并入（outputTokens 累计、estimated
 * 置位、按请求时刻模型计价）。
 *
 * 手法同 self-heal-cost-model.test.ts（Y-15/R73-10）：mock runSpec 回失败封套，
 * 断言 done 事件带失败链的用量与成本。
 */
import { test, expect, vi } from 'vitest'
import { join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { makeDualTrackWorkdir, LONG_BOOK } from './fixtures.js'
import { runSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import { runSpec } from '../../src/ai/tasks/spec.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

vi.mock('../../src/ai/tasks/spec.js', () => ({ runSpec: vi.fn() }))

function makeEmitDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> { return { id: 'mock', cwd, closed: false } },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void { emitted.push(ev) },
  }
}

function writeProviders(userDataPath: string): void {
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-r37sh',
          name: 'test',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'http://localhost:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
          models: [{ id: 'req-model', pricing: { inputPerMTok: 1, outputPerMTok: 2 } }],
        },
      ],
      currentId: 'prov-r37sh',
      currentModel: 'now-model',
    }),
  )
}

function makeOpts(userDataPath: string, workDir: string, emitted: DriverEvent[]): SelfHealOpts {
  return {
    driver: makeEmitDriver(emitted),
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath,
    cwd: workDir,
    bookRoot: join(workDir, '长篇', LONG_BOOK),
    bookName: LONG_BOOK,
    chapter: 5,
  }
}

test('R37-7: 首稿生成终态失败 → done 事件并入封套 attemptsUsage（usage + cost + estimated）', async () => {
  const workDir = makeDualTrackWorkdir()
  const userDataPath = mkdtempTracked(join(tmpdir(), 'clw-r37sh-appdata-'))
  const emitted: DriverEvent[] = []
  writeProviders(userDataPath)
  try {
    vi.mocked(runSpec).mockResolvedValue({
      ok: false,
      code: 'GEN_FAIL',
      error: 'AI 产出达到长度上限被截断',
      // 修复前封套无 attemptsUsage/model——失败链消耗在 done 事件里不可见
      attemptsUsage: { inputTokens: 1000, outputTokens: 2000, estimated: true },
      model: 'req-model',
    })
    const r = await runSelfHeal(makeOpts(userDataPath, workDir, emitted))
    expect(r.outcome).toBe('failed')
    const done = emitted.find((e) => e.type === 'done') as { usage: number; cost?: number; usageEstimated?: boolean; reason: string } | undefined
    expect(done).toBeDefined()
    // 修复前 usage 恒 0（失败分支不并入）；修复后取封套累计 2000
    expect(done!.usage).toBe(2000)
    // estimated 随封套置位（前端可区分实测/估计口径）
    expect(done!.usageEstimated).toBe(true)
    // (1000/1e6)*1 + (2000/1e6)*2 = 0.005——按请求时刻模型（req-model，配价）计价
    expect(done!.cost).toBeCloseTo(0.005, 10)
    expect(done!.reason).toBe('error')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(userDataPath, { recursive: true, force: true })
  }
})

test('R37-7: 封套无 usage（旧调用方/无消耗失败）→ done.usage 维持 0，无 cost 字段', async () => {
  const workDir = makeDualTrackWorkdir()
  const userDataPath = mkdtempTracked(join(tmpdir(), 'clw-r37sh2-appdata-'))
  const emitted: DriverEvent[] = []
  writeProviders(userDataPath)
  try {
    vi.mocked(runSpec).mockResolvedValue({
      ok: false,
      code: 'GEN_FAIL',
      error: '未配置供应商',
    })
    const r = await runSelfHeal(makeOpts(userDataPath, workDir, emitted))
    expect(r.outcome).toBe('failed')
    const done = emitted.find((e) => e.type === 'done') as { usage: number; cost?: number } | undefined
    expect(done).toBeDefined()
    expect(done!.usage).toBe(0)
    expect(done!.cost).toBeUndefined()
  } finally {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
