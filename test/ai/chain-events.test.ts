/**
 * F1-P2 runner 链事件单测：runTask 走真实路径时写 llm/call + step/start + step/end{reason}，
 * 重试前写 llm/retry（先落库后等待）；无 bookRoot 降级不写。
 */
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runTask } from '../../src/ai/runner.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { GenError } from '../../src/ai/gen.js'
import { MODEL_QUIRKS_VERSION } from '../../src/ai/provider/model-quirks.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function tempUserData(): string {
  const d = mkdtempTracked(join(tmpdir(), 'clwriting-chain-ud-'))
  dirs.push(d)
  return d
}
function tempBookRoot(): string {
  const d = mkdtempTracked(join(tmpdir(), 'clwriting-chain-book-'))
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
          baseUrl: 'http://localhost:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'prov-test',
      currentModel: 'gpt-4o',
    }),
  )
}

function readChainEvents(userDataPath: string, bookRoot: string) {
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    return store.listEvents(bookHash(bookRoot))
  } finally {
    store.close()
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.CLWRITING_DRIVER
})

describe('F1-P2 runTask 链事件', () => {
  it('成功 → step/start + llm/call(ok) + step/end(completed)', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'chat',
      run: () => Promise.resolve('ok'),
    })
    expect(out.ok).toBe(true)
    const evs = readChainEvents(ud, root)
    expect(evs.map((e) => e.type)).toEqual(['step/start', 'llm/call', 'step/end'])
    const [start, call, end] = evs.map((e) => e.data) as Record<string, unknown>[]
    expect(start).toMatchObject({ task: 'chat', layer: 'chat' })
    expect(call).toMatchObject({ task: 'chat', ok: true, model: 'gpt-4o', attempt: 0 })
    expect(end).toMatchObject({ task: 'chat', layer: 'chat', reason: 'completed' })
  })

  // I7（第十一轮）：resolve 解析值落 trace——llm/call 携带实际生效的 effort/timeoutMs
  // （档位显式值 + DEFAULT_TIMEOUT_MS 回落后的最终值），重放可精确重建（铁律②补全）
  it('I7: llm/call 携带 resolve 解析值 effort/timeoutMs（显式档位 + 默认回落）', async () => {
    const ud = tempUserData()
    writeFileSync(
      join(ud, 'providers.json'),
      JSON.stringify({
        providers: [
          {
            id: 'prov-test',
            name: 'test',
            protocol: 'openai',
            auth: 'bearer',
            baseUrl: 'http://localhost:1',
            apiKey: 'sk-test',
            caps: { connected: true, streaming: true },
          },
        ],
        currentId: 'prov-test',
        currentModel: 'gpt-4o',
        tiers: { creative: { model: 'gpt-4o', effort: 'high', timeoutMs: 1234 }, assistant: null, chat: null },
      }),
    )
    const root = tempBookRoot()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'chat',
      run: () => Promise.resolve('ok'),
    })
    expect(out.ok).toBe(true)
    const call = readChainEvents(ud, root).find((e) => e.type === 'llm/call')!.data as Record<string, unknown>
    expect(call['effort']).toBe('high')
    expect(call['timeoutMs']).toBe(1234)

    // 档位未声明 timeoutMs → DEFAULT_TIMEOUT_MS(600_000) 回落后的值同样落库（非隐式穿透）
    const ud2 = tempUserData()
    writeProviders(ud2)
    const root2 = tempBookRoot()
    await runTask<string>({ userDataPath: ud2, bookRoot: root2, task: 'chat', run: () => Promise.resolve('ok') })
    const call2 = readChainEvents(ud2, root2).find((e) => e.type === 'llm/call')!.data as Record<string, unknown>
    expect(call2['timeoutMs']).toBe(600_000)
    expect(typeof call2['effort']).toBe('string')
  })

  // Q-13（第十五轮）：resolve 后终值补全——上线输出上限 maxTokens（适配器 done 事件透出
  // 经编排层 T 透传）与首字节超时 firstByteTimeoutMs（env resolver，与 gen.generate 同源）
  it('Q-13: llm/call 携带 maxTokens（run 透传）/ firstByteTimeoutMs（env 覆盖 + 默认回落）', async () => {
    process.env['CLWRITING_FIRST_BYTE_TIMEOUT_MS'] = '45000'
    try {
      const ud = tempUserData()
      writeProviders(ud)
      const root = tempBookRoot()
      const out = await runTask<{ stopReason: string; usage: { inputTokens: number; outputTokens: number }; resolvedMaxTokens?: number }>({
        userDataPath: ud,
        bookRoot: root,
        task: 'chat',
        run: () =>
          Promise.resolve({
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 2 },
            resolvedMaxTokens: 16384,
          }),
      })
      expect(out.ok).toBe(true)
      const call = readChainEvents(ud, root).find((e) => e.type === 'llm/call')!.data as Record<string, unknown>
      expect(call['maxTokens']).toBe(16384)
      expect(call['firstByteTimeoutMs']).toBe(45_000)

      // env 未设 → DEFAULT_FIRST_BYTE_TIMEOUT_MS(60s) 回落值落库（非隐式穿透）；
      // run 返回无 resolvedMaxTokens（无兜底不发/纯文本编排）→ 键缺席
      delete process.env['CLWRITING_FIRST_BYTE_TIMEOUT_MS']
      const ud2 = tempUserData()
      writeProviders(ud2)
      const root2 = tempBookRoot()
      await runTask<string>({ userDataPath: ud2, bookRoot: root2, task: 'chat', run: () => Promise.resolve('ok') })
      const call2 = readChainEvents(ud2, root2).find((e) => e.type === 'llm/call')!.data as Record<string, unknown>
      expect(call2['firstByteTimeoutMs']).toBe(60_000)
      expect('maxTokens' in call2).toBe(false)
    } finally {
      delete process.env['CLWRITING_FIRST_BYTE_TIMEOUT_MS']
    }
  })

  // R-8（十五轮登记销账）：model-quirks 参数表 contentVersion 落 llm/call——跨版本
  // 重放漂移检测依据；常量注入，mock 快路同样携带
  it('R-8: llm/call 携带 quirksVersion（与 MODEL_QUIRKS_VERSION 常量一致）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'chat',
      run: () => Promise.resolve('ok'),
    })
    expect(out.ok).toBe(true)
    const call = readChainEvents(ud, root).find((e) => e.type === 'llm/call')!.data as Record<string, unknown>
    expect(call['quirksVersion']).toBe(MODEL_QUIRKS_VERSION)
    expect(typeof call['quirksVersion']).toBe('string')
  })

  it('重试成功（429 → 退避 → 成功）→ llm/retry + 两条 llm/call + step/end(completed)', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'self-heal',
      run: () => {
        calls++
        if (calls < 2) throw new GenError('429 limit', true)
        return Promise.resolve('ok');
      },
    })
    expect(out.ok).toBe(true)
    const evs = readChainEvents(ud, root)
    const types = evs.map((e) => e.type)
    expect(types).toEqual(['step/start', 'llm/call', 'llm/retry', 'llm/call', 'step/end'])
    const retry = evs[2]!.data as { attempt: number; delayMs: number }
    expect(retry.attempt).toBe(0)
    expect(retry.delayMs).toBeGreaterThanOrEqual(0)
    const end = evs[4]!.data as { reason: string }
    expect(end.reason).toBe('completed')
  })

  // R65-12（总六十五轮）：durationMs 只记本 attempt LLM 调用时长——旧口径跨 attempt
  // 累计（含失败 attempt + 退避 sleep），重试链计费/时延统计失真
  it('R65-12: 重试链各 attempt 的 durationMs 不含退避 sleep（只记本 attempt 调用窗口）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    let calls = 0
    // Retry-After=300ms：退避窗固定且足够大（旧口径下成功 attempt 的 durationMs ≥ 300）
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'self-heal',
      run: () => {
        calls++
        if (calls < 2) throw new GenError('429 limit', true, { code: 'RATE_LIMIT', retryAfterMs: 300 })
        return Promise.resolve('ok')
      },
    })
    expect(out.ok).toBe(true)
    const callsEv = readChainEvents(ud, root).filter((e) => e.type === 'llm/call')
    expect(callsEv).toHaveLength(2)
    const failEv = callsEv.find((e) => (e.data as { ok?: boolean }).ok === false)!.data as { attempt: number; durationMs: number }
    const okEv = callsEv.find((e) => (e.data as { ok?: boolean }).ok === true)!.data as { attempt: number; durationMs: number }
    expect(failEv.attempt).toBe(0)
    expect(okEv.attempt).toBe(1)
    // 两次 run 都是即时 resolve/reject → 本 attempt 窗口 ≈ 0；旧口径下 okEv 会 ≥ 300（退避窗计入）
    expect(failEv.durationMs).toBeLessThan(150)
    expect(okEv.durationMs).toBeLessThan(150)
  }, 10_000)

  it('终态失败（不可重试）→ step/end(error) + llm/call(ok=false)', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'review',
      run: () => Promise.reject(new GenError('boom', false, { code: 'BAD_REQUEST' })),
    })
    expect(out.ok).toBe(false)
    const evs = readChainEvents(ud, root)
    expect(evs.map((e) => e.type)).toEqual(['step/start', 'llm/call', 'step/end'])
    const call = evs[1]!.data as { ok: boolean; errCode?: string }
    expect(call.ok).toBe(false)
    expect(call.errCode).toBe('BAD_REQUEST')
    const end = evs[2]!.data as { reason: string }
    expect(end.reason).toBe('error')
  })

  it('无 bookRoot → 不写链事件（降级；bookRoot 缺失时观测层跳过）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const out = await runTask<string>({
      userDataPath: ud,
      task: 'chat',
      run: () => Promise.resolve('ok'),
    })
    expect(out.ok).toBe(true)
    // bookRoot 缺失 → 不写任何链路事件（观测层跳过）
    const store = openSessionStore(ud, '/nope')!
    try {
      expect(store.listEvents(bookHash('/nope'))).toHaveLength(0)
      expect(store.latestSession(bookHash('/nope'))).toBeNull()
    } finally {
      store.close()
    }
  })

  it('中断 → step/end(aborted)', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'chat',
      ctrl,
      run: (_, signal) =>
        new Promise<string>((_resolve, reject) => {
          if (signal.aborted) { reject(new Error('aborted')); return }
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    expect(out.ok).toBe(false)
    const evs = readChainEvents(ud, root)
    const end = evs.at(-1)!.data as { reason: string }
    expect(end.reason).toBe('aborted')
  })

  it('AA-P3-4: 总超时 → step/end(interrupted)（与用户中断 aborted 可区分，不再恒等）', async () => {
    const ud = tempUserData()
    // 档位 timeoutMs=60ms：制造真实总超时（此前 `timedOut ? 'aborted' : 'aborted'` 恒等，
    // 审计无法区分超时 vs 用户中断——现超时记 'interrupted'）
    writeFileSync(
      join(ud, 'providers.json'),
      JSON.stringify({
        providers: [
          {
            id: 'prov-test',
            name: 'test',
            protocol: 'openai',
            auth: 'bearer',
            baseUrl: 'http://localhost:1',
            apiKey: 'sk-test',
            caps: { connected: true, streaming: true },
          },
        ],
        currentId: 'prov-test',
        currentModel: 'gpt-4o',
        tiers: { creative: { model: 'gpt-4o', effort: 'high', timeoutMs: 60 }, assistant: null, chat: null },
      }),
    )
    const root = tempBookRoot()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'chat',
      run: (_p, signal) =>
        new Promise<string>((_resolve, reject) => {
          // 真实 provider 流式行为：signal abort → 立即 reject（不挂到永远）
          signal.addEventListener('abort', () => reject(new Error('timeout')))
        }),
    })
    expect(out).toMatchObject({ ok: false, code: 'TIMEOUT_TOTAL' })
    const evs = readChainEvents(ud, root)
    const end = evs.at(-1)!.data as { reason: string }
    expect(end.reason).toBe('interrupted')
  }, 10_000)
})


