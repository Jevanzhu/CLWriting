import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeGuiActive, readGuiActive, isGuiActive, clearGuiActive, warnIfGuiActive, guiActivePath } from '../../src/process/gui-active.js'

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
