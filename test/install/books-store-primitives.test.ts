/**
 * R0916-7-P3-3（2026-09-16 评审修复批）：books-store 新家导出面直测。
 *
 * 被测行为：登记存储层（常量 / BookEntry / 解析缓存 / 读写 / 登记锁）自 install/books.ts
 * 下沉 install/books-store.ts 后语义逐位不变——① writeBooks → readBooksStrict 往返、
 * 坏行容错、缺文件空表；② DA-3 拒写面（读失败 → null）与读路径降级（readBooks → []）；
 * ③ 登记锁可获取且 release 幂等（锁文件留在 .clwriting/books.lock）；④ books.ts 的
 * re-export 桥与新家同一函数对象（desktop/document/studio 既有 import 面不断）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  BOOKS_LOCK_TIMEOUT_MS,
  CLWRITING_DIR,
  KIND_DIRS,
  readBooks,
  readBooksStrict,
  tryBooksLock,
  tryBooksLockAsync,
  writeBooks,
  type BookEntry,
} from '../../src/install/books-store.js'
import {
  readBooks as readBooksViaFacade,
  readBooksStrict as readBooksStrictViaFacade,
  writeBooks as writeBooksViaFacade,
  tryBooksLock as tryBooksLockViaFacade,
  CLWRITING_DIR as CLWRITING_DIRViaFacade,
} from '../../src/install/books.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const entryOf = (name: string, path = `长篇/${name}`): BookEntry => ({ name, path, kind: 'long' })

describe('install/books-store：存储层导出面（R0916-7-P3-3）', () => {
  it('常量与类型导出面：CLWRITING_DIR / KIND_DIRS / 锁超时档', () => {
    expect(CLWRITING_DIR).toBe('.clwriting')
    expect(KIND_DIRS).toEqual({ long: '长篇', short: '短篇' })
    expect(BOOKS_LOCK_TIMEOUT_MS).toBe(5_000)
  })

  it('writeBooks → readBooksStrict 往返（缺文件空表、坏行容错跳过）', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'p33-store-'))
    expect(readBooksStrict(wd)).toEqual([]) // 首启：缺文件 = 新建合法
    writeBooks(wd, [entryOf('甲书'), entryOf('乙书', '短篇/乙书')])
    expect(readBooksStrict(wd)).toEqual([
      { name: '甲书', path: '长篇/甲书', kind: 'long' },
      { name: '乙书', path: '短篇/乙书', kind: 'long' },
    ])
    // 坏行（非 JSON / 缺字段）跳过不崩；BOM 前缀剥除（R40-25）同口径
    writeFileSync(
      join(wd, CLWRITING_DIR, 'books.jsonl'),
      '\uFEFF' + JSON.stringify(entryOf('丙书')) + '\n{坏行\n',
      'utf-8',
    )
    expect(readBooks(wd)).toEqual([{ name: '丙书', path: '长篇/丙书', kind: 'long' }])
  })

  it('DA-3 拒写面：books.jsonl 为目录（读失败）→ readBooksStrict=null，readBooks 降级空表', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'p33-store-da3-'))
    mkdirSync(join(wd, CLWRITING_DIR, 'books.jsonl'), { recursive: true })
    expect(readBooksStrict(wd)).toBeNull()
    expect(readBooks(wd)).toEqual([])
  })

  it('登记锁：可获取、release 幂等、缺 .clwriting 时先建目录（R44-18 收编语义）', async () => {
    const wd = mkdtempTracked(join(tmpdir(), 'p33-store-lock-'))
    const release = tryBooksLock(wd)
    expect(release).not.toBeNull()
    expect(existsSync(join(wd, CLWRITING_DIR, 'books.lock'))).toBe(true)
    release!()
    release!() // 幂等
    const releaseAsync = await tryBooksLockAsync(wd)
    expect(releaseAsync).not.toBeNull()
    releaseAsync!()
    // 锁文件残留（release 删除 best-effort）不影响后续获取：同进程再取成功
    const again = tryBooksLock(wd)
    expect(again).not.toBeNull()
    again!()
    rmSync(join(wd, CLWRITING_DIR, 'books.lock'), { force: true })
  })

  it('books.ts 的 re-export 桥与新家同一函数/常量对象（既有消费方 import 面不断）', () => {
    expect(readBooksViaFacade).toBe(readBooks)
    expect(readBooksStrictViaFacade).toBe(readBooksStrict)
    expect(writeBooksViaFacade).toBe(writeBooks)
    expect(tryBooksLockViaFacade).toBe(tryBooksLock)
    expect(CLWRITING_DIRViaFacade).toBe(CLWRITING_DIR)
  })

  it('登记文件落盘位置：.clwriting/books.jsonl 一行一书（存储层路径口径不变）', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'p33-store-path-'))
    writeBooks(wd, [entryOf('甲书')])
    const raw = readFileSync(join(wd, CLWRITING_DIR, 'books.jsonl'), 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.trim().split('\n')).toHaveLength(1)
  })
})
