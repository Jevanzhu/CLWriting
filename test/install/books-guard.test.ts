/**
 * 低级项（第六轮）数据层回归——readBooks / readActive 读失败守卫。
 * existsSync 通过但 readFileSync 失败（EACCES / EISDIR 等）原先裸抛，书架 /
 * resolveBookRoot 等读路径整链 500；现降级为空表 / null（与缺文件同口径）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBooks, readActive } from '../../src/install/books.js'

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
