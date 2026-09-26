/**
 * learn-commit 落盘行为直测（src/learn/commit.ts）：
 *
 * - 去重命中留痕（R28-7）：commitDeduped 指纹只含 kind+场景+正文——同批同场景同正文
 *   但技法指令不同的第二条此前静默去重、指令丢失无提示；现命中去重时 log.warn 留痕
 *   （既有条目路径 + 被吞条目的技法指令摘要）。未 initLogging 时镜像 console.warn。
 * - 批量落盘周期让出（R0911-B-P3-3）：commit.ts 转 async + COMMIT_YIELD_EVERY 粒度 +
 *   可注入 yield。让出次数/时机（250 → 2 次；100 → 1 次；99 → 0 次）、缺省 yield 真
 *   归还事件循环、让出抛错 = 调用方中止信号（knowledge.ts 让出点书注册重验依赖）。
 *
 * 放置说明：commit.ts 的幂等测另有锚点位于 studio 域回归文件，本文件按「最小直测」
 * 落在 learn 域，覆盖 commit.ts 自身的两条落盘行为。
 */
import { describe, expect, test, vi } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commitSamples, commitQuotes, type CommitYield } from '../../src/learn/commit.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import type { SampleCandidate } from '../../src/learn/index.js'

describe('commit 去重命中留痕', () => {
  test('去重命中 warn 留痕（既有条目路径 + 被吞条目的技法指令摘要）', async () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'r28-learn-'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // commitSamples 为 async（周期让出）——本测单条路径，await 即原语义
      await commitSamples(bookRoot, [
        { 章号: 1, 打分: 5, 场景: '战斗', 技法指令: '指令甲', 出处: '《甲》第1章', 正文: '同一句正文。' },
      ])
      warnSpy.mockClear()
      // 同场景同正文、不同技法指令：指纹相同 → 去重命中且 warn（修复前静默吞、指令丢失）
      const out = await commitSamples(bookRoot, [
        { 章号: 2, 打分: 5, 场景: '战斗', 技法指令: '指令乙', 出处: '《乙》第2章', 正文: '同一句正文。' },
      ])
      expect(out).toHaveLength(1) // 幂等返回值不变
      const warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(warnText).toContain('去重命中')
      expect(warnText).toContain('指令乙') // 被吞条目的技法指令摘要留痕
      expect(warnText).toContain('文风/条目/样章/') // 既有条目路径留痕
      // 条目仍只落一份（幂等语义不变）
      expect(entryCount(bookRoot)).toBe(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('commit 批量落盘周期让出', () => {
  /** 计数桩：记录每次让出（不真让出——本节只锚次数/时机与落盘完整性） */
  function countingYield(): { fn: CommitYield; calls: () => number } {
    let n = 0
    return {
      fn: async () => {
        n++
      },
      calls: () => n,
    }
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

  describe('让出次数/时机 + 落盘完整', () => {
    test('250 条 samples：恰 2 次让出（第 100/200 条后），250 条全部落盘、返回形状不变', async () => {
      const bookRoot = mkdtempTracked(join(tmpdir(), 'r0911-yield-'))
      const stub = countingYield()
      const out = await commitSamples(bookRoot, samples(250), stub.fn)
      expect(stub.calls()).toBe(2) // 250 = 100 + 100 + 50 → 两整段各让一次
      expect(out).toHaveLength(250)
      expect(entryCount(bookRoot)).toBe(250)
    })

    test('粒度边界：99 → 0 次；100 → 0 次（批尾不再让）；101 → 1 次；200 → 1 次', async () => {
      for (const [n, expectedYields] of [
        [99, 0],
        [100, 0],
        [101, 1],
        [200, 1],
      ] as const) {
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
        Array.from({ length: 400 }, (_, i) => ({
          场景: '对话',
          正文: `金句${i}`,
          出处: `《测试》第 ${i + 1} 章`,
          章号: i + 1,
        })),
        stub.fn,
      )
      expect(stub.calls()).toBe(3)
      expect(out).toHaveLength(400)
      expect(entryCount(bookRoot)).toBe(400)
    })
  })

  describe('缺省让出真归还事件循环', () => {
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

  describe('让出抛错 = 中止信号（knowledge.ts 让出点重验依赖）', () => {
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
})

/** 样章条目目录 .md 计数（addEntry 落 文风/条目/样章/场景-NNN.md） */
function entryCount(bookRoot: string): number {
  const dir = join(bookRoot, '文风', '条目', '样章')
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).length : 0
}
