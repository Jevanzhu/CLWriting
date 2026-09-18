/**
 * 0918三轮修复批（G201）回归：repairBooks 扫盘「本轮已发现」同名判重。
 *
 * 修复前新发现分支只查 rebuilt（已登记集）——同一轮扫描先前迭代 push 进 scanned
 * 的同名条目对此处不可见（scanned 循环外才并入 rebuilt）：两本均未登记的同名书
 * （典型 = 手工复制书目录做备份，book.yaml title 随拷贝不变）双双入账 → resolveBook
 * 首匹配遮蔽其一、removeBookEntry 按名过滤连删两条（第二本成无登记幽灵，且后续
 * repair 两 path 都在盘上走命中分支永不判重——不可自愈）。修复后判重命中按
 * R74-10 同款口径 warn 跳过留痕，交作者手动消歧。
 * 锚：0918三轮修复批 G201。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { readBooks, repairBooks } from '../../src/install/books.js'

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
  errMsg: (e: unknown): string => (e instanceof Error ? e.message : String(e)),
}))

let wd: string

beforeEach(() => {
  warns.length = 0
  wd = mkdtempTracked(join(tmpdir(), 'clw-g201-dup-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
})

describe('G201（0918三轮修复批）：扫盘「本轮已发现」同名判重', () => {
  it('两本均未登记的同名书（复制备份形态）→ 只登记先扫到的一处 + warn 留痕另一处', () => {
    for (const dir of ['长篇/甲处同名书', '长篇/乙处同名书']) {
      const bookRoot = join(wd, ...dir.split('/'))
      mkdirSync(bookRoot, { recursive: true })
      writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 备份书\n', 'utf-8')
    }

    const result = repairBooks(wd)
    // 修复前双登记面：恰一条入账（扫盘顺序不进断言——warn 必点「另一处」）
    expect(result.rebuilt).toHaveLength(1)
    const kept = result.rebuilt[0]!
    expect(kept.name).toBe('备份书')
    expect(result.relinked).toHaveLength(0)
    expect(result.missing).toHaveLength(0)
    // G201：跳过留痕——warn 含书名与未登记那处的路径
    expect(warns).toHaveLength(1)
    expect(warns[0]![0]).toBe('books')
    expect(warns[0]![1]).toContain('备份书')
    expect(warns[0]![1]).toContain('本轮已发现另一处同名书目录')
    const other = kept.path === '长篇/甲处同名书' ? '长篇/乙处同名书' : '长篇/甲处同名书'
    expect(warns[0]![1]).toContain(other)
    // 落盘登记恰一条（修复前 resolveBook 首匹配遮蔽其一 + removeBookEntry 连删两条）
    const onDisk = readBooks(wd).filter((b) => b.name === '备份书')
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0]!.path).toBe(kept.path)

    rmSync(wd, { recursive: true, force: true })
  })

  it('两本未登记但书名不同 → 正常双登记，无同名判重误伤', () => {
    const pairs: Array<[string, string]> = [
      ['长篇/书甲', '书甲'],
      ['长篇/书乙', '书乙'],
    ]
    for (const [dir, title] of pairs) {
      const bookRoot = join(wd, ...dir.split('/'))
      mkdirSync(bookRoot, { recursive: true })
      writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nbook:\n  title: ${title}\n`, 'utf-8')
    }

    const result = repairBooks(wd)
    expect(result.rebuilt).toHaveLength(2)
    expect(result.rebuilt.map((b) => b.name).sort()).toEqual(['书乙', '书甲'])
    expect(warns).toHaveLength(0)

    rmSync(wd, { recursive: true, force: true })
  })
})