describe('T2-2 建链失败审计留痕（mkChain 不再静默）', () => {
  it('task 缺失（建链入参不齐）→ logger.warn 结构化留痕，本次调用零链路事件', async () => {
    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    try {
      const ud = tempUserData()
      writeProviders(ud)
      // task 不传：修复前整段调用零事件零日志（审计黑洞）
      const out = await runTask<string>({ userDataPath: ud, bookRoot: tempBookRoot(), run: () => Promise.resolve('ok') })
      expect(out.ok).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]![0]).toBe('runner')
      const msg = JSON.parse(spy.mock.calls[0]![1]) as { msg: string; reason: string }
      expect(msg.msg).toContain('链路事件录制器未建')
      expect(msg.reason).toBe('missing-args')
    } finally {
      spy.mockRestore()
    }
  })

  it('事件库打不开（userDataPath 无效）→ logger.warn 留痕', async () => {
    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    try {
      // userDataPath 指向不可建库的位置（文件占位目录路径）→ openSessionStore 失败
      const ud = tempUserData()
      writeFileSync(join(ud, 'blocker'), 'x')
      writeProviders(ud)
      await runTask<string>({
        userDataPath: join(ud, 'blocker', 'sub'),
        bookRoot: tempBookRoot(),
        task: 'chat',
        run: () => Promise.resolve('ok'),
      })
      // 无效 userDataPath → 后续 resolveProvider 也会失败（无 providers.json），
      // 断言点在 warn 留痕而非调用成败
      const warn = spy.mock.calls.find((c) => c[1]!.includes('链路事件录制器未建'))
      expect(warn).toBeDefined()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('T2 批 degradedPersistedKeys 生命周期', () => {
  it('resolveProvider 换 userDataPath → 旧 path 的降级标记键被清理', async () => {
    const runner = await import('../../src/ai/runner.js')
    const udA = tempUserData()
    const udB = tempUserData()
    // 首注册 pathA（loadProviders 失败无妨——注册与清理发生在其之前）
    expect(runner.resolveProvider(udA).ok).toBe(false)
    const keys = runner.degradedPersistedKeysForTest() as Set<string>
    keys.add(`${udA}\u0000model-x`)
    keys.add('/他进程残留路径\u0000model-y')
    // 换 pathB：A 的键与残留键一并清出，B 前缀保留
    expect(runner.resolveProvider(udB).ok).toBe(false)
    keys.add(`${udB}\u0000model-z`)
    expect(keys.has(`${udA}\u0000model-x`)).toBe(false)
    expect(keys.has('/他进程残留路径\u0000model-y')).toBe(false)
    expect(keys.has(`${udB}\u0000model-z`)).toBe(true)
  })
})
