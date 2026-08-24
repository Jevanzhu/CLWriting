/**
 * 编排层统一执行器 runTask 单测（审查 §八③）。
 *
 * 覆盖：mock 两形态（文本/工具）短路、未配数据目录、未配置供应商统一文案、
 * mock/真实 decode 一致、resolveProvider 独立行为。
 * （GEN_FAIL / ABORTED 需真实 provider 网络路径，不在这层单测，由 e2e 覆盖。）
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runTask, resolveProvider, NO_USERDATA_MSG, NO_PROVIDER_MSG } from '../../src/ai/runner.js'
import { persistDegraded, registerDegradedPersist, resetDegradedChannels } from '../../src/ai/provider/store.js'
import { checkAiCallBudget } from '../../src/ai/calls.js'
import type { BookConfig } from '../../src/format/types.js'
import { tryMockTool } from '../../src/ai/mock-tool.js'
import { GenError } from '../../src/ai/gen.js'

const workDirs: string[] = []
function tempUserData(): string {
  const d = mkdtempSync(join(tmpdir(), 'clwriting-runner-ud-'))
  workDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.CLWRITING_DRIVER
  resetDegradedChannels()
})

/** 写最小 providers.json（明文 apiKey，loadProviders 自动迁移加密）；timeoutMs 可选注入档位总超时 */
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
          baseUrl: 'http://localhost:1',
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

