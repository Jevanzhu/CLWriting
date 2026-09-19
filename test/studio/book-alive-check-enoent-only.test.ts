/**
 * H501（七轮修复复核批）：bookMovedFailure 盘面闸 ENOENT-only 口径——
 * stat 仅 ENOENT（书目录真不存在）判 BOOK_MOVED；EACCES/EIO 等瞬态不可读
 * （网络盘离线/杀软/同步盘锁）放行（null）走后续真实写路径如实报错，不得误判
 * 已删致 22 个写端点齐 409「书已改名或已删除」。
 * 先例 = install/books-repair.ts isDirConfirmedMissing（R35-28：existsSync 对一切
 * stat 错误都返 false，不够用）。瞬态错误注入 = helpers/fs-deny 平台分派单源：
 * win32 臂经 vi.mock 包装登记 fs:statSync 拦截；POSIX 臂 chmod 父目录断遍历
 * （stat 目录自身不受其自身权限位影响，须断父路径 +x 才产生 stat EACCES）——
 * 故拒绝目标同时含 bookRoot 与其父目录 长篇/，两臂各按平台机制命中。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { denyFs } from '../helpers/fs-deny.js'
import { bookMovedFailure } from '../../src/studio/server/book-context.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { armFsNamespace } = await import('../helpers/fs-deny.js')
  return armFsNamespace('fs', actual) as typeof actual
})

let workDir = ''
let bookRoot = ''

function makeBook(): void {
  workDir = mkdtempTracked(join(tmpdir(), 'clw-book-alive-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: '书名', path: '长篇/书名', kind: 'long' }) + '\n',
    'utf-8',
  )
  bookRoot = join(workDir, '长篇', '书名')
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 书名\nhost: cc\n', 'utf-8')
}

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('bookMovedFailure 盘面闸 ENOENT-only（H501）', () => {
  it('书在盘 → null 放行；书真不在盘（ENOENT）→ BOOK_MOVED', () => {
    makeBook()
    expect(bookMovedFailure(workDir, '书名', bookRoot)).toBeNull()
    rmSync(bookRoot, { recursive: true })
    const moved = bookMovedFailure(workDir, '书名', bookRoot)
    expect(moved?.code).toBe('BOOK_MOVED')
  })

  it('stat 瞬态 EACCES（非 ENOENT）→ 不误判已删，放行 null（修复前 existsSync 同样返 false 误 409）', () => {
    makeBook()
    const deny = denyFs([bookRoot, join(workDir, '长篇')], { ops: ['fs:statSync'] })
    try {
      expect(bookMovedFailure(workDir, '书名', bookRoot)).toBeNull()
    } finally {
      deny.restore()
    }
    // 解除注入后回归常例：书仍在盘 → null
    expect(bookMovedFailure(workDir, '书名', bookRoot)).toBeNull()
  })
})
