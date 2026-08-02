/**
 * 编排层统一执行器 runTask 单测（审查 §八③）。
 *
 * 覆盖：mock 两形态（文本/工具）短路、未配数据目录、未配置供应商统一文案、
 * mock/真实 decode 一致、resolveProvider 独立行为。
 * （GEN_FAIL / ABORTED 需真实 provider 网络路径，不在这层单测，由 e2e 覆盖。）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runTask, resolveProvider, NO_USERDATA_MSG, NO_PROVIDER_MSG } from '../../src/ai/runner.js'
import { tryMockTool } from '../../src/ai/mock-tool.js'

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