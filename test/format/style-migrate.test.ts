/**
 * 文风库迁移单测（文风系统重整 S1）。
 * 样章搬移 / 金句拆条 / 铁律提取+瘦身 / 幂等 / 词去重 / 空书。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  migrateStyleLibrary,
  parseQuoteEntries,
  parseAiFlavorRows,
} from '../../src/format/style-migrate.js'
import { readEntries, ENTRIES_DIR } from '../../src/format/style-entry.js'
import { writeSample } from '../../src/format/style.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-style-migrate-'))
  mkdirSync(join(root, '文风'), { recursive: true })
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 建旧样章库 fixture */
function makeSample(scene: string, seq: string, body: string, extra?: { 技法指令?: string; 标签?: string[] }): void {
  const dir = join(root, '文风', '样章库', scene)
  mkdirSync(dir, { recursive: true })
  writeSample(join(dir, `${scene}-${seq}.md`), {
    场景: scene,
    来源: '作者原作',
    出处: '《旧书》第 1 章',
    ...(extra?.技法指令 ? { 技法指令: extra.技法指令 } : {}),
    ...(extra?.标签 ? { 标签: extra.标签 } : {}),
    正文: body,
  })
}

const IRON_RULES = [
  '# 文风铁律',
  '',
  '## 反和解段（AI 味防御）',
  '',
  '- 「势不两立」',
  '- 「深吸一口气」',
  '',
  '## 可量化约束',
  '',
  '- 单句上限字数: 60',
  '',
  '## AI 味替换参考',
  '',
  '| AI 味表达 | 替换方向 |',
  '|---|---|',
  '| 深吸一口气 | 具体动作或删 |',
  '| 缓缓 / 微微 | 删，或给具体幅度 |',
  '',
  '## 删除上限分级',
  '',
  '- 轻度 ≤15%',
  '',
].join('\n')

describe('migrateStyleLibrary', () => {
  it('样章搬移：来源映射 + 技法指令→说明，旧库删净', () => {
    makeSample('战斗', '001', '刀光一闪。', { 技法指令: '短句制造压迫感' })
    makeSample('对话', '001', '「滚。」')
    const r = migrateStyleLibrary(root)
    expect(r.byKind['样章']).toBe(2)
    const { entries } = readEntries(join(root, ENTRIES_DIR), '样章')
    expect(entries).toHaveLength(2)
    const battle = entries.find((e) => e.场景 === '战斗')!
    expect(battle.来源).toBe('作者标注')
    expect(battle.说明).toBe('短句制造压迫感')
    expect(battle.出处).toBe('《旧书》第 1 章')
    expect(battle.正文).toBe('刀光一闪。')
    expect(existsSync(join(root, '文风', '样章库'))).toBe(false)
  })

  it('金句拆条：场景文件=收割、单文件=导入通用；都带金句标签，旧文件删除', () => {
    const quoteDir = join(root, '文风', '金句库')
    mkdirSync(quoteDir, { recursive: true })
    writeFileSync(quoteDir + '/战斗.md', '- 刀不问对错。  \n  ——第 3 章\n\n- 血是热的。  \n  ——第 7 章', 'utf-8')
    writeFileSync(join(root, '文风', '金句库.md'), '# 金句库\n\n- 人这一生，总要选一次。\n', 'utf-8')
    const r = migrateStyleLibrary(root)
    expect(r.byKind['样章']).toBe(3)
    const { entries } = readEntries(join(root, ENTRIES_DIR), '样章')
    const harvest = entries.filter((e) => e.来源 === '收割')
    expect(harvest).toHaveLength(2)
    expect(harvest[0]!.标签).toEqual(['金句'])
    expect(harvest[0]!.场景).toBe('战斗')
    expect(harvest.map((e) => e.出处)).toEqual(['第 3 章', '第 7 章'])
    const imported = entries.find((e) => e.来源 === '导入')!
    expect(imported.场景).toBe('通用')
    expect(imported.正文).toBe('人这一生，总要选一次。')
    expect(existsSync(join(root, '文风', '金句库'))).toBe(false)
    expect(existsSync(join(root, '文风', '金句库.md'))).toBe(false)
  })

  it('铁律提取：硬禁词无标签、AI 味带标签+说明、重合词去重；瘦身写回', () => {
    writeFileSync(join(root, '文风', '文风铁律.md'), IRON_RULES, 'utf-8')
    const r = migrateStyleLibrary(root)
    // 硬禁词 2（势不两立/深吸一口气）+ AI 味 1（缓缓 / 微微；深吸一口气重合跳过）
    expect(r.byKind['禁词']).toBe(3)
    const { entries } = readEntries(join(root, ENTRIES_DIR), '禁词')
    const hard = entries.find((e) => e.正文 === '深吸一口气')!
    expect(hard.标签).toBeUndefined()
    const soft = entries.find((e) => e.正文 === '缓缓 / 微微')!
    expect(soft.标签).toEqual(['AI味'])
    expect(soft.说明).toBe('删，或给具体幅度')
    // S5 瘦身写回：反和解段 + AI 味表删（知识归条目库），删除分级保留
    const slim = readFileSync(join(root, '文风', '文风铁律.md'), 'utf-8')
    expect(slim).not.toContain('反和解')
    expect(slim).not.toContain('AI 味替换')
    expect(slim).not.toContain('势不两立')
    expect(slim).toContain('删除上限分级')
    expect(slim).toContain('轻度 ≤15%')
    expect(r.details.some((d) => d.includes('瘦身'))).toBe(true)
  })

  it('幂等：第二次调用 no-op', () => {
    makeSample('战斗', '001', '正文')
    expect(migrateStyleLibrary(root).migrated).toBe(1)
    makeSample('战斗', '001', '再建一个旧样章')
    const second = migrateStyleLibrary(root)
    expect(second.migrated).toBe(0)
    expect(readEntries(join(root, ENTRIES_DIR)).entries).toHaveLength(1)
  })

  it('空文风目录：迁移零条但建骨架（幂等闸生效）', () => {
    const r = migrateStyleLibrary(root)
    expect(r.migrated).toBe(0)
    expect(existsSync(join(root, ENTRIES_DIR))).toBe(true)
  })

  it('无文风目录（异常书）：no-op 不建库', () => {
    rmSync(join(root, '文风'), { recursive: true, force: true })
    expect(migrateStyleLibrary(root).migrated).toBe(0)
    expect(existsSync(join(root, ENTRIES_DIR))).toBe(false)
  })
})

describe('解析纯函数', () => {
  it('parseQuoteEntries：learn 格式 + 多行续行 + 忽略标题', () => {
    const qs = parseQuoteEntries('# 标题\n\n- 第一句  \n  ——出处甲\n\n- 第二句\n跨行续写\n')
    expect(qs).toHaveLength(2)
    expect(qs[0]).toEqual({ 正文: '第一句', 出处: '出处甲' })
    expect(qs[1]!.正文).toBe('第二句\n跨行续写')
    expect(qs[1]!.出处).toBeUndefined()
  })

  it('parseAiFlavorRows：只取本段表格行，跳表头/分隔行', () => {
    const rows = parseAiFlavorRows(IRON_RULES)
    expect(rows).toEqual([
      { 词: '深吸一口气', 替换: '具体动作或删' },
      { 词: '缓缓 / 微微', 替换: '删，或给具体幅度' },
    ])
    expect(parseAiFlavorRows('# 无此段')).toEqual([])
  })
})
