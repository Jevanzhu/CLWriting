/**
 * R0911-E-P3-3（2026-09-11 全量重评 GLM-5.3 修复批）回归：分析信封迁源删字面
 * 旧文件收编 rmWithRetry。
 *
 * writeAnalysisLocked 落编码文件后锁内删字面旧源，此前裸 rmSync(cp, { force: true })
 * ——win 杀软/索引器对相邻刚写文件的瞬时锁（EPERM/EBUSY）直败，字面旧源滞留拖长
 * 双候选期。修复后走 rmWithRetry（fs/atomic.ts R40-18「确实要删」原语，trash.ts /
 * service.ts 等删源点同款；3×50ms 退避）。本测以 pass-through spy 锚定路由 + 注入
 * EPERM 模拟瞬时/持续占用（平台无关，不依赖 win）：
 * - 瞬时占用一次 → 退避后删源成功（修复前裸 rmSync 直败滞留）；
 * - 持续占用（退避耗尽）→ 既有收口不变：吞错不阻断，下次写重试删。
 */
import { test, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── mock fs/atomic：rmWithRetry 透传 spy + 可注入的 EPERM 预算（组织方式对齐
// r49-15-confirm-candidate-rm-retry.test.ts 的 vi.hoisted + importOriginal 范式；
// 工厂内只引用 orig/动态 import，不触外层 import——vi.mock 工厂提升后外层绑定未初始化）──
const SPY = vi.hoisted(() => ({ calls: [] as string[], epermBudget: new Map<string, number>() }))
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  const fs = await import('node:fs')
  return {
    ...orig,
    rmWithRetry: (p: string, opts?: Parameters<typeof orig.rmWithRetry>[1]) => {
      SPY.calls.push(p)
      return orig.rmWithRetry(p, {
        ...opts,
        sleep: () => {}, // 测试免真等（退避节奏本身由 fs/atomic 既有测试面锁定）
        rm: (q: string) => {
          const n = SPY.epermBudget.get(q) ?? 0
          if (n > 0) {
            SPY.epermBudget.set(q, n - 1)
            throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${q}'`), { code: 'EPERM' })
          }
          fs.rmSync(q, { force: true })
        },
      })
    },
  }
})

import { writeAnalysis, readAnalysisKinds, type Envelope } from '../../src/document/analysis.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function makeBook(): { root: string; literal: string; encoded: string } {
  const root = mkdtempTracked(join(tmpdir(), 'r0911-e-p3-3-'))
  mkdirSync(join(root, '项目', '分析'), { recursive: true })
  // legacy 冒号 id：字面/编码双候选形态（R68-3/R70-1 迁移面）
  const literal = join(root, '项目', '分析', 'legacy:abc.json')
  const encoded = join(root, '项目', '分析', 'legacy_abc.json')
  return { root, literal, encoded }
}

const reviewEnv: Envelope = {
  generatedAt: '2026-09-10T00:00:00.000Z', model: 'm1', sourceHash: 'a'.repeat(64), payload: { verdict: '通过' },
}

test('R0911-E-P3-3: 删字面旧源必经 rmWithRetry，瞬时占用（EPERM 一次）退避后删净不滞留', () => {
  const { root, literal, encoded } = makeBook()
  // 字面旧信封在盘（含既有 review kind——合并基迁移面）
  writeFileSync(literal, JSON.stringify({ review: reviewEnv }), 'utf-8')
  SPY.calls = []
  SPY.epermBudget.set(literal, 1) // 首删瞬时占用一次（win 杀软语义的平台无关模拟）

  writeAnalysis(root, 'legacy:abc', 'score', {
    generatedAt: '2026-09-11T00:00:00.000Z', model: 'm2', sourceHash: 'b'.repeat(64), payload: { 体验分: 9 },
  })

  // 路由锚定：删源必经 rmWithRetry（回退裸 rmSync 则 spy 零调用即红）
  expect(SPY.calls).toEqual([literal])
  expect(existsSync(literal)).toBe(false) // 瞬时占用经退避重试删净，不再滞留字面旧源
  expect(existsSync(encoded)).toBe(true)
  // 迁移合并不回退：字面存量 review 随写迁入编码文件，新 kind 落位
  const kinds = readAnalysisKinds(root, 'legacy:abc', ['review', 'score'])
  expect(kinds.review).toEqual(reviewEnv)
  expect(kinds.score?.model).toBe('m2')
})

test('R0911-E-P3-3: 持续占用（退避耗尽仍失败）→ 既有收口不变：不阻断、下次写重试删', () => {
  const { root, literal, encoded } = makeBook()
  writeFileSync(literal, JSON.stringify({ review: reviewEnv }), 'utf-8')
  SPY.calls = []
  SPY.epermBudget.set(literal, 99) // 恒失败（默认 3 次退避耗尽——「删源失败不阻断」语义）

  expect(() =>
    writeAnalysis(root, 'legacy:abc', 'score', {
      generatedAt: '2026-09-11T00:00:00.000Z', model: 'm2', sourceHash: 'b'.repeat(64), payload: { 体验分: 9 },
    }),
  ).not.toThrow()

  expect(existsSync(encoded)).toBe(true) // 新写已落位（删源失败不阻断合并写）
  expect(existsSync(literal)).toBe(true) // 旧源滞留（读侧双候选仍可读）

  // 占用释放后（预算清零）下次写重试删 → 迁移收口
  SPY.epermBudget.delete(literal)
  writeAnalysis(root, 'legacy:abc', 'hooks', {
    generatedAt: '2026-09-11T00:00:01.000Z', model: 'm2', sourceHash: 'b'.repeat(64), payload: { 密度: 1 },
  })
  expect(existsSync(literal)).toBe(false)
  expect(readAnalysisKinds(root, 'legacy:abc', ['score', 'hooks']).hooks?.model).toBe('m2')
})