describe('runTask mock 快路', () => {
  it('mockText 形态：CLWRITING_DRIVER=mock 直接返回预定文本，不触 run', async () => {
    process.env.CLWRITING_DRIVER = 'mock'
    let ran = false
    const out = await runTask<string>({
      userDataPath: tempUserData(),
      mockText: '## mock 细纲',
      run: (_p, _s) => {
        ran = true
        return Promise.resolve('never')
      },
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data).toBe('## mock 细纲')
    expect(ran).toBe(false) // mock 短路，不触 run
  })

  it('mockTool 形态：data=tryMockTool 结果，调用方可按真实 generateTool decode', async () => {
    process.env.CLWRITING_DRIVER = 'mock'
    const out = await runTask<{ input: unknown }>({
      userDataPath: tempUserData(),
      mockTool: 'submit_text',
      run: (_p, _s) => Promise.resolve({ input: null }),
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      // 与 rewrite.ts 同款 decode：input.正文
      expect((out.data.input as { 正文?: string }).正文).toContain('mock 改写')
      // B-11（第六十轮）：TaskOk.usage 与 trace 统一携带 MOCK_USAGE——此前记 null 而
      // data 内藏 usage（self-heal done 事件自取累计），同一调用事件库 0/0、UI 口径 100/50
      expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
    }
  })

  it('非 mock 环境 mockTool 不短路（走 provider 解析）', async () => {
    delete process.env.CLWRITING_DRIVER
    expect(tryMockTool('submit_text')).toBeNull()
    const out = await runTask<string>({
      userDataPath: tempUserData(), // 无 providers.json → NO_PROVIDER，证明没走 mock
      mockTool: 'submit_text',
      run: (_p, _s) => Promise.resolve('x'),
    })
    expect(out).toMatchObject({ ok: false, code: 'NO_PROVIDER' })
  })

  // P0-1：非 mock 环境 mockText 不短路（与 mockTool 守卫对称，防生产返回 mock 文本）
  it('非 mock 环境 mockText 不短路（走 provider 解析）', async () => {
    delete process.env.CLWRITING_DRIVER
    const out = await runTask<string>({
      userDataPath: tempUserData(), // 无 providers.json → NO_PROVIDER，证明没走 mock
      mockText: '## mock 细纲',
      run: (_p, _s) => Promise.resolve('never'),
    })
    expect(out).toMatchObject({ ok: false, code: 'NO_PROVIDER' })
  })
})

describe('runTask provider 解析与统一错误文案', () => {
  it('userDataPath null → NO_USERDATA', async () => {
    const out = await runTask<string>({
      userDataPath: null,
      run: (_p, _s) => Promise.resolve('x'),
    })
    expect(out).toMatchObject({ ok: false, code: 'NO_USERDATA', error: NO_USERDATA_MSG })
  })

  it('无 providers.json → NO_PROVIDER（统一文案）', async () => {
    const out = await runTask<string>({
      userDataPath: tempUserData(),
      run: (_p, _s) => Promise.resolve('x'),
    })
    expect(out).toMatchObject({ ok: false, code: 'NO_PROVIDER', error: NO_PROVIDER_MSG })
  })

  // ee-P1-1：loadProviders 对损坏 providers.json（且无 bak）会直接 throw——此前裸穿
  // {ok:false} 封套到 API 层变裸 500，且已落的 step/start 成孤儿；现收进封套同判 NO_PROVIDER
  it('ee-P1-1：providers.json 损坏且无 bak → NO_PROVIDER（供应商配置读取失败），不裸穿异常', async () => {
    const ud = tempUserData()
    writeFileSync(join(ud, 'providers.json'), '{ not valid json') // 损坏且无 providers.bak.json
    let ran = false
    const out = await runTask<string>({
      userDataPath: ud,
      run: (_p, _s) => {
        ran = true
        return Promise.resolve('never') // 不应触达 run（provider 解析即失败）
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'NO_PROVIDER' })
    if (!out.ok) expect(out.error).toContain('供应商配置读取失败')
    expect(ran).toBe(false)
  })
})

describe('resolveProvider 独立行为', () => {
  it('null → NO_USERDATA；空目录 → NO_PROVIDER（mock 下亦然，短路由 runTask 决策）', () => {
    process.env.CLWRITING_DRIVER = 'mock'
    expect(resolveProvider(null)).toMatchObject({ ok: false, code: 'NO_USERDATA', error: NO_USERDATA_MSG })
    expect(resolveProvider(tempUserData())).toMatchObject({ ok: false, code: 'NO_PROVIDER', error: NO_PROVIDER_MSG })
  })
})

describe('runTask B-1 指数退避重试', () => {
  it('可重试错误（429）→ 退避后重试成功', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      run: () => {
        calls++
        if (calls < 2) throw new GenError('429 limit', true)
        return Promise.resolve('ok')
      },
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data).toBe('ok')
    expect(calls).toBe(2) // 第一次 429 → 退避 → 第二次成功
  }, 10_000)

  it('B4：服务端 Retry-After（封顶内）→ 用服务端值快退避后重试成功', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    let calls = 0
    // 墙钟断言（elapsed<900ms）在全量套件负载下实测漂到 2.8s 偶发红——改捕获 setTimeout
    // 延迟实参：退避 sleep(60) 即「服务端值生效、指数基数 1000ms 不参与」的确定性证据
    const spy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const out = await runTask<string>({
        userDataPath: ud,
        run: () => {
          calls++
          if (calls < 2) throw new GenError('429 limit', true, { code: 'RATE_LIMIT', retryAfterMs: 60 })
          return Promise.resolve('ok')
        },
      })
      expect(out.ok).toBe(true)
      expect(calls).toBe(2)
      const delays = spy.mock.calls.map((c) => c[1]).filter((ms): ms is number => typeof ms === 'number')
      expect(delays).toContain(60)
    } finally {
      spy.mockRestore()
    }
  }, 10_000)

  it('B4：Retry-After 超封顶（> 30s）→ 不重试，终态 GEN_FAIL 带人话', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      run: () => {
        calls++
        throw new GenError('429 limit', true, { code: 'RATE_LIMIT', retryAfterMs: 120_000 })
      },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe('GEN_FAIL')
      expect(out.error).toContain('已停止重试')
      expect(out.error).toContain('120')
    }
    expect(calls).toBe(1) // 尊重服务端「等很久」的判断，不盲试
  }, 10_000)

  it('W-P2-8：内部重试也入账——429 一次 + 成功一次 → chapter used=2（预算闸不可被重试超限）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-runner-retry-'))
    try {
      let calls = 0
      const out = await runTask<string>({
        userDataPath: ud,
        bookRoot,
        task: 'self-heal',
        chapter: 1,
        run: () => {
          calls++
          if (calls < 2) throw new GenError('429 limit', true)
          return Promise.resolve('ok')
        },
      })
      expect(out.ok).toBe(true)
      const b = checkAiCallBudget(bookRoot, 1, { budget: { calls_per_chapter: 10 } } as unknown as BookConfig)
      expect(b.ok).toBe(true)
      if (b.ok) expect(b.used).toBe(2) // 1 次失败重试 + 1 次成功，均按真实 API 消耗计数
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  }, 10_000)

  // X-P2-10：终态失败（GEN_FAIL）也入账——此前失败调用不计数，预算闸可被失败路径绕过
  it('X-P2-10：不可重试失败入账——GEN_FAIL 后 chapter used=1', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-runner-fail-'))
    try {
      const out = await runTask<string>({
        userDataPath: ud,
        bookRoot,
        task: 'self-heal',
        chapter: 1,
        run: () => {
          throw new GenError('400 bad request', false)
        },
      })
      expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
      const b = checkAiCallBudget(bookRoot, 1, { budget: { calls_per_chapter: 10 } } as unknown as BookConfig)
      expect(b.ok).toBe(true)
      if (b.ok) expect(b.used).toBe(1)
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })

  // X-P2-10：中断/超时路径同样入账——中断重跑不可绕过预算闸
  it('X-P2-10：中断入账——ABORTED 后 chapter used=1（中断重跑不绕预算闸）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-runner-abort-'))
    try {
      const ctrl = new AbortController()
      const out = await runTask<string>({
        userDataPath: ud,
        bookRoot,
        task: 'self-heal',
        chapter: 1,
        ctrl,
        run: () => {
          ctrl.abort()
          throw new GenError('429 limit', true)
        },
      })
      expect(out).toMatchObject({ ok: false, code: 'ABORTED' })
      const b = checkAiCallBudget(bookRoot, 1, { budget: { calls_per_chapter: 10 } } as unknown as BookConfig)
      expect(b.ok).toBe(true)
      if (b.ok) expect(b.used).toBe(1)
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })

  it('不可重试错误 → 不重试，直接 GEN_FAIL', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      run: () => {
        calls++
        throw new GenError('400 bad request', false)
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    expect(calls).toBe(1)
  })

  it('abort 优先于重试（中断不进退避）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const ctrl = new AbortController()
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      ctrl,
      run: () => {
        calls++
        ctrl.abort() // 用户中断
        throw new GenError('429 limit', true) // 虽然可重试，但已 abort
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'ABORTED' })
    expect(calls).toBe(1) // 不重试
  })

  it('Bug C 回归: 可重试错误时 onRetry 回调触发（带 attempt 编号 + 错误文案）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    let calls = 0
    const retries: Array<{ attempt: number; error: string }> = []
    const out = await runTask<string>({
      userDataPath: ud,
      onRetry: (attempt, error) => retries.push({ attempt, error }),
      run: () => {
        calls++
        if (calls < 3) throw new GenError('429 limit', true)
        return Promise.resolve('ok')
      },
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data).toBe('ok')
    expect(calls).toBe(3)
    // 两次重试，attempt 从 0 计数，错误文案透传
    expect(retries).toEqual([
      { attempt: 0, error: '429 limit' },
      { attempt: 1, error: '429 limit' },
    ])
  }, 10_000)

  it('Bug C 回归: 成功无重试时不触发 onRetry', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    let triggered = false
    const out = await runTask<string>({
      userDataPath: ud,
      onRetry: () => {
        triggered = true
      },
      run: (_p, _s) => Promise.resolve('ok'),
    })
    expect(out.ok).toBe(true)
    expect(triggered).toBe(false)
  })
})

