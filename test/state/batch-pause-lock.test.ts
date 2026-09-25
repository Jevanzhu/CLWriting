/**
 * R73-41（二十一轮）回归：.auto-batch.json 读改写套按文件跨进程锁。
 *
 * write/clear 两路都是「读全量 → 改键 → 原子重写」，此前无跨进程互斥——双进程并发
 * 暂停/清暂停时后写者以陈旧镜像整文件重写吞掉先写者刚落的键。修复后 RMW 段持锁；
 * 锁超时降级裸写（观测元数据不挡主流程）。本文件验证：
 * 1. 他进程持锁 → 降级写入仍成功（warn 留痕由 log spy 断言）且不删他人在位锁；
 * 2. 无争用 → 写/清互斥段执行、保留其他键、锁文件不残留。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBatchPause, clearBatchPause, readBatchPause, __setBatchPauseLockTimeoutForTest } from '../../src/state/batch-pause.js'
import { log } from '../../src/log/index.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

describe('R73-41 / batch-pause 跨进程锁', () => {
  let root: string
  let lockPath: string
  beforeEach(() => {
    root = mkdtempTracked(join(tmpdir(), 'r73-pause-'))
    mkdirSync(join(root, '工作区', '待定稿'), { recursive: true })
    lockPath = join(root, '工作区', '待定稿', '.auto-batch.json.lock')
    __setBatchPauseLockTimeoutForTest(80) // 缩短锁等待保测试快
  })
  afterEach(() => {
    __setBatchPauseLockTimeoutForTest(2_000)
    rmSync(root, { recursive: true, force: true })
  })

  it('他进程持锁 → 降级写入成功、warn 留痕、不删他人在位锁', async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      await writeBatchPause(root, { atChapter: 7, reason: 'escalate', detail: '三连黄' })
      expect(readBatchPause(root)?.atChapter).toBe(7)
      expect(warnSpy).toHaveBeenCalled()
      expect(existsSync(lockPath)).toBe(true) // 他人在位锁未被误删
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('无争用 → 写/清正常，其他键保留，锁文件不残留', async () => {
    const fp = join(root, '工作区', '待定稿', '.auto-batch.json')
    writeFileSync(fp, JSON.stringify({ other_key: '保留我' }), 'utf-8')
    await writeBatchPause(root, { atChapter: 3, reason: 'failed', detail: '驱动失败' })
    const obj = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
    expect(obj['other_key']).toBe('保留我')
    expect(readBatchPause(root)?.reason).toBe('failed')
    expect(existsSync(lockPath)).toBe(false)

    await clearBatchPause(root)
    expect(readBatchPause(root)).toBeUndefined()
    // 只剩 paused 被清 → 其他键保留，文件改写不删除
    const after = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
    expect(after['other_key']).toBe('保留我')
    expect(after['paused']).toBeUndefined()
    expect(existsSync(lockPath)).toBe(false)
  })
})
