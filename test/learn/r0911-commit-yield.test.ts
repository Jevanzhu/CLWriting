/**
 * R0911-B-P3-3（2026-09-11 全量重评 GLM-5.3 修复批）回归：learn-commit 批量落盘
 * 周期让出（commit.ts 转 async + COMMIT_YIELD_EVERY 粒度 + 可注入 yield）。
 *
 * - 让出次数/时机：注入计数桩跑大批量，每满 100 条让一次（250 → 2 次；100 → 1 次；
 *   99 → 0 次），且全部条目照常落盘、返回值形状不变——持久化语义只插 await 点。
 * - 缺省 yield 真让出：setImmediate 排队旗标在 commit 完成前必翻转（控制权归还事件
 *   循环，SSE 心跳/其它请求不再被整批冻结）。
 * - 让出抛错 = 调用方中止信号（knowledge.ts 让出点书注册重验依赖）：首个让出点抛错
 *   → 整个 commit 拒绝，已落的前 100 条保留、剩余条目不再写。
 */
import { describe, expect, test } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commitSamples, commitQuotes, type CommitYield } from '../../src/learn/commit.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import type { SampleCandidate } from '../../src/learn/index.js'

/** 计数桩：记录每次让出（不真让出——本文件只锚次数/时机与落盘完整性） */
function countingYield(): { fn: CommitYield; calls: () => number } {
  let n = 0
  return { fn: async () => { n++ }, calls: () => n }
}

/** n 条互异样章候选（指纹互异：正文含序号） */
function samples(n: number): SampleCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    场景: '对话',
    正文: `「样本${i}。」`,
    出处: `《测试》第 ${i + 1} 章`,
    章号: i + 1,
    打分: 50,
  }))
}

/** 样章条目目录 .md 计数（addEntry 落 文风/条目/样章/场景-NNN.md） */
function entryCount(bookRoot: string): number {
  const dir = join(bookRoot, '文风', '条目', '样章')
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).length : 0
}

describe('R0911-B-P3-3: 批量落盘周期让出（次数/时机 + 落盘完整）', () => {
  test('250 条 samples：恰 2 次让出（第 100/200 条后），250 条全部落盘、返回形状不变', async () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'r0911-yield-'))
    const stub = countingYield()
    const out = await commitSamples(bookRoot, samples(250), stub.fn)
    expect(stub.calls()).toBe(2) // 250 = 100 + 100 + 50 → 两整段各让一次
    expect(out).toHaveLength(250)
    expect(entryCount(bookRoot)).toBe(250)
  })

  test('粒度边界：99 → 0 次；100 → 0 次（批尾不再让）；101 → 1 次；200 → 1 次', async () => {
    for (const [n, expectedYields] of [[99, 0], [100, 0], [101, 1], [200, 1]] as const) {
      const bookRoot = mkdtempTracked(join(tmpdir(), 'r0911-yield-edge-'))
      const stub = countingYield()
      const out = await commitSamples(bookRoot, samples(n), stub.fn)
      expect(stub.calls()).toBe(expectedYields)
      expect(out).toHaveLength(n)
      expect(entryCount(bookRoot)).toBe(n)
    }
  })

  test('quotes 路径同粒度：400 条 → 3 次让出（100/200/300 后）、全落盘', async () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'r0911-yield-q-'))
    const stub = countingYield()
    const out = await commitQuotes(
      bookRoot,
      Array.from({ length: 400 }, (_, i) => ({ 场景: '对话', 正文: `金句${i}`, 出处: `《测试》第 ${i + 1} 章`, 章号: i + 1 })),
      stub.fn,
    )
    expect(stub.calls()).toBe(3)
    expect(out).toHaveLength(400)
    expect(entryCount(bookRoot)).toBe(400)
  })
})

describe('R0911-B-P3-3: 缺省让出真归还事件循环', () => {
  test('默认 yield（setImmediate）下，先排队的 immediate 旗标在 commit 完成前必翻转', async () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'r0911-yield-real-'))
    let immediateRan = false
    setImmediate(() => {
      immediateRan = true
    })
    // 缺省 yieldFn：250 条 → 第 100/200 条后各真让出一次；旗标先于 commit 的让出排队，
    // 若 commit 全程同步（修复前形态）旗标必不翻转——这是本修复的行为锚
    const out = await commitSamples(bookRoot, samples(250))
    expect(immediateRan).toBe(true)
    expect(out).toHaveLength(250)
    expect(entryCount(bookRoot)).toBe(250)
  })
})

describe('R0911-B-P3-3: 让出抛错 = 中止信号（knowledge.ts 让出点重验依赖）', () => {
  test('首个让出点抛错 → commit 拒绝上抛；已落 100 条保留、余 150 不再写', async () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'r0911-yield-abort-'))
    const boom = new Error('book moved')
    const fn: CommitYield = async () => {
      throw boom
    }
    await expect(commitSamples(bookRoot, samples(250), fn)).rejects.toBe(boom)
    expect(entryCount(bookRoot)).toBe(100) // 首段 100 条已落（不回滚），中止后无新增
  })
})