describe('ee-P1-2：整体超时与外部 ctrl 隔离', () => {
  // 前置：run 回调挂起不 resolve、只在 signal abort 时 reject——模拟真实 provider
  // 流式行为（在途 HTTP 随 abort 终止），与 chain-events.test.ts 超时用例同款搭法

  it('单次生成超时只杀内部 ctrl → TIMEOUT_TOTAL，外部共享 ctrl 不被污染', async () => {
    const ud = tempUserData()
    writeProviders(ud, 60) // 档位 timeoutMs=60ms：制造真实总超时
    const ctrl = new AbortController() // 编排级共享 ctrl（self-heal 一个 ctrl 跑多章场景）
    const out = await runTask<string>({
      userDataPath: ud,
      ctrl,
      run: (_p, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('timeout')))
        }),
    })
    expect(out).toMatchObject({ ok: false, code: 'TIMEOUT_TOTAL' })
    if (!out.ok) expect(out.error).toContain('生成超时')
    // 关键断言：超时不得 abort 外部 ctrl——否则 self-heal 判 signal.aborted 吞掉超时文案、
    // 误归因为用户中断，批量连写静默停摆
    expect(ctrl.signal.aborted).toBe(false)
  }, 10_000)

  it('外部中断仍生效：external.abort() 经转发 → ABORTED（转发链不被修坏）', async () => {
    const ud = tempUserData()
    writeProviders(ud) // 不设 timeoutMs：默认 10min，本用例只测外部中断路径
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 20) // 模拟 self-heal abortSelfHeal / driver.interrupt
    const out = await runTask<string>({
      userDataPath: ud,
      ctrl,
      run: (_p, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    expect(out).toMatchObject({ ok: false, code: 'ABORTED' })
    expect(ctrl.signal.aborted).toBe(true)
  }, 10_000)

  it('O-5（第十三轮）run 已 resolve 但 abort 恰在返回边界到达 → ABORTED 收口（成功契约不给可能截断的流）', async () => {
    const ud = tempUserData()
    writeProviders(ud) // 不设 timeoutMs：走外部中断分支（timedOut=false → ABORTED）
    const ctrl = new AbortController()
    const out = await runTask<string>({
      userDataPath: ud,
      ctrl,
      // 模拟竞态：流正常 resolve，但外部中断恰在 await 返回边界到达
      run: async () => {
        ctrl.abort()
        return 'possibly-truncated'
      },
    })
    // 修复前：ok:true data='possibly-truncated'——成功契约让给了可能被截断的流
    expect(out).toMatchObject({ ok: false, code: 'ABORTED' })
  }, 10_000)

  it('P-5（第十四轮）用户先中断、总超时定时器晚到仍触发 → 归因 ABORTED（不再误标 TIMEOUT_TOTAL）', async () => {
    const ud = tempUserData()
    writeProviders(ud, 60) // 总超时 60ms
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 20) // t=20 外部中断（先登记 cause 'external'）
    const out = await runTask<string>({
      userDataPath: ud,
      ctrl,
      run: (_p, signal) =>
        new Promise<string>((_resolve, reject) => {
          // run 在 abort 后「晚归队」（模拟在途流清场耗时）：等总超时定时器也已触发后才 reject
          signal.addEventListener('abort', () => setTimeout(() => reject(new Error('late')), 120))
        }),
    })
    // t=20 外部中断 → t=60 定时器触发（cause 已占，不改写）→ t=140 run reject 进 catch。
    // 修复前 catch 只看 timedOut=true → 误标 TIMEOUT_TOTAL
    expect(out).toMatchObject({ ok: false, code: 'ABORTED' })
  }, 10_000)

  it('P-5 对照：无外部中断、run 晚归队 → 仍 TIMEOUT_TOTAL（归因修复不误伤真超时）', async () => {
    const ud = tempUserData()
    writeProviders(ud, 60)
    const out = await runTask<string>({
      userDataPath: ud,
      run: (_p, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => setTimeout(() => reject(new Error('late')), 120))
        }),
    })
    expect(out).toMatchObject({ ok: false, code: 'TIMEOUT_TOTAL' })
  }, 10_000)
})

