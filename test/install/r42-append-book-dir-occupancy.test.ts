/**
 * R42-35（四十二轮）回归：appendBook 登记目录占用判重。
 *
 * 大小写不敏感卷（win）上 Foo/foo 两个书名 join 后指向同一书目录——此前 appendBook
 * 只做登记名判重（b.name === entry.name），Foo 在册再建 foo 时名字不同放行，落成
 * 「双登记同库」形态（书架两张卡互踩、删一张殃及另一张的登记面）。修复后补
 * samePath 目录占用判重（win32 双侧折叠比较；posix 全等不误伤）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendBook, appendBookAsync, readBooks } from '../../src/install/books.js'

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
})

/** 建带 Foo 登记的工作目录（不落书目录——appendBook 只管登记面）。 */
function mkWorkDirWithFoo(): string {
  const wd = mkdtempSync(join(tmpdir(), 'clw-r42-append-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  writeFileSync(
    join(wd, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: 'Foo', path: '长篇/Foo', kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n',
    'utf-8',
  )
  return wd
}

describe('R42-35：appendBook 目录占用判重', () => {
  it('win32：既有 Foo 登记再建 foo（名不同、目录同库形态）→ 冲突拒绝、books.jsonl 不变', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const wd = mkWorkDirWithFoo()
    try {
      // 同步版（appendBook → appendBookLocked）
      const syncRes = appendBook(wd, { name: 'foo', path: '长篇/foo', kind: 'long', created_at: '2026-01-02T00:00:00.000Z' })
      expect(syncRes.ok).toBe(false)
      expect((syncRes as { ok: false; reason: string }).reason).toContain('Foo')
      expect((syncRes as { ok: false; reason: string }).reason).toContain('换个名字或先删掉旧的')
      // 登记不被写入（仍只有 Foo 一行）
      expect(readBooks(wd).map((b) => b.name)).toEqual(['Foo'])
      // 异步孪生（GUI 建书面 appendBookAsync）同源收口
      const asyncRes = await appendBookAsync(wd, { name: 'foo', path: '长篇/foo', kind: 'long' })
      expect(asyncRes.ok).toBe(false)
      expect(readBooks(wd).map((b) => b.name)).toEqual(['Foo'])
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('posix：大小写异名不折叠（samePath 全等比较）——正常登记不受误伤', () => {
    const wd = mkWorkDirWithFoo()
    try {
      const res = appendBook(wd, { name: 'foo', path: '长篇/foo', kind: 'long' })
      expect(res.ok).toBe(true)
      expect(readBooks(wd).map((b) => b.name).sort()).toEqual(['Foo', 'foo'])
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })
})
