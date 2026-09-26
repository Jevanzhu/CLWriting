/**
 * R59 清偿批（R57-D-4）回归：nextEntrySeq existsSync→readdirSync TOCTOU 守卫。
 *
 * 原实现：existsSync(dir) 通过后裸 readdirSync(dir)——间隙目录被瞬删/换名（TOCTOU）
 * 时 ENOENT/ENOTDIR 裸抛炸 addEntry 入库链。同文件 entriesDirSignature /
 * readEntriesUncached 两处同形态 readdirSync 均有 try/catch 守卫（目录消失按空处理），
 * 唯此处漏防。修复后补同款守卫：读目录失败按空目录降级（序号从 1 起算；落盘真竞态
 * 由 addEntry 的 O_EXCL EEXIST 重试兜底），fail-loud 不再炸穿。
 *
 * 竞态等价造法（库内先例 r50-f2-check-packaging-readdir 同款）：类型目录路径实为
 * 同名文件——existsSync 为真而 readdirSync 抛 ENOTDIR。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextEntrySeq, addEntry, ENTRIES_DIR } from '../../src/format/style-entry.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let root = ''

beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clwriting-r59-entry-seq-'))
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('R57-D-4: nextEntrySeq TOCTOU 守卫', () => {
  it('类型目录实为同名文件（ENOTDIR 竞态等价造法）→ 按空目录降级返回 1，不抛', () => {
    mkdirSync(join(root, ENTRIES_DIR), { recursive: true })
    writeFileSync(join(root, ENTRIES_DIR, '样章'), '不是目录', 'utf-8')
    expect(() => nextEntrySeq(join(root, ENTRIES_DIR), '样章', '战斗')).not.toThrow()
    expect(nextEntrySeq(join(root, ENTRIES_DIR), '样章', '战斗')).toBe(1)
  })

  it('正常目录序号扫描不受守卫影响（既有 2 条 → 3）', () => {
    addEntry(root, { 类型: '样章', 场景: '战斗', 来源: '作者标注', 正文: 'A' })
    addEntry(root, { 类型: '样章', 场景: '战斗', 来源: '作者标注', 正文: 'B' })
    expect(nextEntrySeq(join(root, ENTRIES_DIR), '样章', '战斗')).toBe(3)
  })
})
