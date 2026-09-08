/**
 * R-P3-2（评审修复批）：failureAction 失败出口日志留痕回归。
 *
 * 背景：runTask 各失败出口此前仅事件库留痕（llm/call ok:false + step/end 'error'，
 * 且 bookRoot/task 缺省时 mkChain 返 null 连事件也不落），日志通道（app-*.jsonl）
 * 零线索，排障无从下手。修复后失败出口补 log.warn（task/bookRoot/attempt/决策表
 * 动作名/原因），控制流零改动。
 *
 * 用例直接以 run 回调抛 GenError 驱动各失败分支（不触网络），断言 log.warn 的
 * 结构化字段；用户中断（决策表 ABORTED → 'none' 非失败口径）不产生失败日志。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTask } from '../../src/ai/runner.js'
import { GenError } from '../../src/ai/gen.js'
import { log } from '../../src/log/index.js'
import { resetDegradedChannels } from '../../src/ai/provider/store.js'

const workDirs: string[] = []
function tempUserData(): string {
  const d = mkdtempSync(join(tmpdir(), 'clwriting-rp32-ud-'))
  workDirs.push(d)
  return d
}

/** 写最小 providers.json（run 回调桩不触网络，baseUrl 形参而已） */
function writeProviders(userDataPath: string, timeoutMs?: number): void {
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
      ...(timeoutMs !== undefined
        ? { tiers: { creative: { model: 'gpt-4o', effort: 'high', timeoutMs }, assistant: null, chat: null } }
        : {}),
    }),
  )
}

/** 取本用例关注的两类结构化失败日志（过滤 mkChain missing-args 等环境噪声） */
function failureWarns(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => String(c[1]))
    .filter((m) =>
      m.includes('AI 调用终态失败') ||
      m.includes('按决策表退避重试') ||
      m.includes('Retry-After 超退避封顶') ||
      m.includes('总超时') ||
      m.includes('取 provider 失败'),
    )
    .map((m) => JSON.parse(m) as Record<string, unknown>)
}

afterEach(() => {
  for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
  resetDegradedChannels()
})

describe('R-P3-2：failureAction 失败出口日志留痕', () => {
  it('终态失败（BAD_REQUEST → 决策表 author）→ warn 带 task/attempt/code/action/error', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const out = await runTask<string>({
      userDataPath: ud,
      task: 'self-heal',
      run: () => {
        throw new GenError('400 bad request', false, { code: 'BAD_REQUEST' })
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    const warns = failureWarns(spy)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({
      msg: 'AI 调用终态失败',
      task: 'self-heal',
      bookRoot: null,
      attempt: 0,
      code: 'BAD_REQUEST',
      action: 'author',
      error: '400 bad request',
    })
  })

  it('终态失败且决策表判 switch-provider（AUTH）→ 动作名如实透出（不冒充 author）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const out = await runTask<string>({
      userDataPath: ud,
      run: () => {
        throw new GenError('401 unauthorized', false, { code: 'AUTH' })
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    const warns = failureWarns(spy)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ code: 'AUTH', action: 'switch-provider' })
  })

  it('重试出口（RATE_LIMIT）→ warn 带 action:retry/attempt/delayMs；重试成功后终态零失败日志', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      run: () => {
        calls++
        if (calls < 2) throw new GenError('429 limit', true, { code: 'RATE_LIMIT', retryAfterMs: 1 })
        return Promise.resolve('ok')
      },
    })
    expect(out.ok).toBe(true)
    const warns = failureWarns(spy)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({
      msg: 'AI 调用失败，按决策表退避重试',
      attempt: 0,
      code: 'RATE_LIMIT',
      action: 'retry',
      delayMs: 1,
      error: '429 limit',
    })
  }, 10_000)

  it('Retry-After 超封顶终态 → warn 带决策表动作 retry + 服务端值/封顶值', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      run: () => {
        calls++
        throw new GenError('429 limit', true, { code: 'RATE_LIMIT', retryAfterMs: 120_000 })
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    expect(calls).toBe(1)
    const warns = failureWarns(spy)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({
      msg: 'Retry-After 超退避封顶，停止重试（终态）',
      attempt: 0,
      action: 'retry',
      retryAfterMs: 120_000,
      capMs: 30_000,
    })
  }, 10_000)

  it('总超时（TIMEOUT_TOTAL）→ warn 留痕；用户中断（ABORTED）→ 无失败日志（决策表 none 非失败口径）', async () => {
    const ud = tempUserData()
    writeProviders(ud, 60) // 档位 timeoutMs=60ms：制造真实总超时
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const out = await runTask<string>({
      userDataPath: ud,
      run: (_p, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('timeout')))
        }),
    })
    expect(out).toMatchObject({ ok: false, code: 'TIMEOUT_TOTAL' })
    let warns = failureWarns(spy)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ msg: 'AI 任务总超时（终态）', code: 'TIMEOUT_TOTAL', timeoutMs: 60 })

    // 对照：用户主动中断不产生失败日志（高频操作，决策表 ABORTED → 'none'）
    spy.mockClear()
    const ud2 = tempUserData()
    writeProviders(ud2)
    const ctrl = new AbortController()
    const out2 = await runTask<string>({
      userDataPath: ud2,
      ctrl,
      run: () => {
        ctrl.abort()
        throw new GenError('429 limit', true, { code: 'RATE_LIMIT' })
      },
    })
    expect(out2).toMatchObject({ ok: false, code: 'ABORTED' })
    warns = failureWarns(spy)
    expect(warns).toHaveLength(0)
  }, 10_000)

  it('重试耗尽 → 终态 warn 的 action 仍为 retry（决策表现值，不谎报 author）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      run: () => {
        calls++
        throw new GenError('429 limit', true, { code: 'RATE_LIMIT', retryAfterMs: 1 })
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    expect(calls).toBe(4) // 首发 + 3 次重试
    const warns = failureWarns(spy)
    expect(warns).toHaveLength(4) // 3 条重试 + 1 条终态
    expect(warns[3]).toMatchObject({ msg: 'AI 调用终态失败', attempt: 3, action: 'retry' })
  }, 10_000)

  it('取 provider 失败（NO_PROVIDER）→ warn 带 code/error（配置类失败日志可归因）', async () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const out = await runTask<string>({
      userDataPath: tempUserData(), // 无 providers.json
      task: 'self-heal',
      run: () => Promise.resolve('never'),
    })
    expect(out).toMatchObject({ ok: false, code: 'NO_PROVIDER' })
    const warns = failureWarns(spy)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ msg: 'AI 任务取 provider 失败（终态）', task: 'self-heal', code: 'NO_PROVIDER' })
  })
})
