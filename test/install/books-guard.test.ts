/**
 * 低级项（第六轮）数据层回归——readBooks / readActive 读失败守卫。
 * existsSync 通过但 readFileSync 失败（EACCES / EISDIR 等）原先裸抛，书架 /
 * resolveBookRoot 等读路径整链 500；现降级为空表 / null（与缺文件同口径）。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBooks, readActive, appendBook, removeBookEntry, removeBookEntryAsync, readBooksStrict, repairBooks, writeActive } from '../../src/install/books.js'
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

// ── R0912-3（重评-0912 P3 #33）：readBooksStrict 的 stat 失败分诊 ──
// 此前 stat 一切失败形态一律归空表（existsSync 吞错口径残留）——非 ENOENT（EACCES/
// EIO/ENOTDIR 等）也归空表，恰好绕过 DA-3 拒写防线（降级空表 × 后续整写清掉其余登记）。
// 修复后仅 ENOENT 归空表（首启语义），其余归 null 与 readFileSync 失败同走拒写。

// 装置 = .clwriting 是普通文件 → 子路径 stat ENOTDIR（非 ENOENT 的 stat 失败）；
// 不依赖 POSIX 权限位，跨平台腿全覆盖
test('R0912-3 #33: stat 非 ENOENT 失败（ENOTDIR）→ readBooksStrict=null（DA-3 拒写面），读路径容错口径不变', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'books-stat-'))
  try {
    writeFileSync(join(wd, '.clwriting'), 'not a dir')
    expect(readBooksStrict(wd)).toBeNull() // 修复前归 []：appendBook 以空表整写即清库
    expect(readBooks(wd)).toEqual([]) // 读路径容错（书架/resolveBook 不裸抛）口径不变
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('R0912-3 #33 对照: stat ENOENT（首启无 .clwriting）→ 空表语义不变（缺文件 = 新建合法，不拒写）', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'books-enoent-'))
  try {
    expect(readBooksStrict(wd)).toEqual([])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

// ── R0912-3（重评-0912 P3 #37）：removeBookEntry 双版写段 try/catch 对齐
// appendBookLocked 收编——写段失败不再裸抛。装置沿用 r0912-books-cache-isolate 的
// darwin `chflags uchg` 锁死 books.jsonl（读/锁成功、rename 落盘必 EPERM），精确命中
// 写段 catch；其余平台无精确只锁写不锁读的装置，按平台门跳过
test.skipIf(process.platform !== 'darwin')('R0912-3 #37: removeBookEntry/Async 写段失败 → 跳过留痕不抛，登记与 active 指针留盘', async () => {
  const wd = mkdtempTracked(join(tmpdir(), 'books-rmfail-'))
  const fp = join(wd, '.clwriting', 'books.jsonl')
  try {
    mkdirSync(join(wd, '.clwriting'))
    writeFileSync(fp, `${JSON.stringify({ name: '旧书', path: '旧书', kind: 'long' })}\n`)
    writeActive(wd, '旧书')
    execFileSync('chflags', ['uchg', fp])
    expect(() => removeBookEntry(wd, '旧书')).not.toThrow() // 修复前 EPERM 直穿
    await expect(removeBookEntryAsync(wd, '旧书')).resolves.toBeUndefined() // 异步孪生同口径
    expect(readFileSync(fp, 'utf-8')).toContain('旧书') // 登记留盘（幽灵条目由启动 repairBooks 报告）
    expect(readActive(wd)).toBe('旧书') // 指针不被清：写段失败即中止，不留「登记在、指针丢」半态
  } finally {
    try {
      execFileSync('chflags', ['nouchg', fp])
    } catch {
      /* 清理兜底 */
    }
    rmSync(wd, { recursive: true, force: true })
  }
})
