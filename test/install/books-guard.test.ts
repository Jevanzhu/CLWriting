/**
 * 低级项（第六轮）数据层回归——readBooks / readActive 读失败守卫。
 * existsSync 通过但 readFileSync 失败（EACCES / EISDIR 等）原先裸抛，书架 /
 * resolveBookRoot 等读路径整链 500；现降级为空表 / null（与缺文件同口径）。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBooks, readActive, appendBook, removeBookEntry, readBooksStrict, repairBooks } from '../../src/install/books.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

test('低级项（第六轮）：books.jsonl 读取失败（EISDIR）→ 降级空表，不裸抛', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'books-guard-'))
  try {
    mkdirSync(join(wd, '.clwriting', 'books.jsonl'), { recursive: true })
    expect(readBooks(wd)).toEqual([])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('低级项（第六轮）：active 读取失败（EISDIR）→ 降级 null（未选书），不裸抛', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'active-guard-'))
  try {
    mkdirSync(join(wd, '.clwriting', 'active'), { recursive: true })
    expect(readActive(wd)).toBeNull()
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

// Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位），该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('DA-3（第七轮）：books.jsonl 读失败（EACCES）→ appendBook 拒绝重写（不清掉其余登记）', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'books-strict-'))
  const fp = join(wd, '.clwriting', 'books.jsonl')
  try {
    mkdirSync(join(wd, '.clwriting'), { recursive: true })
    writeFileSync(fp, JSON.stringify({ name: '旧书', path: '旧书', kind: 'long' }) + '\n')
    chmodSync(fp, 0o000) // 挡读不挡 rename——正是清库窗口的触发形态
    const r = appendBook(wd, { name: '新书', path: '新书', kind: 'long' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('读取失败')
  } finally {
    chmodSync(fp, 0o644)
    expect(readFileSync(fp, 'utf-8')).toContain('旧书') // 原登记一字未动
    rmSync(wd, { recursive: true, force: true })
  }
})

// Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位），该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('DA-3（第七轮）：读失败 → readBooksStrict=null / readBooks=[]（读路径降级）、removeBookEntry 不清库', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'books-strict2-'))
  const fp = join(wd, '.clwriting', 'books.jsonl')
  try {
    mkdirSync(join(wd, '.clwriting'), { recursive: true })
    writeFileSync(fp, JSON.stringify({ name: '旧书', path: '旧书', kind: 'long' }) + '\n')
    chmodSync(fp, 0o000)
    expect(readBooksStrict(wd)).toBeNull()
    expect(readBooks(wd)).toEqual([]) // 读路径容错口径不变
    removeBookEntry(wd, '旧书') // no-op：不整写
  } finally {
    chmodSync(fp, 0o644)
    expect(readFileSync(fp, 'utf-8')).toContain('旧书') // 登记保留（repair 兜底可重建口径）
    rmSync(wd, { recursive: true, force: true })
  }
})

// Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位），该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('M-8（第八轮）：repairBooks 读失败（EACCES）→ 跳过本轮自愈，不整写清掉登记', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'repair-skip-'))
  const fp = join(wd, '.clwriting', 'books.jsonl')
  try {
    mkdirSync(join(wd, '.clwriting'), { recursive: true })
    // 非标准深度登记（三级路径）——扫盘只扫顶层+二级，整写即被清掉
    writeFileSync(fp, JSON.stringify({ name: '深层书', path: '分组/子库/深层书', kind: 'long' }) + '\n')
    chmodSync(fp, 0o000)
    const r = repairBooks(wd)
    expect(r.skipped).toBe('read-failed')
    expect(r.changed).toBe(false)
  } finally {
    chmodSync(fp, 0o644)
    expect(readFileSync(fp, 'utf-8')).toContain('深层书') // 登记一字未动
    rmSync(wd, { recursive: true, force: true })
  }
})
