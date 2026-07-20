import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPidAlive, isBatchActive, createWorkdirMutex } from '../../src/document/mutex.js'
import {
  acquireEditingWorkdir,
  releaseEditingWorkdir,
  isEditingWorkdirActive,
  writeGuiActive,
  readGuiActive,
  guiActivePath,
} from '../../src/process/gui-active.js'
import { writeBatchProgress } from '../../src/auto/batch.js'

describe('mutex / 工作区编辑锁', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'mutex-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('isPidAlive：当前进程活、不存在 pid 死、非法 pid 死', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(999999)).toBe(false)
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
  })

  it('acquireEditingWorkdir 置位后 isEditingWorkdirActive=true', () => {
    expect(isEditingWorkdirActive(bookRoot)).toBe(false)
    expect(acquireEditingWorkdir(bookRoot)).toBe(true)
    expect(isEditingWorkdirActive(bookRoot)).toBe(true)
    expect(readGuiActive(bookRoot)?.editing_workdir).toBe(true)
  })

  it('releaseEditingWorkdir 清锁，保留 pid/ts', () => {
    acquireEditingWorkdir(bookRoot)
    releaseEditingWorkdir(bookRoot)
    expect(isEditingWorkdirActive(bookRoot)).toBe(false)
    const rec = readGuiActive(bookRoot)
    expect(rec).not.toBeNull()
    expect(rec?.editing_workdir).toBeUndefined()
    expect(typeof rec?.pid).toBe('number')
  })

  it('editing_workdir=true 但 ts 过期 → 不活跃', () => {
    writeFileSync(
      guiActivePath(bookRoot),
      JSON.stringify({ pid: process.pid, ts: Date.now() - 60_000, editing_workdir: true }),
      'utf8',
    )
    expect(isEditingWorkdirActive(bookRoot)).toBe(false)
  })

  it('writeGuiActive 心跳保留本进程的 editing_workdir（续期不清锁）', () => {
    acquireEditingWorkdir(bookRoot)
    writeGuiActive(bookRoot)
    expect(readGuiActive(bookRoot)?.editing_workdir).toBe(true)
    expect(isEditingWorkdirActive(bookRoot)).toBe(true)
  })

  it('writeGuiActive 不保留其他进程的 editing_workdir（单写者）', () => {
    writeFileSync(
      guiActivePath(bookRoot),
      JSON.stringify({ pid: 99999, ts: Date.now(), editing_workdir: true }),
      'utf8',
    )
    writeGuiActive(bookRoot)
    expect(readGuiActive(bookRoot)?.editing_workdir).toBeUndefined()
  })
})

describe('mutex / batch 活跃性', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'batch-'))
    mkdirSync(join(bookRoot, '工作区', '待定稿'), { recursive: true })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('无 batch 文件 → 不活跃', () => {
    expect(isBatchActive(bookRoot)).toBe(false)
  })

  it('已完成批次 → 不活跃', () => {
    writeBatchProgress(bookRoot, {
      start_chapter: 1, target_count: 2, next_chapter: 3, completed: [1, 2],
      isolated: [], paused: null, started_at: new Date().toISOString(), host_pid: process.pid,
    })
    expect(isBatchActive(bookRoot)).toBe(false)
  })

  it('未完 + 当前 pid → 活跃', () => {
    writeBatchProgress(bookRoot, {
      start_chapter: 1, target_count: 3, next_chapter: 2, completed: [1],
      isolated: [], paused: null, started_at: new Date().toISOString(), host_pid: process.pid,
    })
    expect(isBatchActive(bookRoot)).toBe(true)
  })

  it('未完 + 死 pid → 不活跃', () => {
    writeBatchProgress(bookRoot, {
      start_chapter: 1, target_count: 3, next_chapter: 2, completed: [1],
      isolated: [], paused: null, started_at: new Date().toISOString(), host_pid: 999999,
    })
    expect(isBatchActive(bookRoot)).toBe(false)
  })

  it('未完 + 无 host_pid（旧文件）→ 保守视为活跃', () => {
    writeBatchProgress(bookRoot, {
      start_chapter: 1, target_count: 3, next_chapter: 2, completed: [1],
      isolated: [], paused: null, started_at: new Date().toISOString(),
    })
    expect(isBatchActive(bookRoot)).toBe(true)
  })

  it('createWorkdirMutex 组合 acquireEditing + isBatchActive', () => {
    const m = createWorkdirMutex(bookRoot)
    expect(m.acquireEditing()).toBe(true)
    expect(m.isBatchActive()).toBe(false)
  })
})
