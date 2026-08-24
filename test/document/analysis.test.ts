/**
 * AI 分析信封单测（M12 B0.1）。
 * 覆盖：读写回环 / 多 kind 共存一文件 / 损坏容错 / stale 判定（fm 改动不触发）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readAnalysis,
  writeAnalysis,
  isStale,
  sourceHashOf,
  analysisPath,
  __setAnalysisLockTimeoutForTest,
  type Envelope,
} from '../../src/document/analysis.js'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'

test('writeAnalysis + readAnalysis: 读写回环', () => {
  const root = mkdtempSync(join(tmpdir(), 'analysis-'))
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
  const root = mkdtempSync(join(tmpdir(), 'analysis-'))
  writeAnalysis(root, 'doc_a', 'score', { generatedAt: 't1', model: 'm', sourceHash: 'h1', payload: 1 })
  writeAnalysis(root, 'doc_a', 'emotion', { generatedAt: 't2', model: 'm', sourceHash: 'h2', payload: [1, 2] })
  expect(readAnalysis(root, 'doc_a', 'score')?.payload).toBe(1)
  expect(readAnalysis(root, 'doc_a', 'emotion')?.payload).toEqual([1, 2])
  rmSync(root, { recursive: true, force: true })
})

test('readAnalysis: 无文件 / 无 kind / 结构不符 → null', () => {
  const root = mkdtempSync(join(tmpdir(), 'analysis-'))
  expect(readAnalysis(root, 'doc_a', 'score')).toBeNull()
  writeAnalysis(root, 'doc_a', 'score', { generatedAt: 't', model: 'm', sourceHash: 'h', payload: 0 })
  expect(readAnalysis(root, 'doc_a', 'emotion')).toBeNull() // 文件在但 kind 不在
  rmSync(root, { recursive: true, force: true })
})

test('readAnalysis: 损坏文件 → null', () => {
  const root = mkdtempSync(join(tmpdir(), 'analysis-'))
  mkdirSync(join(root, '项目', '分析'), { recursive: true })
  writeFileSync(analysisPath(root, 'doc_a')!, '{坏 json', 'utf-8')
  expect(readAnalysis(root, 'doc_a', 'score')).toBeNull()
  rmSync(root, { recursive: true, force: true })
})

test('isStale: 正文变更触发过期；fm 改动不触发（sourceHash 基于 strip fm 后正文）', () => {
  const root = mkdtempSync(join(tmpdir(), 'analysis-'))
  const content = '---\n标题: x\n---\n正文内容'
  writeAnalysis(root, 'doc_a', 'score', { generatedAt: 't', model: 'm', sourceHash: sourceHashOf(content), payload: null })
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
  const root = mkdtempSync(join(tmpdir(), 'analysis-'))
  writeAnalysis(root, 'doc_a', 'score', { generatedAt: 't', model: 'm', sourceHash: 'h', payload: 1 })
  const fp = analysisPath(root, 'doc_a')!
  expect(existsSync(fp)).toBe(true)
  // release 删锁文件——不留 `分析/<docId>.json.lock` 残留污染目录
  expect(existsSync(`${fp}.lock`)).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('B-15: 锁被他进程持有（注入短超时）→ 降级裸写不卡死，写入仍完成', () => {
  const root = mkdtempSync(join(tmpdir(), 'analysis-'))
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
