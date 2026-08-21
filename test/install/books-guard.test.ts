/**
 * 低级项（第六轮）数据层回归——readBooks / readActive 读失败守卫。
 * existsSync 通过但 readFileSync 失败（EACCES / EISDIR 等）原先裸抛，书架 /
 * resolveBookRoot 等读路径整链 500；现降级为空表 / null（与缺文件同口径）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBooks, readActive, appendBook, removeBookEntry, readBooksStrict } from '../../src/install/books.js'

test('低级项（第六轮）：books.jsonl 读取失败（EISDIR）→ 降级空表，不裸抛', () => {
  const wd = mkdtempSync(join(tmpdir(), 'books-guard-'))
  try {
    mkdirSync(join(wd, '.clwriting', 'books.jsonl'), { recursive: true })
    expect(readBooks(wd)).toEqual([])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('低级项（第六轮）：active 读取失败（EISDIR）→ 降级 null（未选书），不裸抛', () => {
  const wd = mkdtempSync(join(tmpdir(), 'active-guard-'))
  try {
    mkdirSync(join(wd, '.clwriting', 'active'), { recursive: true })
    expect(readActive(wd)).toBeNull()
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('DA-3（第七轮）：books.jsonl 读失败（EACCES）→ appendBook 拒绝重写（不清掉其余登记）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'books-strict-'))
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

test('DA-3（第七轮）：读失败 → readBooksStrict=null / readBooks=[]（读路径降级）、removeBookEntry 不清库', () => {
  const wd = mkdtempSync(join(tmpdir(), 'books-strict2-'))
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
