/**
 * R35-13（三十五轮）回归：rag.db 文件级损坏的程序化恢复路径（engine 侧）。
 *
 * 断电/磁盘故障/杀软半写后 .cache/rag.db 可能整体不是 SQLite 文件（SQLITE_NOTADB，
 * 实测 node:sqlite 在首个 exec 抛 errcode 26「file is not a database」）——此前 openRagDb
 * 原样上抛：status 500、build/rebuild 同死（resetRagIndex「清表不删文件」对文件级损坏
 * 无效，专为兜底失配而设的重建入口同死）。修复：损坏窄识别（errcode 26/11 + message
 * 兜底）→ resetRagIndex 确认损坏后删库（连 -wal/-shm）全新建；BUSY 等可重试错误绝不
 * 误判损坏误删库。端点级（status 结构化指引 + rebuild 闭环）见
 * test/studio/r35-rag-db-corruption-api.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { resetRagIndex } from '../../src/rag/index.js'
import { openRagDb, readAllChunks, storeChunk, isRagDbCorruptionError } from '../../src/rag/store.js'

describe('R35-13：rag.db 文件级损坏恢复（engine）', () => {
  let bookRoot: string
  const dbPath = (): string => join(bookRoot, '.cache', 'rag.db')

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r35-corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(bookRoot, { recursive: true })
  })

  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  function seedGoodRow(): void {
    const db = openRagDb(bookRoot)
    try {
      storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 10, embedding: Float32Array.from([0.1, 0.2, 0.3]), model: 'm' })
    } finally {
      db.close()
    }
  }

  it('垃圾字节损坏的 rag.db → resetRagIndex 删库重建（连 -wal 侧车），重开可用', () => {
    seedGoodRow()
    // 制造文件级损坏：整个主库文件覆写为非 SQLite 字节流，并留一份侧车残留
    writeFileSync(dbPath(), 'this is definitely not a sqlite database at all'.repeat(8), 'utf8')
    writeFileSync(dbPath() + '-wal', 'stale wal bytes', 'utf8')

    expect(() => resetRagIndex(bookRoot)).not.toThrow()
    expect(existsSync(dbPath() + '-wal')).toBe(false) // 侧车残留一并清除

    // 重建后的库可用：可写入、可读回；损坏前的旧数据不残留
    const db = openRagDb(bookRoot)
    try {
      storeChunk(db, { 章号: 2, start_offset: 0, end_offset: 10, embedding: Float32Array.from([0.4, 0.5, 0.6]), model: 'm' })
      const chunks = readAllChunks(db)
      expect(chunks).toHaveLength(1)
      expect(chunks[0]!.章号).toBe(2)
    } finally {
      db.close()
    }
  })

  it('BUSY（写锁被占）不误判为损坏——resetRagIndex 上抛但绝不删库', () => {
    seedGoodRow()
    // 另一连接 BEGIN EXCLUSIVE 占住写锁：resetRagIndex 的 BEGIN IMMEDIATE 在
    // busy_timeout 内排队后撞 SQLITE_BUSY（errcode 5，非损坏）
    const locker = new DatabaseSync(dbPath())
    locker.exec('PRAGMA busy_timeout = 5000')
    locker.exec('BEGIN EXCLUSIVE')
    locker.exec("INSERT INTO rag_meta (key, value) VALUES ('lock', 'held')")
    try {
      expect(() => resetRagIndex(bookRoot)).toThrow() // 错误上抛（不静默）；非损坏路径不删库
      expect(existsSync(dbPath())).toBe(true) // 误判损坏会删库 → 整库重嵌
      locker.exec('ROLLBACK')
      // 锁释放后重试成功、数据完好
      expect(() => resetRagIndex(bookRoot)).not.toThrow()
      const db = openRagDb(bookRoot)
      try {
        expect(readAllChunks(db)).toHaveLength(0) // resetRagIndex 清表语义不受损
      } finally {
        db.close()
      }
    } finally {
      locker.close()
    }
  })

  it('损坏识别窄匹配：NOTADB/CORRUPT（errcode 26/11 与 message 兜底）判损，BUSY/IO/约束不判', () => {
    const withErrcode = (errcode: number, message: string): Error => Object.assign(new Error(message), { errcode })
    // 损坏面（主 + 扩展码低 8 位 + 无 errcode 的 message 兜底）
    expect(isRagDbCorruptionError(withErrcode(26, 'file is not a database'))).toBe(true)
    expect(isRagDbCorruptionError(withErrcode(11, 'database disk image is malformed'))).toBe(true)
    expect(isRagDbCorruptionError(withErrcode(26 + (1 << 8), 'file is not a database'))).toBe(true)
    expect(isRagDbCorruptionError(new Error('file is not a database'))).toBe(true)
    expect(isRagDbCorruptionError(new Error('database disk image is malformed'))).toBe(true)
    // 可重试面绝不误判（误判 + 删库 = 可重试故障升级成整库重嵌）
    expect(isRagDbCorruptionError(withErrcode(5, 'database is locked'))).toBe(false)
    expect(isRagDbCorruptionError(withErrcode(10, 'disk I/O error'))).toBe(false)
    expect(isRagDbCorruptionError(withErrcode(2067, 'UNIQUE constraint failed: chunks.章号'))).toBe(false)
    expect(isRagDbCorruptionError(new Error('database is locked'))).toBe(false)
    expect(isRagDbCorruptionError(new TypeError('unexpected'))).toBe(false)
  })
})
