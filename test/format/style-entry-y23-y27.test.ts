/**
 * Y-7 / Y-23 / Y-27（第五十七轮）回归——条目库三件。
 *
 * Y-7：style-migrate 样章/金句续跑查重（对齐禁词源 RB-KN-P2-4）——上次「写条目 →
 * rmSync 旧源」之间崩溃后，续跑不得产出同内容双份。
 * Y-23：readBannedEntryWords 多行正文逐行拆词（整段当一个词永不命中）。
 * Y-27：addEntry 场景字段走 sanitizeChapterTitle（超长场景 ENAMETOOLONG 防护）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateStyleLibrary } from '../../src/format/style-migrate.js'
import { readBannedEntryWords, addEntry, ENTRIES_DIR } from '../../src/format/style-entry.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-y7-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeSampleSource(): void {
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true })
  writeFileSync(join(root, '文风', '样章库', '战斗', 's1.md'), '---\n场景: 战斗\n---\n刀光起落。')
}

describe('Y-7: 样章迁移续跑查重', () => {
  it('条目已在（上次写成功崩溃残留）→ 续跑不双写，旧源删除', () => {
    makeSampleSource()
    // 第一次迁移：条目写成功（模拟 rmSync 前崩溃——手工恢复旧源再跑）
    const r1 = migrateStyleLibrary(root)
    expect(r1.byKind['样章']).toBeGreaterThanOrEqual(1)
    const entriesDir = join(root, ENTRIES_DIR, '样章')
    const after1 = readdirSync(entriesDir).length
    // 模拟崩溃残留：旧源重现（真实形态是 rmSync 未执行；此处重建等价）
    makeSampleSource()
    writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n\n可量化约束保留段。\n')
    const r2 = migrateStyleLibrary(root)
    // 修复前：同内容样章被再写一份（after1 + 1）；修复后：命中 seen 跳写
    expect(readdirSync(entriesDir).length).toBe(after1)
    expect(r2.migrated).toBe(0)
    expect(existsSync(join(root, '文风', '样章库', '战斗', 's1.md'))).toBe(false)
  })
})

describe('Y-23: readBannedEntryWords 多行正文拆词', () => {
  it('多行说明性正文的禁词条目按行生效', () => {
    mkdirSync(join(root, ENTRIES_DIR, '禁词'), { recursive: true })
    writeFileSync(
      join(root, ENTRIES_DIR, '禁词', 'a.md'),
      '---\n类型: 禁词\n场景: 通用\n---\n仿佛命运\n无处不在\n',
    )
    const words = readBannedEntryWords(root)
    expect(words).toContain('仿佛命运')
    expect(words).toContain('无处不在')
    // 整段（旧行为）不再是返回项
    expect(words).not.toContain('仿佛命运\n无处不在')
  })
})

describe('Y-27: addEntry 场景净化', () => {
  it('超长场景名被码位/字节双封顶，不再 ENAMETOOLONG', () => {
    const longScene = '战'.repeat(200)
    const rel = addEntry(root, { 类型: '禁词', 场景: longScene, 来源: '作者标注', 正文: '词' })
    expect(rel.length).toBeLessThan(200)
    expect(existsSync(join(root, rel))).toBe(true)
  })

  it('含路径分隔符的场景仍被替换（既有防护保持）', () => {
    const rel = addEntry(root, { 类型: '禁词', 场景: '战斗/高级', 来源: '作者标注', 正文: '词' })
    expect(rel).not.toContain('战斗/高级')
    expect(existsSync(join(root, rel))).toBe(true)
  })
})
