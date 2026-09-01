/**
 * R35-28（三十五轮）回归：repairBooks 幽灵条目如实报告 + 显式清除。
 *
 * 此前「自愈兜底」注释与实际不符：登记写失败留下的幽灵条目（登记在册、目录缺失）
 * repairBooks 只报告 missing 不清除——条目永续、书架卡永远「损坏」且无法经端点删除
 * （resolveWithinRoot 对不存在路径返 null → 400），作者不可自救。修复后：
 * - missing 非空时 RepairResult 带 missingHint（人工修复二选一：移回原位 / 手工编辑 books.jsonl）；
 * - 清除必须显式传 purgeConfirmedMissing（默认关），且仅清「目录确认不存在（ENOENT）」
 *   条目——瞬态不可读（EACCES，网络盘离线等）不误清；逐条留日志；
 * - 可重关联（目录被移动到可扫位置）的条目走 relink，绝不进清除面。
 */
import { mkdtempSync, rmSync, mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { repairBooks, readBooks, writeBooks, type BookEntry } from '../../src/install/books.js'
import { log } from '../../src/log/index.js'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const permsReliable = process.platform !== 'win32' && !isRoot // win chmod 近似 no-op；root 越权不触发 EACCES

let workDir = ''

function makeWorkDir(): string {
  workDir = mkdtempSync(join(tmpdir(), 'r35-repair-ghost-'))
  return workDir
}

function registry(): BookEntry[] {
  return JSON.parse('[' + readFileSync(join(workDir, '.clwriting', 'books.jsonl'), 'utf-8').trim().split('\n').join(',') + ']') as BookEntry[]
}

afterEach(() => {
  vi.restoreAllMocks()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  workDir = ''
})

describe('R35-28 repairBooks 幽灵条目', () => {
  it('默认（不清除）：幽灵条目保留登记 + missing 报告 + missingHint 带人工修复指引', () => {
    makeWorkDir()
    writeBooks(workDir, [
      { name: '在册书', path: '长篇/在册书', kind: 'long' }, // 目录不存在 → 幽灵
    ])
    const r = repairBooks(workDir)
    expect(r.missing.map((b) => b.name)).toEqual(['在册书'])
    expect(r.missingHint).toContain('.clwriting/books.jsonl')
    expect(r.purged).toBeUndefined()
    // 条目仍登记在册（数据安全：自愈不自动清）
    expect(readBooks(workDir).some((b) => b.name === '在册书')).toBe(true)
  })

  it('显式 purgeConfirmedMissing=true：ENOENT 确认缺失的条目被清除并落盘、留日志', () => {
    makeWorkDir()
    writeBooks(workDir, [{ name: '幽灵书', path: '长篇/幽灵书', kind: 'long' }])
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const r = repairBooks(workDir, { purgeConfirmedMissing: true })
    expect(warn).toHaveBeenCalledWith('books', expect.stringContaining('幽灵书'))
    expect(r.purged?.map((b) => b.name)).toEqual(['幽灵书'])
    expect(r.missing).toHaveLength(0)
    expect(r.missingHint).toBeUndefined()
    expect(r.changed).toBe(true)
    expect(readBooks(workDir).some((b) => b.name === '幽灵书')).toBe(false)
    expect(registry().some((b) => b.name === '幽灵书')).toBe(false)
  })

  it.skipIf(!permsReliable)('瞬态不可读（父目录 EACCES）不算确认缺失：显式清除也不误清', () => {
    makeWorkDir()
    mkdirSync(join(workDir, '长篇'))
    writeBooks(workDir, [{ name: '离线书', path: '长篇/离线书', kind: 'long' }])
    // 长篇/ 退为 rw-（无 x）：statSync(长篇/离线书) EACCES 而非 ENOENT——网络盘离线同型
    chmodSync(join(workDir, '长篇'), 0o600)
    try {
      const r = repairBooks(workDir, { purgeConfirmedMissing: true })
      expect(r.purged).toBeUndefined()
      expect(r.missing.map((b) => b.name)).toEqual(['离线书']) // 保留登记、照常报告
      expect(readBooks(workDir).some((b) => b.name === '离线书')).toBe(true)
    } finally {
      chmodSync(join(workDir, '长篇'), 0o700) // 还原保 afterEach 清理可达
    }
  })

  it('可重关联（目录被移动到可扫位置）走 relink，绝不进清除面', () => {
    makeWorkDir()
    writeBooks(workDir, [{ name: '搬家书', path: '长篇/搬家书', kind: 'long' }])
    // 目录仍在书库但换了位置（长篇/新家），book.yaml title = 搬家书 → 自愈按名重关联
    mkdirSync(join(workDir, '长篇', '新家'), { recursive: true })
    writeFileSync(join(workDir, '长篇', '新家', 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 搬家书\nhost: cc\n', 'utf-8')
    const r = repairBooks(workDir, { purgeConfirmedMissing: true })
    expect(r.relinked).toEqual([{ name: '搬家书', from: '长篇/搬家书', to: '长篇/新家' }])
    expect(r.purged).toBeUndefined()
    expect(r.missing).toHaveLength(0)
  })

  it('登记完好时显式清除参数不产生任何副作用（无 hint、无 purged、changed=false）', () => {
    makeWorkDir()
    mkdirSync(join(workDir, '长篇', '完好书'), { recursive: true })
    writeFileSync(join(workDir, '长篇', '完好书', 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 完好书\nhost: cc\n', 'utf-8')
    // created_at 预置（repair 会从 book.yaml mtime 补 created_at——不留会误报 changed）
    writeBooks(workDir, [{ name: '完好书', path: '长篇/完好书', kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }])
    const r = repairBooks(workDir, { purgeConfirmedMissing: true })
    expect(r.changed).toBe(false)
    expect(r.missingHint).toBeUndefined()
    expect(r.purged).toBeUndefined()
    expect(existsSync(join(workDir, '长篇', '完好书'))).toBe(true)
  })
})
