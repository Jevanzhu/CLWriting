/**
 * R36-4（三十六轮）回归：writeBookAnalysisAsync 全书信封异步孪生。
 *
 * R36-4 前 analyze-style 落盘走同步 writeBookAnalysis（withAnalysisLock →
 * acquireCrossProcessLockWithTimeout 的 Atomics.wait ≤5s），双进程争用时冻结服务
 * 事件循环（SSE/全部接口停摆）。R36-4 对齐 R34D-19 per-doc 口径建异步孪生：锁等待
 * 走 acquireCrossProcessLockAsync（setTimeout 轮询，事件循环不阻塞）；原同步
 * writeBookAnalysis 已无任何调用方（生产/测试全零，R36-11 复核）→ 删除，不留双版
 * 漂移面。
 *
 * 覆盖：成功路径读写回环 + 多 kind 共存 + 锁文件用后即释；锁被他进程持有时的异步
 * 等待（等待期间外部定时器先触发 = 事件循环未被冻结）；锁超时降级裸写（注入短档）
 * 不抛不卡；并发两个全书写（不同 kind）互斥成立、两 kind 都保留（不丢更新）。
 */
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'vitest'
import {
  analysisBookPath,
  readBookAnalysis,
  writeBookAnalysisAsync,
  __setAnalysisLockTimeoutForTest,
  type Envelope,
} from '../../src/document/analysis.js'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function bookEnv(payload: unknown, tag: string): Envelope {
  return { generatedAt: `t-${tag}`, model: 'mock', sourceHash: 'h'.repeat(64), payload }
}

test('R36-4 成功路径：读写回环 + 多 kind 共存 + 锁文件用后即释', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'r36-analysis-'))
  await writeBookAnalysisAsync(root, 'score', bookEnv({ score: 8 }, 's'))
  await writeBookAnalysisAsync(root, 'emotion', bookEnv([{ emotion: 1, label: '起' }], 'e'))
  expect(readBookAnalysis(root, 'score')).toEqual(bookEnv({ score: 8 }, 's'))
  expect(readBookAnalysis(root, 'emotion')).toEqual(bookEnv([{ emotion: 1, label: '起' }], 'e'))
  // release 删锁文件——不留 `__book__.json.lock` 残留污染分析目录
  expect(existsSync(`${analysisBookPath(root)}.lock`)).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('R36-4 锁被他进程持有 → 异步等待不阻塞事件循环（定时器先于完成触发），释放后写入完成', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'r36-analysis-'))
  const fp = analysisBookPath(root)
  const holder = tryAcquireCrossProcessLock(`${fp}.lock`)
  expect(holder).not.toBeNull()
  try {
    let timerFiredAt = 0
    const timer = setTimeout(() => {
      timerFiredAt = Date.now()
    }, 30)
    // 他进程（持有锁方）约 80ms 后释放——等待窗口足够长，同步 Atomics.wait 版会在此
    // 期间饿死 30ms 定时器（冻结事件循环）；异步孪生轮询期事件循环照常转
    setTimeout(() => holder!(), 80)
    const p = writeBookAnalysisAsync(root, 'score', bookEnv({ score: 7 }, 's'))
    await p
    const resolvedAt = Date.now()
    clearTimeout(timer)
    expect(timerFiredAt).toBeGreaterThan(0) // 定时器确实在等待期间触发
    expect(timerFiredAt).toBeLessThan(resolvedAt - 20) // 触发早于写入完成 = 未冻结
    expect(readBookAnalysis(root, 'score')?.payload).toEqual({ score: 7 })
  } finally {
    holder!()
    rmSync(root, { recursive: true, force: true })
  }
})

test('R36-4 锁超时（注入短档）→ 降级裸写完成，不抛不卡', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'r36-analysis-'))
  const fp = analysisBookPath(root)
  const holder = tryAcquireCrossProcessLock(`${fp}.lock`)
  expect(holder).not.toBeNull()
  __setAnalysisLockTimeoutForTest(40)
  try {
    const t0 = Date.now()
    await writeBookAnalysisAsync(root, 'hooks', bookEnv({ hooks: ['x'], density: '中' }, 'h'))
    expect(Date.now() - t0).toBeLessThan(2_000) // 短超时快速降级，不长时间卡住
    expect(readBookAnalysis(root, 'hooks')?.payload).toEqual({ hooks: ['x'], density: '中' })
  } finally {
    __setAnalysisLockTimeoutForTest(5_000)
    holder!()
    rmSync(root, { recursive: true, force: true })
  }
})

test('R36-4 并发两个全书写（不同 kind）→ 互斥成立、两 kind 都在（异步轮询不丢更新）', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'r36-analysis-'))
  await Promise.all([
    writeBookAnalysisAsync(root, 'score', bookEnv({ score: 9 }, 's')),
    writeBookAnalysisAsync(root, 'emotion', bookEnv([1, 2], 'e')),
  ])
  expect(readBookAnalysis(root, 'score')?.payload).toEqual({ score: 9 })
  expect(readBookAnalysis(root, 'emotion')?.payload).toEqual([1, 2])
  expect(existsSync(`${analysisBookPath(root)}.lock`)).toBe(false)
  rmSync(root, { recursive: true, force: true })
})