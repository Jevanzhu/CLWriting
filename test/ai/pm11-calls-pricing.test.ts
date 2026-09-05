/**
 * PM-11（性能与内存专项·2026-09-05）回归：ai-calls 合并记账 + 价格解析 memo。
 *
 * - recordUsageBoth（dev 侧 R46-21 同题实现；合并批自 stash 的 recordUsageCombined 用例移植，断言意图不变）：task + chapter 两块记账合并为单次持锁读改写（原 runner
 *   recordUsageSafe 两笔各自 serializedWrite = 同一 usage 两次整读+两次原子写+双 fsync）。
 *   断言：①真实落盘次数（atomicWriteFile 调用计数）合并 = 1、两分身串行 = 2；
 *   ②合并结果与两分身串行产物逐字段一致（fresh/同章累加/换章重置三形态）；
 *   ③单块退化（task-only / chapter-only）与对应分身产物一致；corrupt 整体跳过不写；
 *   双缺省 no-op 不建文件。
 * - resolveModelPricing memo：同 (userDataPath, model) 且 providers.json mtime 未变
 *   → 命中缓存；文件改写（mtime bump）→ 失效重解析出新价。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实落盘计数：包裹 atomicWriteFile（行为透传 actual，只计数）——合并记账的核心
// 断言是「同一笔 usage 只落一次盘」，直接观测写原语而非文件形态。
const atomicWrites = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return {
    ...actual,
    atomicWriteFile: ((...args: Parameters<typeof actual.atomicWriteFile>) => {
      atomicWrites.n += 1
      return actual.atomicWriteFile(...args)
    }) as typeof actual.atomicWriteFile,
  }
})

import { recordUsageBoth, recordAiCall, recordTaskUsage } from '../../src/ai/calls.js'
import { resolveModelPricing } from '../../src/ai/pricing.js'
import type { TokenUsage } from '../../src/ai/provider/index.js'

const dirs: string[] = []
function tempBook(): string {
  const d = mkdtempSync(join(tmpdir(), 'pm11-calls-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  atomicWrites.n = 0
})

const USAGE: TokenUsage = { inputTokens: 100, outputTokens: 200, cacheReadTokens: 10, estimated: true }
const readRec = (root: string) =>
  JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8')) as Record<string, unknown>

describe('PM-11 recordUsageBoth 合并记账（合并批自 stash recordUsageCombined 用例移植）', () => {
  it('同一笔 usage：合并 = 1 次落盘；两分身串行 = 2 次', () => {
    const merged = tempBook()
    recordUsageBoth(merged, 'gen', 1, USAGE, 0.5)
    expect(atomicWrites.n).toBe(1)

    const split = tempBook()
    recordTaskUsage(split, 'gen', USAGE)
    recordAiCall(split, 1, USAGE, 0.5)
    expect(atomicWrites.n).toBe(3) // 1（合并）+ 2（两分身）
  })

  it('合并结果与两分身串行产物逐字段一致（fresh 档）', () => {
    const merged = tempBook()
    recordUsageBoth(merged, 'gen', 1, USAGE, 0.5)
    const split = tempBook()
    recordTaskUsage(split, 'gen', USAGE)
    recordAiCall(split, 1, USAGE, 0.5)
    expect(readRec(merged)).toEqual(readRec(split))
  })

  it('同章累加形态逐字段一致', () => {
    const merged = tempBook()
    recordUsageBoth(merged, 'gen', 1, USAGE, 0.5)
    recordUsageBoth(merged, 'gen', 1, USAGE, 0.25)
    const split = tempBook()
    recordTaskUsage(split, 'gen', USAGE)
    recordAiCall(split, 1, USAGE, 0.5)
    recordTaskUsage(split, 'gen', USAGE)
    recordAiCall(split, 1, USAGE, 0.25)
    expect(readRec(merged)).toEqual(readRec(split))
    const rec = readRec(merged) as { chapter: { used: number }; tasks: Record<string, { used: number }> }
    expect(rec.chapter.used).toBe(2)
    expect(rec.tasks['gen']!.used).toBe(2)
  })

  it('换章重置形态逐字段一致（tasks 保留、chapter 块重建）', () => {
    const merged = tempBook()
    recordUsageBoth(merged, 'gen', 1, USAGE, 0.5)
    recordUsageBoth(merged, 'gen', 2, USAGE, 0.25)
    const split = tempBook()
    recordTaskUsage(split, 'gen', USAGE)
    recordAiCall(split, 1, USAGE, 0.5)
    recordTaskUsage(split, 'gen', USAGE)
    recordAiCall(split, 2, USAGE, 0.25)
    expect(readRec(merged)).toEqual(readRec(split))
    const rec = readRec(merged) as { chapter: { num: number; used: number } }
    expect(rec.chapter.num).toBe(2)
    expect(rec.chapter.used).toBe(1)
  })

  it('单块退化：task-only / chapter-only 与对应分身产物一致', () => {
    const mergedTask = tempBook()
    recordUsageBoth(mergedTask, 'rag-embed', undefined, USAGE)
    const splitTask = tempBook()
    recordTaskUsage(splitTask, 'rag-embed', USAGE)
    expect(readRec(mergedTask)).toEqual(readRec(splitTask))

    const mergedCh = tempBook()
    recordUsageBoth(mergedCh, undefined, 3, USAGE, 0.1)
    const splitCh = tempBook()
    recordAiCall(splitCh, 3, USAGE, 0.1)
    expect(readRec(mergedCh)).toEqual(readRec(splitCh))
  })

  it('corrupt 记录整体跳过不落盘；双缺省 no-op 不建文件', () => {
    const corrupt = tempBook()
    mkdirSync(join(corrupt, '.cache'), { recursive: true })
    writeFileSync(join(corrupt, '.cache', 'ai-calls.json'), '{broken json', 'utf-8')
    const before = atomicWrites.n
    recordUsageBoth(corrupt, 'gen', 1, USAGE)
    expect(atomicWrites.n).toBe(before)
    expect(readFileSync(join(corrupt, '.cache', 'ai-calls.json'), 'utf-8')).toBe('{broken json')

    const noop = tempBook()
    recordUsageBoth(noop, undefined, undefined, USAGE)
    expect(existsCached(noop)).toBe(false)
  })

  function existsCached(root: string): boolean {
    try {
      readFileSync(join(root, '.cache', 'ai-calls.json'))
      return true
    } catch {
      return false
    }
  }
})

describe('PM-11 resolveModelPricing memo', () => {
  // USER 目录每用例自建（模块级创建会被前一个 describe 的 afterEach splice+rmSync 误删）
  function makeUser(): string {
    const d = mkdtempSync(join(tmpdir(), 'pm11-pricing-'))
    dirs.push(d)
    return d
  }

  function writeProviders(user: string, input: number): void {
    writeFileSync(
      join(user, 'providers.json'),
      JSON.stringify({
        currentId: 'p1',
        providers: [
          {
            id: 'p1',
            name: '中转',
            protocol: 'openai',
            auth: 'bearer',
            baseUrl: 'https://example.invalid',
            apiKey: 'sk-test',
            pricing: { inputPerMTok: input, outputPerMTok: 2 },
            models: [{ id: 'gpt-x' }],
          },
        ],
      }),
      'utf-8',
    )
  }

  it('同 mtime 命中缓存；文件改写（mtime bump）后失效重解析', () => {
    const user = makeUser()
    writeProviders(user, 1)
    const first = resolveModelPricing(user, 'gpt-x')
    expect(first?.inputPerMTok).toBe(1)
    expect(resolveModelPricing(user, 'gpt-x')).toEqual(first) // 命中 memo

    writeProviders(user, 5) // 新价 + mtime 必变（内容不同 → 写入时刻不同）
    const second = resolveModelPricing(user, 'gpt-x')
    expect(second?.inputPerMTok).toBe(5)

    // mtime 稳定（不变）→ memo 命中（值保持 5 档）；「mtime 变必失效」已由上行重解析钉住
    expect(resolveModelPricing(user, 'gpt-x')?.inputPerMTok).toBe(5)
    utimesSync(join(user, 'providers.json'), 1, 1) // mtime 变（回拨）→ memo 失效重解析（同内容同值）
    expect(resolveModelPricing(user, 'gpt-x')?.inputPerMTok).toBe(5)
  })

  it('文件缺失 → null（未配价），memo 不误报已配价', () => {
    const empty = makeUser()
    expect(resolveModelPricing(empty, 'any')).toBeNull()
    expect(resolveModelPricing(empty, 'any')).toBeNull()
  })
})
