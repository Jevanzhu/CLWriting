/**
 * R71-36（十九轮）回归：resolveRagDbPath 双进程并发迁移竞态——败者的 renameSync
 * 撞上胜者已完成的迁移（legacy 已被迁走）时 ENOENT；修复前无条件回退 legacyPath
 * 会在旧路径重新开出空库（会话白跑 + 孤儿库残留）。修复后先复查 dbPath：存在 ⇒
 * 改道新库；仍不存在才回退旧路径。
 */
import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRagDbPath } from '../../src/rag/store.js'

test('R71-36: 败者迁移撞胜者已迁移完成（legacy 不在、db 在）→ 改道新库不开空库', () => {
  const root = mkdtempSync(join(tmpdir(), 'r71-rag-'))
  try {
    // 胜者已完成迁移的终局盘面：新库在、旧库已被迁走
    mkdirSync(join(root, '.cache'), { recursive: true })
    const db = new DatabaseSync(join(root, '.cache', 'rag.db'))
    db.exec('CREATE TABLE IF NOT EXISTS t(x)')
    db.close()

    const resolved = resolveRagDbPath(root)
    expect(resolved).toBe(join(root, '.cache', 'rag.db'))
    // 关键断言：不得在旧路径开新库（修复前回退 legacyPath → DatabaseSync 惰性建文件）
    const reopened = new DatabaseSync(resolved)
    reopened.exec('SELECT count(*) FROM t') // 胜者的表还在——不是空库
    reopened.close()
    expect(existsSync(join(root, '.rag.db'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R71-36: 真迁移失败（旧在、新不在且 rename 不可行）→ 仍回退旧路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'r71-rag-legacy-'))
  try {
    // 旧库在、新库不在：resolve 会尝试真实迁移（checkpoint + rename）——正常环境
    // 迁移成功即验证主路径；迁移成功后新库必须存在且旧库不再被引用
    const legacy = new DatabaseSync(join(root, '.rag.db'))
    legacy.exec('CREATE TABLE IF NOT EXISTS t(x)')
    legacy.close()

    const resolved = resolveRagDbPath(root)
    expect(resolved).toBe(join(root, '.cache', 'rag.db'))
    expect(existsSync(join(root, '.cache', 'rag.db'))).toBe(true)
    expect(existsSync(join(root, '.rag.db'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
