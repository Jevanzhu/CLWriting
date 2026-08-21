/**
 * 低级项（第六轮）数据层回归——doInit 半成品目录卡死重试。
 * 上次 init 在 scaffold 与登记之间崩掉：目录有骨架但 books.jsonl 未登记，重试原被
 * 「目录已存在且非空」卡死（只能手工清目录）。现按「未登记 + 有 book.yaml 骨架签名 +
 * 写作/正文 零 .md（无用户内容可损失）」判半成品，复跑幂等 scaffold 续走登记；
 * 其余目录占用场景的拒绝口径不变。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doInit } from '../../src/install/init.js'
import { readBooks, readActive } from '../../src/install/books.js'

test('低级项（第六轮）：上次 init 半途崩出的半成品（未登记 + 骨架 + 正文空）→ 重试完成建书', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-half-'))
  try {
    // 模拟崩在 scaffold 中途：book.yaml 已写、其余骨架未建、登记未落
    const bookRoot = join(wd, '长篇', '北境')
    mkdirSync(bookRoot, { recursive: true })
    writeFileSync(join(bookRoot, 'book.yaml'), 'book:\n  title: 北境\n', 'utf-8')

    const r = doInit({ workDir: wd, name: '北境' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 幂等 scaffold 补齐骨架（正文卷目录、登记、活动书指针）
    expect(existsSync(join(r.bookRoot, '写作', '正文', '第一卷'))).toBe(true)
    expect(readBooks(wd).some((b) => b.name === '北境')).toBe(true)
    expect(readActive(wd)).toBe('北境')
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('低级项（第六轮）：目录存在且正文已有 .md（非半成品）→ 仍拒绝覆盖，用户内容不动', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-user-'))
  try {
    const bookRoot = join(wd, '长篇', '北境')
    mkdirSync(join(bookRoot, '写作', '正文', '第一卷'), { recursive: true })
    writeFileSync(join(bookRoot, '写作', '正文', '第一卷', '0001-手写.md'), '用户内容', 'utf-8')
    // 即便有 book.yaml 骨架签名，正文有文件 = 有用户内容可损失 → 不判半成品
    writeFileSync(join(bookRoot, 'book.yaml'), 'book:\n  title: 北境\n', 'utf-8')

    const r = doInit({ workDir: wd, name: '北境' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('已存在且非空')
    expect(readFileSync(join(bookRoot, '写作', '正文', '第一卷', '0001-手写.md'), 'utf-8')).toBe('用户内容')
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('低级项（第六轮）：已登记但目录被删 → 重试报「已有一本」，冲突口径不变', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-reg-'))
  try {
    const r0 = doInit({ workDir: wd, name: '北境' })
    expect(r0.ok).toBe(true)
    // 模拟登记在册但书目录被外部删除
    rmSync(join(wd, '长篇', '北境'), { recursive: true, force: true })
    const r = doInit({ workDir: wd, name: '北境' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('已有一本')
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('P5-数据层（第七轮）：同名文件占位（非目录）→ ok:false 给可读原因（原 statSync ENOTDIR 直接抛）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'clw-init-file-'))
  mkdirSync(join(wd, '长篇'), { recursive: true })
  writeFileSync(join(wd, '长篇', '北境'), '一个同名普通文件', 'utf-8')
  try {
    const r = doInit({ workDir: wd, name: '北境' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('同名文件')
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})
