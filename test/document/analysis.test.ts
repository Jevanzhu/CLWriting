/**
 * AI 分析信封单测（M12 B0.1）。
 * 覆盖：读写回环 / 多 kind 共存一文件 / 损坏容错 / stale 判定（fm 改动不触发）。
 */
import { test, expect, describe, vi } from 'vitest'
import { rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readAnalysis,
  readAnalysisKinds,
  writeAnalysis,
  isStale,
  sourceHashOf,
  analysisPath,
  __setAnalysisLockTimeoutForTest,
  type Envelope,
} from '../../src/document/analysis.js'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

test('writeAnalysis + readAnalysis: 读写回环', () => {
  const root = mkdtempTracked(join(tmpdir(), 'analysis-'))
  const env: Envelope = {
    generatedAt: '2026-07-25T00:00:00Z',
    model: 'mock:gcc',
    sourceHash: sourceHashOf('---\n标题: x\n---\n正文'),
    payload: { score: 8 },
  }
  writeAnalysis(root, 'doc_a', 'score', env)
  expect(readAnalysis(root, 'doc_a', 'score')).toEqual(env)
  rmSync(root, { recursive: true, force: true })
})

test('writeAnalysis: 多 kind 共存一文件（互不覆盖）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'analysis-'))
  writeAnalysis(root, 'doc_a', 'score', { generatedAt: 't1', model: 'm', sourceHash: 'h1', payload: 1 })
  writeAnalysis(root, 'doc_a', 'emotion', { generatedAt: 't2', model: 'm', sourceHash: 'h2', payload: [1, 2] })
  expect(readAnalysis(root, 'doc_a', 'score')?.payload).toBe(1)
  expect(readAnalysis(root, 'doc_a', 'emotion')?.payload).toEqual([1, 2])
  rmSync(root, { recursive: true, force: true })
})

test('readAnalysis: 无文件 / 无 kind / 结构不符 → null', () => {
  const root = mkdtempTracked(join(tmpdir(), 'analysis-'))
  expect(readAnalysis(root, 'doc_a', 'score')).toBeNull()
  writeAnalysis(root, 'doc_a', 'score', { generatedAt: 't', model: 'm', sourceHash: 'h', payload: 0 })
  expect(readAnalysis(root, 'doc_a', 'emotion')).toBeNull() // 文件在但 kind 不在
  rmSync(root, { recursive: true, force: true })
})

test('readAnalysis: 损坏文件 → null', () => {
  const root = mkdtempTracked(join(tmpdir(), 'analysis-'))
  mkdirSync(join(root, '项目', '分析'), { recursive: true })
  writeFileSync(analysisPath(root, 'doc_a')!, '{坏 json', 'utf-8')
  expect(readAnalysis(root, 'doc_a', 'score')).toBeNull()
  rmSync(root, { recursive: true, force: true })
})

