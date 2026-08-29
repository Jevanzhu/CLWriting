/**
 * R74-10（七十四轮批 D）：repairBooks 同名书跳过留痕。
 * 修复前：扫盘遇同名书（book.yaml 同标题、登记原路径仍存在）静默 continue——
 * 书架对第二处失明且无痕迹可查。去重语义不变（仍只登记一条），仅补 warn。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairBooks, writeBooks } from '../../src/install/books.js'

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
  wd = mkdtempSync(join(tmpdir(), 'clw-r74-dup-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
})

describe('R74-10：同名书跳过留痕', () => {
  it('两处同名书仓库并存（登记原路径仍存在）→ 不重复登记 + warn 含两处路径', () => {
    // 登记书在 长篇/原目录；扫盘另发现 长篇/复制品 同 title
    writeBooks(wd, [{ name: '同名书', path: '长篇/原目录', kind: 'long' }])
    for (const dir of ['长篇/原目录', '长篇/复制品']) {
      const bookRoot = join(wd, ...dir.split('/'))
      mkdirSync(bookRoot, { recursive: true })
      writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 同名书\n', 'utf-8')
    }

    const result = repairBooks(wd)
    // 去重语义不变：仍只一条登记、无 relink/missing
    expect(result.rebuilt).toHaveLength(1)
    expect(result.rebuilt[0]).toMatchObject({ name: '同名书', path: '长篇/原目录' })
    expect(result.relinked).toHaveLength(0)
    expect(result.missing).toHaveLength(0)
    // R74-10：跳过留痕——warn 含同名书名与两处路径（修复前静默 continue 零痕迹）
    expect(warns.length).toBe(1)
    expect(warns[0]![0]).toBe('books')
    expect(warns[0]![1]).toContain('同名书')
    expect(warns[0]![1]).toContain('长篇/复制品')
    expect(warns[0]![1]).toContain('长篇/原目录')

    rmSync(wd, { recursive: true, force: true })
  })

  it('无同名冲突（正常扫盘/重关联）→ 不产 warn', () => {
    writeBooks(wd, [{ name: '书X', path: '书X', kind: 'long' }])
    const moved = join(wd, '移动后的书X')
    mkdirSync(moved, { recursive: true })
    writeFileSync(join(moved, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 书X\n', 'utf-8')

    const result = repairBooks(wd)
    expect(result.relinked).toEqual([{ name: '书X', from: '书X', to: '移动后的书X' }])
    expect(warns).toHaveLength(0) // 重关联不是跳过，不误报

    rmSync(wd, { recursive: true, force: true })
  })
})
