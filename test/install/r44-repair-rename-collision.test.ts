/**
 * R44-6（四十四轮）回归：repairBooks path 命中改名分支的重名检查。
 *
 * 修复前：手工把某书的 book.yaml title 改成与另一书同名后，path 命中分支直接以
 * title 覆写登记名 → books.jsonl 同名双登记（resolveBook 首匹配遮蔽其一、
 * removeBookEntry 按名过滤连删两条）。修复后走 R74-10 同款跳过 + warn：
 * 原条目保留、books.jsonl 落盘不变、日志留痕。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairBooks, writeBooks, readBooks } from '../../src/install/books.js'

const warns: Array<[string, string]> = []
vi.mock('../../src/log/index.js', () => ({
  log: {
    warn: (tag: string, msg: string): void => {
      warns.push([tag, msg])
    },
    info: (): void => {},
    error: (): void => {},
  },
  initLogging: (): void => {},
}))

let wd: string

beforeEach(() => {
  warns.length = 0
  wd = mkdtempSync(join(tmpdir(), 'clw-r44-rename-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
})

/** 造一本已登记的书（登记名 = 目录名 = title，标准形态）。 */
function registerBook(name: string, dir: string, title: string): void {
  const bookRoot = join(wd, ...dir.split('/'))
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nbook:\n  title: ${title}\n`, 'utf-8')
  writeBooks(wd, [...readBooks(wd), { name, path: dir, kind: 'long' as const }])
}

describe('R44-6：repairBooks path 命中改名撞另一书 → 跳过 + warn，不落同名双登记', () => {
  it('乙 的 book.yaml title 手工改成 甲 → 登记名保留 乙、无同名双登记、warn 留痕', () => {
    registerBook('甲', '长篇/甲', '甲')
    registerBook('乙', '长篇/乙', '乙')
    // 手工把 乙 的 title 改成与 甲 同名（缺陷触发面）
    writeFileSync(join(wd, '长篇', '乙', 'book.yaml'), 'spec_version: 1\nbook:\n  title: 甲\n', 'utf-8')

    const result = repairBooks(wd)
    // 无同名双登记：两条登记名字互异
    const names = result.rebuilt.map((b) => b.name).sort()
    expect(names).toEqual(['乙', '甲'])
    // 原条目保留：乙 仍登记在 长篇/乙（未被 title 覆写成 甲）
    expect(result.rebuilt.find((b) => b.path === '长篇/乙')).toMatchObject({ name: '乙', kind: 'long' })
    expect(result.relinked).toHaveLength(0)
    expect(result.missing).toHaveLength(0)
    // 本轮无变更（跳过不算 updated）→ books.jsonl 未被整写，盘上原样
    const lines = readFileSync(join(wd, '.clwriting', 'books.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    // R74-10 同款 warn：点名新名、原登记名与书目录
    expect(warns.length).toBe(1)
    expect(warns[0]![0]).toBe('books')
    expect(warns[0]![1]).toContain('「甲」')
    expect(warns[0]![1]).toContain('「乙」')
    expect(warns[0]![1]).toContain('长篇/乙')

    rmSync(wd, { recursive: true, force: true })
  })

  it('改名不撞名（乙 → 丙）→ 正常改名分支不受误伤、无 warn', () => {
    registerBook('甲', '长篇/甲', '甲')
    registerBook('乙', '长篇/乙', '乙')
    writeFileSync(join(wd, '长篇', '乙', 'book.yaml'), 'spec_version: 1\nbook:\n  title: 丙\n', 'utf-8')

    const result = repairBooks(wd)
    expect(result.rebuilt.map((b) => b.name).sort()).toEqual(['丙', '甲'])
    expect(result.rebuilt.find((b) => b.path === '长篇/乙')).toMatchObject({ name: '丙' })
    expect(result.changed).toBe(true)
    expect(warns).toHaveLength(0)

    rmSync(wd, { recursive: true, force: true })
  })
})