test('isStale: 正文变更触发过期；fm 改动不触发（sourceHash 基于 strip fm 后正文）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'analysis-'))
  const content = '---\n标题: x\n---\n正文内容'
  writeAnalysis(root, 'doc_a', 'score', {
    generatedAt: 't',
    model: 'm',
    sourceHash: sourceHashOf(content),
    payload: null,
  })
  const env = readAnalysis(root, 'doc_a', 'score')!
  expect(isStale(env, content)).toBe(false)
  // fm 标题改 → 不过期
  expect(isStale(env, '---\n标题: 改\n---\n正文内容')).toBe(false)
  // 正文改 → 过期
  expect(isStale(env, '---\n标题: x\n---\n正文改了')).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

// B-15（第六十轮）：合并写 RMW 跨进程短锁——此前读 raw → merge → 整写无互斥，
// 双进程并发写不同 kind 后写者以其旧 raw 落盘，先写者 kind 静默丢失
test('B-15: 合并写持锁——锁文件用后即释（不留残留）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'analysis-'))
  writeAnalysis(root, 'doc_a', 'score', { generatedAt: 't', model: 'm', sourceHash: 'h', payload: 1 })
  const fp = analysisPath(root, 'doc_a')!
  expect(existsSync(fp)).toBe(true)
  // release 删锁文件——不留 `分析/<docId>.json.lock` 残留污染目录
  expect(existsSync(`${fp}.lock`)).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('B-15: 锁被他进程持有（注入短超时）→ 降级裸写不卡死，写入仍完成', () => {
  const root = mkdtempTracked(join(tmpdir(), 'analysis-'))
  writeAnalysis(root, 'doc_a', 'score', { generatedAt: 't', model: 'm', sourceHash: 'h', payload: 1 })
  const fp = analysisPath(root, 'doc_a')!
  __setAnalysisLockTimeoutForTest(30)
  try {
    const release = tryAcquireCrossProcessLock(`${fp}.lock`)
    expect(release).not.toBeNull()
    // 模拟他进程持锁：本侧短超时降级裸写（X-5/N7 同语义），不抛错不卡死
    writeAnalysis(root, 'doc_a', 'emotion', { generatedAt: 't2', model: 'm', sourceHash: 'h2', payload: [1] })
    expect(readAnalysis(root, 'doc_a', 'emotion')?.payload).toEqual([1])
    expect(readAnalysis(root, 'doc_a', 'score')?.payload).toBe(1)
    release!()
  } finally {
    __setAnalysisLockTimeoutForTest(5_000)
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 分析信封迁源删字面旧文件收编 rmWithRetry：writeAnalysisLocked 落编码文件后锁内删
// 字面旧源，此前裸 rmSync(cp,{force:true})——win 杀软/索引器对相邻刚写文件的瞬时锁
// （EPERM/EBUSY）直败，字面旧源滞留拖长双候选期。修复后走 rmWithRetry（3×50ms 退避）。
// 本组以 pass-through spy 锚定路由 + 注入 EPERM 模拟瞬时/持续占用（平台无关）。──

// rmWithRetry 透传 spy + 可注入的 EPERM 预算（默认空预算 = 全透传真实现）。
const SPY_ATOMIC = vi.hoisted(() => ({ calls: [] as string[], epermBudget: new Map<string, number>() }))
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  const fs = await import('node:fs')
  return {
    ...orig,
    rmWithRetry: (p: string, opts?: Parameters<typeof orig.rmWithRetry>[1]) => {
      SPY_ATOMIC.calls.push(p)
      return orig.rmWithRetry(p, {
        ...opts,
        sleep: () => {}, // 测试免真等（退避节奏本身由 fs/atomic 既有测试面锁定）
        rm: (q: string) => {
          const n = SPY_ATOMIC.epermBudget.get(q) ?? 0
          if (n > 0) {
            SPY_ATOMIC.epermBudget.set(q, n - 1)
            throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${q}'`), { code: 'EPERM' })
          }
          fs.rmSync(q, { force: true })
        },
      })
    },
  }
})

describe('分析信封迁源删字面旧源走退避删', () => {
  function makeBook(): { root: string; literal: string; encoded: string } {
    const root = mkdtempTracked(join(tmpdir(), 'r0911-e-p3-3-'))
    mkdirSync(join(root, '项目', '分析'), { recursive: true })
    // legacy 冒号 id：字面/编码双候选形态
    const literal = join(root, '项目', '分析', 'legacy:abc.json')
    const encoded = join(root, '项目', '分析', 'legacy_abc.json')
    return { root, literal, encoded }
  }

  const reviewEnv: Envelope = {
    generatedAt: '2026-09-10T00:00:00.000Z',
    model: 'm1',
    sourceHash: 'a'.repeat(64),
    payload: { verdict: '通过' },
  }

  test('删字面旧源必经 rmWithRetry，瞬时占用（EPERM 一次）退避后删净不滞留', () => {
    const { root, literal, encoded } = makeBook()
    try {
      // 字面旧信封在盘（含既有 review kind——合并基迁移面）
      writeFileSync(literal, JSON.stringify({ review: reviewEnv }), 'utf-8')
      SPY_ATOMIC.calls = []
      SPY_ATOMIC.epermBudget.set(literal, 1) // 首删瞬时占用一次（win 杀软语义的平台无关模拟）

      writeAnalysis(root, 'legacy:abc', 'score', {
        generatedAt: '2026-09-11T00:00:00.000Z',
        model: 'm2',
        sourceHash: 'b'.repeat(64),
        payload: { 体验分: 9 },
      })

      // 路由锚定：删源必经 rmWithRetry（回退裸 rmSync 则 spy 零调用即红）
      expect(SPY_ATOMIC.calls).toEqual([literal])
      expect(existsSync(literal)).toBe(false) // 瞬时占用经退避重试删净，不再滞留字面旧源
      expect(existsSync(encoded)).toBe(true)
      // 迁移合并不回退：字面存量 review 随写迁入编码文件，新 kind 落位
      const kinds = readAnalysisKinds(root, 'legacy:abc', ['review', 'score'])
      expect(kinds.review).toEqual(reviewEnv)
      expect(kinds.score?.model).toBe('m2')
    } finally {
      SPY_ATOMIC.epermBudget.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('持续占用（退避耗尽仍失败）→ 既有收口不变：不阻断、下次写重试删', () => {
    const { root, literal, encoded } = makeBook()
    try {
      writeFileSync(literal, JSON.stringify({ review: reviewEnv }), 'utf-8')
      SPY_ATOMIC.calls = []
      SPY_ATOMIC.epermBudget.set(literal, 99) // 恒失败（默认 3 次退避耗尽——「删源失败不阻断」语义）

      expect(() =>
        writeAnalysis(root, 'legacy:abc', 'score', {
          generatedAt: '2026-09-11T00:00:00.000Z',
          model: 'm2',
          sourceHash: 'b'.repeat(64),
          payload: { 体验分: 9 },
        }),
      ).not.toThrow()

      expect(existsSync(encoded)).toBe(true) // 新写已落位（删源失败不阻断合并写）
      expect(existsSync(literal)).toBe(true) // 旧源滞留（读侧双候选仍可读）

      // 占用释放后（预算清零）下次写重试删 → 迁移收口
      SPY_ATOMIC.epermBudget.delete(literal)
      writeAnalysis(root, 'legacy:abc', 'hooks', {
        generatedAt: '2026-09-11T00:00:01.000Z',
        model: 'm2',
        sourceHash: 'b'.repeat(64),
        payload: { 密度: 1 },
      })
      expect(existsSync(literal)).toBe(false)
      expect(readAnalysisKinds(root, 'legacy:abc', ['score', 'hooks']).hooks?.model).toBe('m2')
    } finally {
      SPY_ATOMIC.epermBudget.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
