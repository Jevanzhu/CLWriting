/**
 * 0918二轮修复批（G103）：books-repair 扫盘对 book.yaml 读失败跳过该书对账的回归。
 *
 * 修前：detectBookKind 对 !cfgRead.ok 回落 'long'、detectBookName 回落目录名——
 * 杀软/同步盘短暂锁住 book.yaml（EACCES 等）的那次启动，name/kind 登记被改写成
 * 回落值，下轮读成功又翻回，books.jsonl mtime 随抖动。修后：读失败跳过该书本轮
 * 刷新（登记保留原值、不重关联、不新登记），与 isDirConfirmedMissing 的 ENOENT-only
 * 瞬态纪律对齐；读成功照常对账；目录确认缺失照旧走 missing 面。
 *
 * 读失败模拟：book.yaml 换成同名目录（existsSync 对目录为真 → isBookRepo 放行、
 * readFileSync EISDIR → readBookConfig ok:false），与 EACCES 同走「读取失败」分支
 * 且跨平台确定（不依赖 chmod 权限位）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairBooks, writeBooks, readBooks, type BookEntry } from '../../src/install/books.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/** 建书目录（含合法 book.yaml）并登记（name/kind 用登记值，可与盘面错开验改写） */
function makeRegisteredBook(wd: string, relPath: string, title: string, kind: 'long' | 'short'): void {
  mkdirSync(join(wd, relPath), { recursive: true })
  writeFileSync(
    join(wd, relPath, 'book.yaml'),
    `spec_version: 1\nbook:\n  title: ${title}\n${kind === 'short' ? 'kind: short\n' : ''}`,
    'utf-8',
  )
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  writeBooks(wd, [{ name: title, path: relPath, kind } satisfies BookEntry])
}

describe('扫盘对账：book.yaml 读失败 → 跳过该书刷新（保留原登记）', () => {
  it('book.yaml 读失败（EISDIR 形态）→ 登记原值保留、books.jsonl 字节不动、warn 留痕', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clw-repair-readfail-'))
    makeRegisteredBook(wd, '长篇/风起', '风起（原名）', 'short')
    const before = readFileSync(join(wd, '.clwriting', 'books.jsonl'), 'utf-8')

    // 制造读失败：book.yaml 换成同名目录（EISDIR；回落值本会写成 name=风起/kind=long）
    rmSync(join(wd, '长篇/风起', 'book.yaml'))
    mkdirSync(join(wd, '长篇/风起', 'book.yaml'))

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const result = repairBooks(wd)

    expect(result.changed).toBe(false) // 未触发 writeBooks（mtime 不抖动）
    expect(readBooks(wd)).toEqual([
      expect.objectContaining({ name: '风起（原名）', path: '长篇/风起', kind: 'short' }), // 原值保留
    ])
    expect(readFileSync(join(wd, '.clwriting', 'books.jsonl'), 'utf-8')).toBe(before) // 字节级不动
    const hits = warn.mock.calls.filter((c) => String(c[1]).includes('跳过该书本轮登记对账'))
    expect(hits).toHaveLength(1)
    expect(String(hits[0]![1])).toContain('长篇/风起')
  })

  it('未登记的书目录 book.yaml 读失败 → 本轮不新登记（无法定名定 kind，留待下轮）', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clw-repair-readfail-new-'))
    mkdirSync(join(wd, '.clwriting'), { recursive: true })
    // 只建书目录（book.yaml 为目录 → 读失败）；无任何登记
    mkdirSync(join(wd, '长篇', '新书'), { recursive: true })
    mkdirSync(join(wd, '长篇', '新书', 'book.yaml'))

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const result = repairBooks(wd)

    expect(result.changed).toBe(false)
    expect(readBooks(wd)).toHaveLength(0) // 不以目录名/long 回落值登记
    expect(warn.mock.calls.some((c) => String(c[1]).includes('跳过该书本轮登记对账'))).toBe(true)
  })

  it('读成功 → 正常对账改写（对照：kind/name 随 book.yaml 刷新）', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clw-repair-readok-'))
    // 登记 kind=long，盘面 book.yaml 声明 short + 新书名 → 对账应改写
    makeRegisteredBook(wd, '长篇/星落', '星落', 'long')
    writeFileSync(
      join(wd, '长篇/星落', 'book.yaml'),
      'spec_version: 1\nbook:\n  title: 星落·修订版\nkind: short\n',
      'utf-8',
    )

    const result = repairBooks(wd)

    expect(result.changed).toBe(true)
    expect(readBooks(wd)).toEqual([expect.objectContaining({ name: '星落·修订版', path: '长篇/星落', kind: 'short' })])
  })

  it('登记目录真缺失（ENOENT）→ 照旧报告 missing + hint、登记保留（瞬态纪律不受本修复影响）', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clw-repair-missing-'))
    mkdirSync(join(wd, '.clwriting'), { recursive: true })
    writeBooks(wd, [{ name: '幽灵书', path: '幽灵书', kind: 'long' } satisfies BookEntry])

    const result = repairBooks(wd)

    expect(result.missing).toHaveLength(1)
    expect(result.missing[0]!.name).toBe('幽灵书')
    expect(result.missingHint).toContain('books.jsonl')
    expect(readBooks(wd)).toHaveLength(1) // 登记不清除（R35-28 口径不变）
  })
})
