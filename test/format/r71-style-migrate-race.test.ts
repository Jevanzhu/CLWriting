/**
 * R71-21 回归：migrateStyleLibrary 四处读点的防竞态守卫（同库读取族低-3 口径）。
 *
 * 修复前 金句库 目录循环 / 金句库.md / 文风铁律.md 的裸 readFileSync 无守卫——
 * existsSync→read 间隙文件被删（ENOENT）或出现同名目录（EISDIR，readdir 按 .md
 * 结尾放行）时异常抛穿整次迁移。修复后按「无该输入」跳过（未成功读取的源不 rm，
 * 留给续跑）。同名目录法与间隙删除走同一 catch 降级分支，且跨平台可复现
 * （Windows 上对目录 readFileSync 同样抛错）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateStyleLibrary } from '../../src/format/style-migrate.js'
import { readEntries, ENTRIES_DIR } from '../../src/format/style-entry.js'
import { writeSample } from '../../src/format/style.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-style-migrate-r71-'))
  mkdirSync(join(root, '文风'), { recursive: true })
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

/** 建旧样章库 fixture（与 style-migrate.test.ts 同款） */
function makeSample(scene: string, seq: string, body: string): void {
  const dir = join(root, '文风', '样章库', scene)
  mkdirSync(dir, { recursive: true })
  writeSample(join(dir, `${scene}-${seq}.md`), { 场景: scene, 来源: '作者原作', 正文: body })
}

describe('R71-21：迁移读点防竞态（低-3 口径：单文件失败跳过不中断）', () => {
  it('金句库混入同名目录 → 迁移不抛、可完成；正常金句照迁、目录原样保留', () => {
    const quoteDir = join(root, '文风', '金句库')
    mkdirSync(quoteDir, { recursive: true })
    writeFileSync(join(quoteDir, '战斗.md'), '- 刀不问对错。\n', 'utf8')
    mkdirSync(join(quoteDir, '陷阱.md')) // 名以 .md 结尾的目录：readdir 放行、read 必炸
    // 修复前：裸 readFileSync 对目录 EISDIR 抛穿 migrateStyleLibrary
    const r = migrateStyleLibrary(root)
    expect(r.byKind['样章']).toBe(1) // 正常金句文件照迁
    expect(existsSync(join(quoteDir, '战斗.md'))).toBe(false) // 已迁已删
    expect(existsSync(join(quoteDir, '陷阱.md'))).toBe(true) // 目录不 rm、留给作者处置
  })

  it('金句库.md 本身是同名目录 → 迁移不抛；其他源（样章库）照迁、目录保留', () => {
    makeSample('战斗', '001', '刀光一闪。')
    mkdirSync(join(root, '文风', '金句库.md')) // existsSync 放行、read 必炸
    const r = migrateStyleLibrary(root)
    expect(r.byKind['样章']).toBe(1)
    const { entries } = readEntries(join(root, ENTRIES_DIR), '样章')
    expect(entries.some((e) => e.正文 === '刀光一闪。')).toBe(true)
    expect(existsSync(join(root, '文风', '金句库.md'))).toBe(true)
  })

  it('文风铁律.md 是同名目录 → 迁移不抛、可完成（空迁移建骨架、零禁词、目录保留）', () => {
    mkdirSync(join(root, '文风', '文风铁律.md'))
    // 修复前：rulesHasLegacy 的裸 readFileSync 第一个读点即 EISDIR 抛穿
    const r = migrateStyleLibrary(root)
    expect(r.migrated).toBe(0)
    expect(r.byKind['禁词']).toBeUndefined()
    expect(existsSync(join(root, ENTRIES_DIR))).toBe(true) // 空迁移仍建条目骨架
    expect(existsSync(join(root, '文风', '文风铁律.md'))).toBe(true)
  })

  it('守卫不破 happy path：正常金句目录 + 金句库.md 仍整源迁完删净', () => {
    const quoteDir = join(root, '文风', '金句库')
    mkdirSync(quoteDir, { recursive: true })
    writeFileSync(join(quoteDir, '战斗.md'), '- 血是热的。\n', 'utf8')
    writeFileSync(join(root, '文风', '金句库.md'), '# 金句库\n\n- 人这一生，总要选一次。\n', 'utf8')
    const r = migrateStyleLibrary(root)
    expect(r.byKind['样章']).toBe(2)
    expect(existsSync(quoteDir)).toBe(false)
    expect(existsSync(join(root, '文风', '金句库.md'))).toBe(false)
    const { entries } = readEntries(join(root, ENTRIES_DIR), '样章')
    expect(entries.map((e) => e.正文).sort()).toEqual(['人这一生，总要选一次。', '血是热的。'])
  })
})
