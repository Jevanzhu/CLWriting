/**
 * 编排层统一执行器 runTask 单测（审查 §八③）。
 *
 * 覆盖：mock 两形态（文本/工具）短路、未配数据目录、未配置供应商统一文案、
 * mock/真实 decode 一致、resolveProvider 独立行为。
 * （GEN_FAIL / ABORTED 需真实 provider 网络路径，不在这层单测，由 e2e 覆盖。）
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runTask, resolveProvider, NO_USERDATA_MSG, NO_PROVIDER_MSG } from '../../src/ai/runner.js'
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
})

/** 写最小 providers.json（明文 apiKey，loadProviders 自动迁移加密） */
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
      run: () => Promise.resolve('ok'),
    })
    expect(out.ok).toBe(true)
    expect(triggered).toBe(false)
  })
})