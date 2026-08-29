/**
 * R74-11（七十四轮批 D）：书名字节上限 + doInit mkdir 错误收编。
 * - 超长书名（>120 UTF-8 字节）→ doInit 返 {ok:false, reason 含「书名过长」}，不裸抛
 *   （修复前一路漏到 scaffold 的 mkdirSync ENAMETOOLONG 裸抛，破坏 {ok:false} 契约）
 * - 恰 120 字节（40 汉字）通过名校验（用「长篇 被同名文件占用」的 ENOTDIR 场景证明
 *   已越过校验、落到 scaffold 阶段）
 * - isInvalidBookName 单源收录字节判据（server 建书/改名与 doInit 共用）
 * - scaffold 阶段文件系统错误（ENOTDIR）→ 收编 {ok:false} 不裸抛
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doInit } from '../../src/install/init.js'
import { isInvalidBookName, BOOK_NAME_MAX_BYTES } from '../../src/install/books.js'

function mkWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'clw-r74-name-'))
}

describe('R74-11：书名 UTF-8 字节上限', () => {
  it('超长书名（41 汉字 = 123 字节）→ doInit {ok:false} 人话原因，不裸抛', () => {
    const wd = mkWorkDir()
    try {
      const longName = '书'.repeat(41)
      expect(Buffer.byteLength(longName, 'utf8')).toBeGreaterThan(BOOK_NAME_MAX_BYTES)
      const r = doInit({ workDir: wd, name: longName })
      expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('书名过长') })
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('恰 120 字节（40 汉字）通过名校验——落到 scaffold 阶段（ENOTDIR 场景证明未被判长拦截）', () => {
    const wd = mkWorkDir()
    try {
      // 长篇 分组名被同名文件占用 → scaffold 的 mkdirSync 抛 ENOTDIR；若字节上限
      // 误拦 40 汉字，reason 会是「书名过长」而非「建书目录失败」
      writeFileSync(join(wd, '长篇'), 'not a dir')
      const edgeName = '书'.repeat(40)
      expect(Buffer.byteLength(edgeName, 'utf8')).toBe(BOOK_NAME_MAX_BYTES)
      const r = doInit({ workDir: wd, name: edgeName })
      expect(r).toMatchObject({
        ok: false,
        reason: expect.stringContaining('建书目录失败') as string,
      })
      expect((r as { reason: string }).reason).not.toContain('书名过长')
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('isInvalidBookName 收录字节判据（>120 字节 true；=120 字节且无非法字符 false）', () => {
    expect(isInvalidBookName('书'.repeat(41))).toBe(true)
    expect(isInvalidBookName('a'.repeat(121))).toBe(true)
    expect(isInvalidBookName('书'.repeat(40))).toBe(false)
    expect(isInvalidBookName('a'.repeat(120))).toBe(false)
  })
})

describe('R74-11：doInit scaffold 阶段文件系统错误收编', () => {
  it('路径段被同名文件占用（ENOTDIR）→ {ok:false} 不裸抛', () => {
    const wd = mkWorkDir()
    try {
      mkdirSync(join(wd, '.clwriting'), { recursive: true })
      writeFileSync(join(wd, '长篇'), '文件占了分组目录名')
      const r = doInit({ workDir: wd, name: '正常长度书名' })
      // 修复前：scaffoldBookRepo 的 mkdirSync ENOTDIR 裸抛穿 doInit
      expect(r).toMatchObject({
        ok: false,
        reason: expect.stringContaining('建书目录失败') as string,
      })
      expect((r as { reason: string }).reason).toContain('ENOTDIR')
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })
})
