/**
 * R37-7（三十七轮批 A）回归——runner 失败封套（TaskErr）携带 attemptsUsage。
 *
 * 缺陷：runner 各次尝试的 usage 已由 recordUsageSafe 记入调用账本（ai-calls），但
 * TaskErr 封套未携带 attemptsUsage——下游（self-heal 失败分支 → done 事件）拿不到
 * 失败前已消耗的 token 用量，预算/成本统计漏记失败调用（R35-17 登记的分叉点）。
 *
 * 覆盖三条失败路径的封套填充：
 * - 终态失败（不可重试 GenError 携 usage）→ attemptsUsage = 该 usage
 * - 重试链多次失败 → attemptsUsage = 各尝试 usage 之和（R34D-1/R35-1 累计口径）
 * - abort 边界失败 → timeoutAbort 封套同样携带
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTask } from '../../src/ai/runner.js'
import { GenError } from '../../src/ai/gen.js'

const workDirs: string[] = []
function tempUserData(): string {
  const d = mkdtempSync(join(tmpdir(), 'clwriting-r37-fail-ud-'))
  workDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 最小 providers.json（run 抛错在触网之前，baseUrl 无需真实可达） */
function writeProviders(userDataPath: string): void {
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-r37',
          name: 'test',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'http://127.0.0.1:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'prov-r37',
      currentModel: 'gpt-4o',
    }),
  )
}

describe('R37-7: TaskErr 失败封套携带 attemptsUsage', () => {
  it('终态失败（不可重试 GenError 携 usage）→ attemptsUsage = 该次 usage，model = 档位快照', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const usage = { inputTokens: 30, outputTokens: 12 }
    const out = await runTask<string>({
      userDataPath: ud,
      run: () => {
        throw new GenError('AI 产出达到长度上限被截断', false, { code: 'MAX_TOKENS', usage })
      },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe('GEN_FAIL')
      // 修复前封套无此字段（undefined）——失败前已发生的计费对下游不可见
      expect(out.attemptsUsage).toEqual(usage)
      expect(out.model).toBe('gpt-4o')
    }
  })

  it('重试链多次失败 → attemptsUsage = 各尝试 usage 之和（累计合并口径）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      run: () => {
        calls++
        if (calls <= 2) throw new GenError('429 limit', true, { code: 'RATE_LIMIT', usage: { inputTokens: 10, outputTokens: 4 } })
        throw new GenError('400 bad request', false, { code: 'MAX_TOKENS', usage: { inputTokens: 7, outputTokens: 2 } })
      },
    })
    expect(out.ok).toBe(false)
    expect(calls).toBe(3) // 两次可重试 + 一次终态
    if (!out.ok) {
      // 修复前 undefined；修复后 = 2×10+7 / 2×4+2（recordUsageSafe 的 attemptsUsage 同源累计）
      expect(out.attemptsUsage).toEqual({ inputTokens: 27, outputTokens: 10 })
    }
  }, 10_000)

  it('abort 边界失败 → timeoutAbort 封套（ABORTED）同样携带已入账 usage', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const ctrl = new AbortController()
    const out = await runTask<string>({
      userDataPath: ud,
      ctrl,
      run: () => {
        ctrl.abort()
        throw new GenError('429 limit', true, { code: 'RATE_LIMIT', usage: { inputTokens: 5, outputTokens: 3 } })
      },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe('ABORTED')
      expect(out.attemptsUsage).toEqual({ inputTokens: 5, outputTokens: 3 })
    }
  })

  it('无任何 usage 的失败 → attemptsUsage 为 null（口径不虚构）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const out = await runTask<string>({
      userDataPath: ud,
      run: () => {
        throw new GenError('400 bad request', false)
      },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.attemptsUsage).toBeNull()
  })
})
