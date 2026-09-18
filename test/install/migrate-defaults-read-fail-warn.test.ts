/**
 * 0918二轮修复批（G106）：migrateBookDefaults 对 books.jsonl 读失败的留痕回归。
 *
 * 修前：readBooks 容错降级空表——读失败（EACCES 等）与真 0 本书不可区分，迁移
 * 整轮静默跳过无 warn（幂等下次重试没错，可观测性为零）。修后：改 readBooksStrict，
 * null（读失败）时 warn 留痕后本轮返回；真 0 本照常静默走正常路径。
 *
 * 读失败模拟：books.jsonl 换成同名目录（statSync 成功 → readFileSync EISDIR →
 * readBooksStrict 返 null），跨平台确定、不依赖 chmod 权限位。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateBookDefaults } from '../../src/install/migrate-defaults.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('migrate-defaults：books.jsonl 读失败 ≠ 真 0 本', () => {
  it('读失败（EISDIR 形态）→ warn 留痕（含「跳过」与重试指引）、本轮返回不崩', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clw-mig-readfail-'))
    // books.jsonl 为目录：readBooksStrict → null（DA-3 拒写族同源失败形态）——
    // .clwriting 父目录须先建（mkdirSync 不递归），否则 ENOENT 而非目标 EISDIR 形态
    mkdirSync(join(wd, '.clwriting'), { recursive: true })
    mkdirSync(join(wd, '.clwriting', 'books.jsonl'))
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    const r = migrateBookDefaults(wd)

    expect(r).toEqual({ books: 0, changed: 0, failed: 0 })
    const hits = warn.mock.calls.filter((c) => String(c[1]).includes('books.jsonl 读取失败'))
    expect(hits).toHaveLength(1)
    expect(String(hits[0]![1])).toContain('跳过')
    expect(String(hits[0]![1])).toContain('下次启动重试')
  })

  it('真 0 本（无 books.jsonl）→ 正常路径静默（零读失败 warn），照常汇总', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clw-mig-zerobooks-'))
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    const r = migrateBookDefaults(wd)

    expect(r).toEqual({ books: 0, changed: 0, failed: 0 })
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('books.jsonl 读取失败'))).toHaveLength(0)
  })

  it('空 books.jsonl（真 0 本的另一形态）→ 同样静默', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clw-mig-emptybooks-'))
    mkdirSync(join(wd, '.clwriting'), { recursive: true })
    writeFileSync(join(wd, '.clwriting', 'books.jsonl'), '', 'utf-8')
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    const r = migrateBookDefaults(wd)

    expect(r).toEqual({ books: 0, changed: 0, failed: 0 })
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('books.jsonl 读取失败'))).toHaveLength(0)
  })
})
