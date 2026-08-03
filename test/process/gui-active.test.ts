import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeGuiActive, readGuiActive, clearGuiActive } from '../../src/process/gui-active.js'

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

  it('clearGuiActive 清除', () => {
    writeGuiActive(bookRoot)
    clearGuiActive(bookRoot)
    expect(readGuiActive(bookRoot)).toBeNull()
  })
})
