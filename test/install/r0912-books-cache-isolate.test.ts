/**
 * R0912（重评-0911c P3）books.ts 修复批回归：
 *   1. readBooksStrict 指纹缓存边界浅拷贝——调用方就地 mutate 返回数组不再污染缓存
 *      （修复前 appendBookLocked 对命中数组就地 push，跨 await 持同引用的读方可见突增）；
 *   2. appendBookAsync 写段失败 → 契约 {ok:false, reason} 不 reject（修复前
 *      writeBooks → mkdir/atomicWriteFile 抛错直穿，GUI 建书端点 500）。装置 = darwin
 *      `chflags uchg` 锁死 .clwriting/books.jsonl（读成功、rename 落盘失败），精确命中
 *      写段 catch；其余平台 chmod 类装置无法只锁写不锁读（锁文件同目录），按平台门跳过。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBooksStrict, appendBookAsync } from '../../src/install/books.js'
import type { BookEntry } from '../../src/install/books.js'

describe('R0912：books.jsonl 指纹缓存隔离与 appendBookAsync 永不 reject 契约', () => {
  it('缓存边界浅拷贝：就地 mutate 返回数组不污染缓存', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clw-books-cache-'))
    try {
      mkdirSync(join(dir, '.clwriting'))
      writeFileSync(join(dir, '.clwriting', 'books.jsonl'), `${JSON.stringify({ name: '甲', path: '甲', kind: 'long' })}\n`)
      const first = readBooksStrict(dir)
      expect(first).toHaveLength(1)
      first!.push({ name: '侵入', path: '侵入', kind: 'long' } as BookEntry)
      const second = readBooksStrict(dir)
      expect(second).toHaveLength(1) // R0912：缓存本体未被污染
      expect(second![0]!.name).toBe('甲')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appendBookAsync 写段失败 → {ok:false, reason 含写入失败}，不 reject（darwin chflags 装置）', async () => {
    if (process.platform !== 'darwin') return // 其余平台无精确只锁写的装置（锁文件同目录）
    const dir = mkdtempSync(join(tmpdir(), 'clw-books-wfail-'))
    const locked = join(dir, '.clwriting', 'books.jsonl')
    try {
      mkdirSync(join(dir, '.clwriting'))
      writeFileSync(locked, '') // 空表合法：append 读段成功
      execFileSync('chflags', ['uchg', locked]) // rename 覆盖该文件必 EPERM → 写段失败
      const res = await appendBookAsync(dir, { name: '新书', path: '新书', kind: 'long' })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toContain('写入失败')
    } finally {
      try {
        execFileSync('chflags', ['nouchg', locked])
      } catch {
        /* 清理兜底 */
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
