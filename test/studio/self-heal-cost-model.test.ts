/**
 * Y-15（第五十七轮）回归——self-heal done 事件 cost 按请求时刻模型计价。
 *
 * 缺陷：done 事件累计 cost 时二次 resolveTier(userDataPath, 'creative') 取**当下**
 * 档位模型查价——生成期间作者换档（请求用 A 模型、done 时档位已切 B）时，done.usage
 * 成本与 ai-calls 账本（runTask 按请求时刻 tier.model 计价）漂移。修复：改用
 * TaskOk.model（请求时刻快照）。
 *
 * 手法：providers.json 现档位模型 = now-model（未配价），mock runSpec 回
 * model='req-model'（配价）+ usage → done 事件应带 cost（修复前查 now-model
 * 无价 → cost 恒 0 省略字段）。
 */
import { test, expect, vi } from 'vitest'
import { join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { makeDualTrackWorkdir, LONG_BOOK } from './fixtures.js'
import { runSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import { runSpec } from '../../src/ai/tasks/spec.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

vi.mock('../../src/ai/tasks/spec.js', () => ({ runSpec: vi.fn() }))

const FM_CH5 = '---\n章号: 5\n标题: 第五章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文内容：山门外玉佩轻响。'

function greenOutcome(): CheckOutcome {
  return {
    ok: true,
    report: { sections: [] },
    hasRed: false,
    chapter: { 章号: 5, 标题: '第五章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' },
    body: '正文',
  }
}

function makeEmitDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> { return { id: 'mock', cwd, closed: false } },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void { emitted.push(ev) },
  }
}

test('Y-15: done.cost 按请求时刻模型（TaskOk.model）计价，不随档位漂移', async () => {
  const workDir = makeDualTrackWorkdir()
  const userDataPath = mkdtempTracked(join(tmpdir(), 'clw-y15-appdata-'))
  const bookRoot = join(workDir, '长篇', LONG_BOOK)
  const emitted: DriverEvent[] = []
  const save: typeof saveDraft = (_root, _ch, _content) => ({
    relPath: '写作/正文/0005-第五章.md',
    docId: 'doc-y15-5',
    words: 10,
    snapshotted: false,
  })
  // 现档位 = now-model（未配价）；req-model 在 models[] 配价——修复前 resolveTier 取
  // now-model 查价 null → cost 恒 0；修复后用 out.model = req-model → 有价
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-y15',
          name: 'test',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'http://localhost:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
          models: [{ id: 'req-model', pricing: { inputPerMTok: 1, outputPerMTok: 2 } }],
        },
      ],
      currentId: 'prov-y15',
      currentModel: 'now-model',
    }),
  )
  const opts: SelfHealOpts = {
    driver: makeEmitDriver(emitted),
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath,
    cwd: workDir,
    bookRoot,
    bookName: LONG_BOOK,
    chapter: 5,
    check: () => greenOutcome(),
    save,
  }
  try {
    vi.mocked(runSpec).mockResolvedValue({
      ok: true,
      // usage 挂 SpecOutput（self-heal 读 out.data.usage——W-P2-7 口径）；
      // model 挂 TaskOk 顶层（请求时刻快照——Y-15 计价源）
      data: { input: undefined, text: FM_CH5, stopReason: 'tool_use', usage: { inputTokens: 1000, outputTokens: 2000 } },
      ctrl: new AbortController(),
      usage: { inputTokens: 1000, outputTokens: 2000 },
      runId: 'y15',
      model: 'req-model',
    })
    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('pass')
    const done = emitted.find((e) => e.type === 'done') as { cost?: number; usage: number } | undefined
    expect(done).toBeDefined()
    expect(done!.usage).toBe(2000)
    // (1000/1e6)*1 + (2000/1e6)*2 = 0.005 —— 修复前 now-model 无价 → 无 cost 字段
    expect(done!.cost).toBeCloseTo(0.005, 10)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(userDataPath, { recursive: true, force: true })
  }
})

test('R73-10: done.usage 取全 attempt 累计（attemptsUsage 优先于末次 usage）', async () => {
  const workDir = makeDualTrackWorkdir()
  const userDataPath = mkdtempTracked(join(tmpdir(), 'clw-r73a10-appdata-'))
  const bookRoot = join(workDir, '长篇', LONG_BOOK)
  const emitted: DriverEvent[] = []
  const save: typeof saveDraft = (_root, _ch, _content) => ({
    relPath: '写作/正文/0005-第五章.md',
    docId: 'doc-r73a10-5',
    words: 10,
    snapshotted: false,
  })
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-r73a10',
          name: 'test',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'http://localhost:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'prov-r73a10',
      currentModel: 'now-model',
    }),
  )
  const opts: SelfHealOpts = {
    driver: makeEmitDriver(emitted),
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath,
    cwd: workDir,
    bookRoot,
    bookName: LONG_BOOK,
    chapter: 5,
    check: () => greenOutcome(),
    save,
  }
  try {
    vi.mocked(runSpec).mockResolvedValue({
      ok: true,
      data: { input: undefined, text: FM_CH5, stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 20 } },
      ctrl: new AbortController(),
      usage: { inputTokens: 10, outputTokens: 20 }, // 末次成功 attempt（修复前 done 只取这个）
      attemptsUsage: { inputTokens: 30, outputTokens: 60 }, // 全 attempt 累计（R73-10 口径）
      runId: 'r73a10',
      model: null,
    })
    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('pass')
    const done = emitted.find((e) => e.type === 'done') as { usage: number; usageEstimated?: boolean } | undefined
    expect(done).toBeDefined()
    // 修复前取末次 20（重试链前置消耗在前端成本显示中缺失）；修复后取累计 60
    expect(done!.usage).toBe(60)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
