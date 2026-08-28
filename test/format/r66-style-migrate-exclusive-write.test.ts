/**
 * R66-20（十四轮）：文风迁移写点 O_EXCL 排他回归。
 *
 * 迁移内部 makeWriter 此前用 writeEntry（atomic-rename 覆盖语义）——双进程同跑
 * 播种出同序号时后写静默互覆前写（丢条目无痕）。修复后走 writeEntryExclusive
 *（'wx' 排他建文件），EEXIST → 序号 +1 重试。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateStyleLibrary } from '../../src/format/style-migrate.js'
import { writeEntryExclusive, readEntry, ENTRIES_DIR } from '../../src/format/style-entry.js'
import { writeSample } from '../../src/format/style.js'
import type { StyleEntry } from '../../src/format/types.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-r66-20-'))
  mkdirSync(join(root, '文风'), { recursive: true })
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 建旧样章库 fixture（场景名原样进 fm 与目录名） */
function makeSample(scene: string, body: string): void {
  const dir = join(root, '文风', '样章库', scene)
  mkdirSync(dir, { recursive: true })
  writeSample(join(dir, `${scene}-001.md`), {
    场景: scene,
    来源: '作者原作',
    正文: body,
  })
}

/** readEntry 结果窄化：失败即抛（fixture 均为本文件自建，失败只可能是回归） */
function readBody(fp: string): string {
  const r = readEntry(fp, '样章')
  if (!r.ok) throw new Error(`readEntry 失败：${fp}`)
  return r.entry.正文
}

describe('R66-20: 迁移条目写入 O_EXCL 排他', () => {
  it('writeEntryExclusive：目标不存在 → 写入成功；已存在 → false 且不覆盖既有内容', () => {
    const dir = join(root, ENTRIES_DIR, '样章')
    mkdirSync(dir, { recursive: true })
    const fp = join(dir, '打斗-001.md')
    const first: StyleEntry = { 类型: '样章', 场景: '打斗', 来源: '作者标注', 正文: '第一条' }
    const second: StyleEntry = { 类型: '样章', 场景: '打斗', 来源: '作者标注', 正文: '第二条' }
    expect(writeEntryExclusive(fp, first)).toBe(true)
    expect(writeEntryExclusive(fp, second)).toBe(false) // EEXIST → false，不静默覆盖
    expect(readBody(fp)).toBe('第一条') // 先写内容原样保留
    // 产物与 writeEntry 同构：fm + 正文
    expect(readFileSync(fp, 'utf-8')).toContain('场景: 打斗')
  })

  // Windows 文件名禁 ':'——fixture「打斗:x」在 win 上建不出（mkdir EINVAL），撞名净化
  // 语义（':' → '_' 序号排他）由 macOS/Linux CI 腿覆盖
  it.skipIf(process.platform === 'win32')('同净化目标的两场景撞名 → 序号排他递增（两条都在盘，旧实现的互覆丢条不再发生）', () => {
    // '打斗:x' 与 '打斗_x' 经 sanitizeChapterTitle 净化后同名（':' → '_'）——
    // 播种按原始 key 分开计数，第二个写点必然撞上第一个的 打斗_x-001.md：
    // 旧 writeEntry 覆盖语义 → 第一条被第二条静默互覆；排他写 → 递增到 002 保双份
    makeSample('打斗:x', '第一条样章正文')
    makeSample('打斗_x', '第二条样章正文')

    const result = migrateStyleLibrary(root)
    expect(result.migrated).toBe(2)

    const entriesDir = join(root, ENTRIES_DIR, '样章')
    const names = readdirSync(entriesDir).sort()
    expect(names).toEqual(['打斗_x-001.md', '打斗_x-002.md']) // 撞名递增，无第三文件

    const bodies = names.map((n) => readBody(join(entriesDir, n)))
    expect(bodies).toContain('第一条样章正文') // 旧实现此处只剩第二条（第一条被互覆）
    expect(bodies).toContain('第二条样章正文')
  })

  it('既有条目不被迁移覆写（续跑播种语义不回退）', () => {
    // 预置已迁条目（含作者改过的正文）+ 旧源仍在 → 续跑只补新序号，不动既有文件
    const entriesDir = join(root, ENTRIES_DIR, '样章')
    mkdirSync(entriesDir, { recursive: true })
    const existing = join(entriesDir, '打斗-001.md')
    writeEntryExclusive(existing, { 类型: '样章', 场景: '打斗', 来源: '作者标注', 正文: '作者已改' })

    makeSample('打斗', '旧样章库里的正文')
    const result = migrateStyleLibrary(root)
    expect(result.migrated).toBe(1)
    const names = readdirSync(entriesDir).sort()
    expect(names).toEqual(['打斗-001.md', '打斗-002.md'])
    expect(readBody(existing)).toBe('作者已改')
  })
})