describe('O-6（第十三轮）降级回调注册幂等化', () => {
  it('同 userDataPath 重复 resolveProvider 只注册一次；换 path 才重注册', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const store = await import('../../src/ai/provider/store.js')
    const spyP = vi.spyOn(store, 'registerDegradedPersist').mockImplementation(() => {})
    const spyL = vi.spyOn(store, 'registerDegradedLookup').mockImplementation(() => {})
    try {
      expect(resolveProvider(ud).ok).toBe(true) // 首次：注册
      expect(resolveProvider(ud).ok).toBe(true) // 同 path：幂等跳过
      expect(resolveProvider(ud).ok).toBe(true)
      expect(spyP).toHaveBeenCalledTimes(1)
      expect(spyL).toHaveBeenCalledTimes(1)
      // 换 path（多 userData 场景）：重注册新闭包
      const ud2 = tempUserData()
      writeProviders(ud2)
      expect(resolveProvider(ud2).ok).toBe(true)
      expect(spyP).toHaveBeenCalledTimes(2)
      expect(spyL).toHaveBeenCalledTimes(2)
    } finally {
      spyP.mockRestore()
      spyL.mockRestore()
    }
  })
})

describe('W-P2-9：降级记忆去重（同一 key 只落盘一次）', () => {
  it('persistDegraded 同一 key 二次触发 → 文件 mtime 不变（跳过重复 load+save）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    // resolveProvider 注册降级回调（内部 load+save+去重）
    const r = resolveProvider(ud)
    expect(r.ok).toBe(true)

    const key = 'prov-test/gpt-4o'
    const fp = join(ud, 'providers.json')
    const mtimeBefore = statSync(fp).mtimeMs

    // 第一次 persist：写入 modelCaps
    persistDegraded(key)
    const mtimeAfterFirst = statSync(fp).mtimeMs

    // 第二次 persist（同 key）：去重命中 → 不写盘
    persistDegraded(key)
    const mtimeAfterSecond = statSync(fp).mtimeMs

    // 第一次写入会改 mtime（文件确实被写）；第二次应完全不动
    expect(mtimeAfterFirst).toBeGreaterThanOrEqual(mtimeBefore)
    expect(mtimeAfterSecond).toBe(mtimeAfterFirst)

    // 落盘内容含 modelCaps 记忆
    const raw = JSON.parse(readFileSync(fp, 'utf8'))
    expect(raw.modelCaps?.[key]).toEqual({ structured: false })
  })

  it('AA-P3-5: 写失败不传播（吞错）且不标记——下次成功调用自动重试', () => {
    const calls: string[] = []
    // 第一次回调模拟 load/save 抛错（磁盘忙/权限）
    registerDegradedPersist((key) => {
      calls.push(key)
      throw new Error('disk busy')
    })
    // 吞错：不向调用方（适配器建流）传播
    expect(() => persistDegraded('a/b')).not.toThrow()
    // 换正常回调 → 同一 key 必须真正执行（失败未标记 → 重试成功）
    registerDegradedPersist((key) => {
      calls.push(key)
    })
    persistDegraded('a/b')
    expect(calls).toEqual(['a/b', 'a/b']) // 失败一次 + 重试成功一次
  })
})