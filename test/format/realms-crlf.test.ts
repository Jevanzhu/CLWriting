/**
 * R36-3（三十六轮）回归：CRLF front matter 的境界体系解析 + 成长线判级。
 *
 * 修复背景：parseRealmSystems 名称/序列两处正则对**未 trim 原始行** `$` 锚定匹配且无
 * m 标志，`\r` 前不认行尾 → CRLF 境界体系段整体解析为空（systems=[]）→ 成长线境界
 * 跳跃/回退红闸整体失效 + settings-context 注入失明。修复：与 R36-1 同口径做 `\r`
 * 行尾归一。另兜底红项文案改为如实描述（文件可能明明有内容，如换行格式异常）。
 */
import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRealmSystems } from '../../src/format/frontmatter.js'
import { readRealmDoc } from '../../src/format/realms.js'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead } from '../../src/cache/sync.js'
import { checkGrowth } from '../../src/check/growth.js'

/** LF 文本 → CRLF 文本 */
function toCrlf(text: string): string {
  return text.split('\n').join('\r\n')
}

// ── parseRealmSystems：CRLF 名称/序列行解析 ───────

test('R36-3: CRLF front matter 的两套境界体系（名称+序列）完整解析', () => {
  const fmRaw = toCrlf([
    '体系:',
    '  - 名称: 修真境界',
    '    序列: [炼气, 筑基, 金丹]',
    '  - 名称: 武者等级',
    '    序列: [后天, 先天]',
    '',
  ].join('\n'))
  const systems = parseRealmSystems(fmRaw)
  expect(systems).toHaveLength(2)
  expect(systems[0]).toEqual({ 名称: '修真境界', 序列: ['炼气', '筑基', '金丹'] })
  expect(systems[1]).toEqual({ 名称: '武者等级', 序列: ['后天', '先天'] })
})

test('R36-3: CRLF 与 LF 的边界体系解析结果逐位一致（归一不改变 LF 语义）', () => {
  const fmRawLf = [
    '体系:',
    '  - 名称: 修真境界',
    '    序列: [炼气, 筑基, 金丹]',
    '  - 名称: 武者等级',
    '    序列: [后天, 先天]',
  ].join('\n')
  expect(parseRealmSystems(toCrlf(fmRawLf))).toEqual(parseRealmSystems(fmRawLf))
})

// ── readRealmDoc：真实 CRLF 境界体系.md 文件 ──────

test('R36-3: 真实 CRLF 设定/境界体系.md 读出完整 RealmDoc', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'r36-realms-crlf-'))
  const fp = join(dir, '境界体系.md')
  writeFileSync(
    fp,
    toCrlf([
      '---',
      '体系:',
      '  - 名称: 修真境界',
      '    序列: [炼气, 筑基, 金丹]',
      '---',
      '修真说明。',
      '',
    ].join('\n')),
    'utf-8',
  )
  try {
    const r = readRealmDoc(fp)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.体系).toHaveLength(1)
    expect(r.doc.体系[0]!.序列).toEqual(['炼气', '筑基', '金丹'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 成长线判级：CRLF 境界体系下红闸真的生效 ───────

test('R36-3: CRLF 境界体系下成长线回退红项照常触发（判级不再失效）', () => {
  const dir = mkdtempTracked(join(tmpdir(), '北境-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  syncLead(db, {
    编号: '成长线-003', 标题: '修为', 类型: '成长线', 状态: '进行中', 开启章: 1,
    当前境界: '金丹',
    履历: [
      { 章号: 10, 动词: '突破', 证据: '突破至筑基' },
      { 章号: 20, 动词: '突破', 证据: '突破至金丹' },
      { 章号: 30, 动词: '突破', 证据: '跌落至炼气' }, // 回退
    ], _path: 'p',
  })
  const realmDoc = {
    体系: [
      { 名称: '修真境界', 序列: ['炼气', '筑基', '金丹', '元婴'] },
    ],
    正文: '说明',
  }
  const r = checkGrowth(db, realmDoc, ['成长线-003'], 2)
  // 修复前（systems=[] → sequence null）：realm-miss/regress/span-exceed 全部静默跳过，
  // 只剩「体系缺失」红项——回退这一真红项检测整体失明
  expect(r.items.some((i) => i.checkId === 'growth-regress')).toBe(true)
  expect(r.items.every((i) => i.checkId !== 'growth-realm-sequence-missing')).toBe(true)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('R36-3: 正常跃迁在 CRLF 来源下不误红，体系缺失兜底不为空', () => {
  const dir = mkdtempTracked(join(tmpdir(), '北境-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  syncLead(db, {
    编号: '成长线-001', 标题: 'x', 类型: '成长线', 状态: '进行中', 开启章: 1,
    当前境界: '筑基',
    履历: [
      { 章号: 5, 动词: '起步', 证据: '炼气' },
      { 章号: 10, 动词: '突破', 证据: '突破至筑基' },
    ], _path: 'p',
  })
  const realmDoc = { 体系: [{ 名称: '修真境界', 序列: ['炼气', '筑基', '金丹'] }] }
  const r = checkGrowth(db, realmDoc, ['成长线-001'], 2)
  expect(r.items).toHaveLength(0)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── 兜底红项文案（如实描述，不再说「没有可解析的 front matter」）─────

test('R36-3: 体系解析失败兜底红项文案如实描述（内容或换行格式异常）', () => {
  const dir = mkdtempTracked(join(tmpdir(), '北境-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  syncLead(db, {
    编号: '成长线-001', 标题: 'x', 类型: '成长线', 状态: '进行中', 开启章: 1,
    当前境界: '炼气',
    履历: [{ 章号: 5, 动词: '突破', 证据: '突破至筑基' }], _path: 'p',
  })
  const r = checkGrowth(db, { 体系: [] }, ['成长线-001'], 2)
  const item = r.items.find((i) => i.checkId === 'growth-realm-sequence-missing')
  expect(item).toBeDefined()
  // 信号语义：境界体系缺失 = 序列不可用 → 红闸整体失效，维持 red（fail-closed）
  expect(item!.level).toBe('red')
  // 文案如实描述：文件可能明明有内容（换行格式异常），旧文案误导排障
  expect(item!.message).toContain('未解析出有效的境界体系')
  expect(item!.message).toContain('换行格式异常')
  expect(item!.message).not.toContain('没有可解析的 front matter')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})