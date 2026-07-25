import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeGuiActive, readGuiActive, isGuiActive, clearGuiActive, warnIfGuiActive, acquireEditingWorkdir, releaseEditingWorkdir, isHandDraftLocked, guiActivePath } from '../../src/process/gui-active.js'

describe('GUI 活跃标记（#1.5）', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-gui-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('writeGuiActive → readGuiActive 往返', () => {
    writeGuiActive(bookRoot)
    const rec = readGuiActive(bookRoot)
    expect(rec).not.toBeNull()
    expect(rec!.pid).toBe(process.pid)
  })

  it('isGuiActive 新鲜时 active', () => {
    writeGuiActive(bookRoot)
    expect(isGuiActive(bookRoot).active).toBe(true)
  })

  it('心跳过期（>30s）后不活跃', () => {
    writeFileSync(guiActivePath(bookRoot), JSON.stringify({ pid: 1, ts: Date.now() - 60_000 }))
    expect(isGuiActive(bookRoot).active).toBe(false)
  })

  it('clearGuiActive 清除', () => {
    writeGuiActive(bookRoot)
    clearGuiActive(bookRoot)
    expect(readGuiActive(bookRoot)).toBeNull()
  })

  it('warnIfGuiActive 活跃时打印提示', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeGuiActive(bookRoot)
    warnIfGuiActive(bookRoot)
    expect(spy).toHaveBeenCalled()
    expect(String(spy.mock.calls[0]?.[0] ?? '')).toContain('GUI')
    spy.mockRestore()
  })

  it('warnIfGuiActive 不活跃时静默', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnIfGuiActive(bookRoot)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('hand 草稿锁（M12 B0.4）', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-hand-lock-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('acquireEditingWorkdir(draftRel) → isHandDraftLocked 命中目标；非目标不锁', () => {
    acquireEditingWorkdir(bookRoot, '工作区/草稿-1.md')
    expect(isHandDraftLocked(bookRoot, '工作区/草稿-1.md')).toBe(true)
    expect(isHandDraftLocked(bookRoot, '工作区/草稿-2.md')).toBe(false)
  })

  it('无 draftRelPath（普通编辑锁）→ isHandDraftLocked false（不阻 Studio 保存）', () => {
    acquireEditingWorkdir(bookRoot)
    expect(isHandDraftLocked(bookRoot, '工作区/草稿-1.md')).toBe(false)
  })

  it('writeGuiActive（Studio 心跳）保留 hand 锁字段（不同 pid 不清）', () => {
    acquireEditingWorkdir(bookRoot, '工作区/草稿-1.md')
    writeGuiActive(bookRoot) // Studio 心跳续期
    expect(isHandDraftLocked(bookRoot, '工作区/草稿-1.md')).toBe(true)
  })

  it('releaseEditingWorkdir 清 hand 锁', () => {
    acquireEditingWorkdir(bookRoot, '工作区/草稿-1.md')
    releaseEditingWorkdir(bookRoot)
    expect(isHandDraftLocked(bookRoot, '工作区/草稿-1.md')).toBe(false)
  })
})
