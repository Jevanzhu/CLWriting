import { test, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead } from '../../src/cache/sync.js'
import { hasRed, getRedItems } from '../../src/check/runner.js'
// R66-14（十四轮）：formatReport（CLI 分级输出）随死代码清理删除——生产消费面已全部 API 化
import { formatRedForRewrite } from '../../src/check/report.js'
import { checkGrowth } from '../../src/check/growth.js'
import {
  checkFrontMatter,
  checkBannedWords,
  checkWordCount,
  checkRepeat,
  checkImagery,
  checkStyleMetrics,
  checkInfoLeak,
  computeStyleMetrics,
} from '../../src/check/count.js'
import { parseIronRules } from '../../src/format/iron-rules.js'
import { checkLeadsForm } from '../../src/check/leads.js'
import { parseLeadUpdateLines } from '../../src/check/lead-updates.js'
import { renderStyleRules } from '../../src/install/scaffold.js'
import type { ChapterMeta, RealmDoc } from '../../src/format/types.js'

// ── front matter 格式（#10 项 3，红）──────────────

test('checkFrontMatter: 章号与文件名一致 → 无红', () => {
  const ch: ChapterMeta = {
    章号: 152, 标题: '北境的雪', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '转折',
  }
  const r = checkFrontMatter(ch, '152-北境的雪.md')
  expect(r.items).toHaveLength(0)
})

test('checkFrontMatter: 章号与文件名不一致 → 红', () => {
  const ch: ChapterMeta = {
    章号: 153, 标题: '北境的雪', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '转折',
  }
  const r = checkFrontMatter(ch, '152-北境的雪.md')
  expect(r.items.some((i) => i.checkId === 'fm-chapter-mismatch')).toBe(true)
  expect(r.items[0]!.level).toBe('red')
})

// ── 禁词（#10 项 4，红）──────────────────────────

test('checkBannedWords: 命中禁词 → 红', () => {
  const r = checkBannedWords('他微笑着深情地说了句废话', ['废话', '深情地说'])
  expect(r.items).toHaveLength(2)
  expect(r.items.every((i) => i.level === 'red')).toBe(true)
})

test('parseIronRules: 反和解段解析为硬禁词', () => {
  const rules = parseIronRules([
    '## 反和解段（AI 味防御）',
    '- 禁止：轰动体、倒吸凉气、时间静止',
    '- 「蝼蚁」',
    '',
    '## 硬禁词清单',
    '- 禁词：不知死活的东西 / 天命所归',
    '- 「会让你们后悔」',
    '',
    '## 可量化约束',
    '- 单句上限字数: 60',
  ].join('\n'))
  expect(rules.bannedWords).toEqual(['轰动体', '倒吸凉气', '时间静止', '蝼蚁', '不知死活的东西', '天命所归', '会让你们后悔'])
})

// ── 字数（#10 项 5，黄）──────────────────────────

test('checkWordCount: 偏离目标 → 黄', () => {
  const r = checkWordCount(2000, 3000, 30) // 偏差 33% > 30%
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.level).toBe('yellow')
})

test('checkWordCount: 在容差内 → 无黄', () => {
  const r = checkWordCount(2900, 3000, 30)
  expect(r.items).toHaveLength(0)
})

// ── 复读（#10 项 6，黄）──────────────────────────

test('checkRepeat: 重复句多 → 黄', () => {
  // 句子需 ≥6 字才计入（checkRepeat 过滤短句）
  const body = '他大步流星地走了过去。他大步流星地走了过去。他大步流星地走了过去。她轻轻微微地笑了起来。她轻轻微微地笑了起来。这是一句正常的独独立立句子。'
  const r = checkRepeat(body, 0.15)
  expect(r.items.length).toBeGreaterThanOrEqual(1)
  expect(r.items[0]!.level).toBe('yellow')
})

// ── 成长线语义（#6，红）─────────────────────────

test('checkGrowth: 境界回退 → 红', () => {
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

  const realmDoc: RealmDoc = {
    体系: [{ 名称: '修真', 序列: ['炼气', '筑基', '金丹', '元婴'] }],
  }
  const r = checkGrowth(db, realmDoc, ['成长线-003'], 2)
  expect(r.items.some((i) => i.checkId === 'growth-regress')).toBe(true)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('checkGrowth: 正常跃迁不报红', () => {
  const dir = mkdtempTracked(join(tmpdir(), '北境-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  syncLead(db, {
    编号: '成长线-001', 标题: 'x', 类型: '成长线', 状态: '进行中', 开启章: 1,
    当前境界: '筑基',
    履历: [
      { 章号: 5, 动词: '起步', 证据: '炼气' },
      { 章号: 20, 动词: '突破', 证据: '突破至筑基' },
    ], _path: 'p',
  })
  const realmDoc: RealmDoc = { 体系: [{ 名称: '修真', 序列: ['炼气', '筑基', '金丹'] }] }
  const r = checkGrowth(db, realmDoc, ['成长线-001'], 2)
  expect(r.items).toHaveLength(0)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('checkGrowth: 成长线启用但境界序列缺失 → 红项阻断，不静默空跑', () => {
  const dir = mkdtempTracked(join(tmpdir(), '北境-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  syncLead(db, {
    编号: '成长线-001', 标题: '修为', 类型: '成长线', 状态: '进行中', 开启章: 1,
    当前境界: '炼气一层',
    履历: [{ 章号: 5, 动词: '突破', 证据: '突破至金丹' }], _path: 'p',
  })
  const r = checkGrowth(db, { 体系: [] }, ['成长线-001'], 2)
  expect(r.items.some((i) => i.checkId === 'growth-realm-sequence-missing' && i.level === 'red')).toBe(true)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('checkGrowth: 有境界体系但成长线缺当前境界 → 红项阻断，不静默跳过跃迁检测', () => {
  const dir = mkdtempTracked(join(tmpdir(), '北境-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  syncLead(db, {
    编号: '成长线-001', 标题: '修为', 类型: '成长线', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 5, 动词: '突破', 证据: '突破至筑基' }], _path: 'p',
  })
  const realmDoc: RealmDoc = { 体系: [{ 名称: '修真', 序列: ['炼气', '筑基', '金丹'] }] }
  const r = checkGrowth(db, realmDoc, ['成长线-001'], 2)
  expect(r.items.some((i) => i.checkId === 'growth-current-realm-missing' && i.level === 'red')).toBe(true)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('checkGrowth: 成长线非法履历动词 → 黄项告警', () => {
  const dir = mkdtempTracked(join(tmpdir(), '北境-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  syncLead(db, {
    编号: '成长线-001', 标题: '修为', 类型: '成长线', 状态: '进行中', 开启章: 1,
    当前境界: '炼气一层',
    履历: [{ 章号: 5, 动词: '乱升', 证据: '乱升至炼气四层' }], _path: 'p',
  })
  const realmDoc: RealmDoc = { 体系: [{ 名称: '修真', 序列: ['炼气一层', '炼气四层'] }] }
  const r = checkGrowth(db, realmDoc, ['成长线-001'], 2)
  expect(r.items.some((i) => i.checkId === 'growth-verb-invalid' && i.level === 'yellow')).toBe(true)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── 报告产出（#10 第 6 节）────────────────────────
// R66-14（十四轮）：formatReport（--brief/--full CLI 分级输出）两用例随死代码删除

test('formatRedForRewrite: 红项清单', () => {
  const report = {
    sections: [
      { name: '禁词', items: [
        { checkId: 'banned-word', level: 'red' as const, message: '命中「废话」' },
      ]},
    ],
  }
  expect(formatRedForRewrite(report)).toContain('命中「废话」')
  // 无红返回空
  expect(formatRedForRewrite({ sections: [] })).toBe('')
})

// ── hasRed（自愈打回判定）──────────────────────

test('hasRed + getRedItems', () => {
  const report = {
    sections: [
      { name: '禁词', items: [
        { checkId: 'banned-word', level: 'red' as const, message: 'x' },
        { checkId: 'repeat', level: 'yellow' as const, message: 'y' },
      ]},
    ],
  }
  expect(hasRed(report)).toBe(true)
  expect(getRedItems(report)).toHaveLength(1)
})

// ── 账本形式三检（#10 项 1，红）────────────────────

/** 造一个最小书仓库（含 .cache + 写作/正文/），供 checkLeadsForm 测试 */
function makeLeadsBook(): { root: string; db: DatabaseSync } {
  const root = mkdtempTracked(join(tmpdir(), '账本-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  return { root, db }
}

test('checkLeadsForm: 引文命中正文 → 无红', () => {
  const { root, db } = makeLeadsBook()
  writeFileSync(join(root, '写作', '正文', '12-灭门.md'), '---\n章号: 12\n---\n那道焦痕在烛火下泛着暗红。', 'utf-8')
  syncLead(db, {
    编号: '悬念-031', 标题: '灭门真凶', 类型: '悬念', 状态: '进行中', 开启章: 12,
    履历: [{ 章号: 12, 动词: '埋下', 证据: '那道焦痕在烛火下泛着暗红' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 12, ['悬念'])
  expect(r.items.filter((i) => i.level === 'red')).toHaveLength(0)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 假引文（正文未命中）→ 红', () => {
  const { root, db } = makeLeadsBook()
  writeFileSync(join(root, '写作', '正文', '12-灭门.md'), '---\n章号: 12\n---\n完全无关的正文内容。', 'utf-8')
  syncLead(db, {
    编号: '悬念-031', 标题: '灭门真凶', 类型: '悬念', 状态: '进行中', 开启章: 12,
    履历: [{ 章号: 12, 动词: '埋下', 证据: '那道焦痕在烛火下泛着暗红' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 12, ['悬念'])
  expect(r.items.some((i) => i.checkId === 'lead-evidence-miss')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

// Z-P2-12：同章多条证据共享章正文缓存——命中/未命中逐条独立判定，缓存不串判
test('checkLeadsForm: 同章多条证据（一命中一未命中）→ 恰一条 lead-evidence-miss', () => {
  const { root, db } = makeLeadsBook()
  writeFileSync(join(root, '写作', '正文', '12-灭门.md'), '---\n章号: 12\n---\n那道焦痕在烛火下泛着暗红。', 'utf-8')
  syncLead(db, {
    编号: '悬念-031', 标题: '灭门真凶', 类型: '悬念', 状态: '进行中', 开启章: 12,
    履历: [
      { 章号: 12, 动词: '埋下', 证据: '那道焦痕在烛火下泛着暗红' }, // 命中
      { 章号: 12, 动词: '推进', 证据: '不存在的句子' }, // 未命中（走同章缓存）
    ], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 12, ['悬念'])
  const misses = r.items.filter((i) => i.checkId === 'lead-evidence-miss')
  expect(misses).toHaveLength(1)
  expect(misses[0]!.message).toContain('不存在的句子')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

// NP0-A 回归：scaffold 默认建「写作/正文/第一卷/」卷子目录，findChapterFile 须递归扫描，
// 否则引文命中检查在默认布局下整体跳过（防吃书核心环节静默失效）。
test('checkLeadsForm: 卷子目录布局（第一卷/）下假引文仍被检出 → 红（NP0-A 回归）', () => {
  const { root, db } = makeLeadsBook()
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '12-灭门.md'), '---\n章号: 12\n---\n完全无关的正文内容。', 'utf-8')
  syncLead(db, {
    编号: '悬念-031', 标题: '灭门真凶', 类型: '悬念', 状态: '进行中', 开启章: 12,
    履历: [{ 章号: 12, 动词: '埋下', 证据: '那道焦痕在烛火下泛着暗红' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 12, ['悬念'])
  expect(r.items.some((i) => i.checkId === 'lead-evidence-miss')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 卷子目录布局下引文命中正文 → 无红', () => {
  const { root, db } = makeLeadsBook()
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '12-灭门.md'), '---\n章号: 12\n---\n那道焦痕在烛火下泛着暗红。', 'utf-8')
  syncLead(db, {
    编号: '悬念-031', 标题: '灭门真凶', 类型: '悬念', 状态: '进行中', 开启章: 12,
    履历: [{ 章号: 12, 动词: '埋下', 证据: '那道焦痕在烛火下泛着暗红' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 12, ['悬念'])
  expect(r.items.filter((i) => i.level === 'red')).toHaveLength(0)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 履历声称未来章 → 红', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '悬念-031', 标题: 'x', 类型: '悬念', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 99, 动词: '埋下', 证据: 'xx' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['悬念'])
  expect(r.items.some((i) => i.checkId === 'lead-chapter-future')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 履历章号乱序 → 红', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '悬念-031', 标题: 'x', 类型: '悬念', 状态: '进行中', 开启章: 1,
    履历: [
      { 章号: 20, 动词: '埋下', 证据: 'a' },
      { 章号: 10, 动词: '推进', 证据: 'b' }, // 乱序：10 < 20
    ], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 30, ['悬念'])
  expect(r.items.some((i) => i.checkId === 'lead-chapter-disorder')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 状态与末条动词不一致 → 红', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '悬念-031', 标题: 'x', 类型: '悬念', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 5, 动词: '揭晓', 证据: 'a' }], // 末条"揭晓"是悬念收尾，但状态仍"进行中"
    _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['悬念'])
  expect(r.items.some((i) => i.checkId === 'lead-status-open')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('RB-KN-P2-9: 反向漂移——状态已标终态但末条仍是推进动词 → 黄（lead-status-drift）', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '悬念-032', 标题: 'x', 类型: '悬念', 状态: '已收尾', 开启章: 1,
    履历: [{ 章号: 5, 动词: '递进', 证据: 'a' }], // 已标收尾但足迹仍在推进
    _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['悬念'])
  const drift = r.items.find((i) => i.checkId === 'lead-status-drift')
  expect(drift).toBeDefined()
  expect(drift!.level).toBe('yellow') // 提示不拦截（作者显式收口是合法场景）
  expect(drift!.message).toContain('悬念-032')
  // 正向红项不受影响（末条非收尾动词 → 无 lead-status-open）
  expect(r.items.some((i) => i.checkId === 'lead-status-open')).toBe(false)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('RB-KN-P2-9: 状态终态 + 末条收尾动词（一致）→ 无漂移项', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '悬念-033', 标题: 'x', 类型: '悬念', 状态: '已收尾', 开启章: 1,
    履历: [{ 章号: 5, 动词: '揭晓', 证据: 'a' }],
    _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['悬念'])
  expect(r.items.some((i) => i.checkId === 'lead-status-drift')).toBe(false)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 成长线 resolve 动词（突破/跃迁）末条 + 状态进行中 → 不报（阶段性升级合理）', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '成长线-001', 标题: 'x', 类型: '成长线', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 5, 动词: '跃迁', 证据: 'a' }], // 成长线跃迁是常态化升级，进行中合理
    _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['成长线'])
  expect(r.items.some((i) => i.checkId === 'lead-status-open')).toBe(false)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 成长线 resolve 末条 + 状态已放弃 → 不报（R73-29：突破后弃线是合法闭合）', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '成长线-002', 标题: 'x', 类型: '成长线', 状态: '已放弃', 开启章: 1,
    履历: [{ 章号: 5, 动词: '突破', 证据: 'a' }], // R73-29：resolve + 已放弃 = 先行收尾再弃线，不算矛盾
    _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['成长线'])
  expect(r.items.some((i) => i.checkId === 'lead-status-open')).toBe(false)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 成长线 advance 动词（稳进/实战）合法 → 无黄项', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '成长线-003', 标题: 'x', 类型: '成长线', 状态: '进行中', 开启章: 1,
    履历: [
      { 章号: 1, 动词: '起步', 证据: 'a' },
      { 章号: 2, 动词: '稳进', 证据: 'a' },
      { 章号: 3, 动词: '实战', 证据: 'a' },
    ],
    _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['成长线'])
  expect(r.items.some((i) => i.checkId === 'lead-status-open')).toBe(false)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 两端闭合——声明了没做 / 做了没声明', () => {
  const { root, db } = makeLeadsBook()
  writeFileSync(join(root, '写作', '正文', '10-x.md'), '---\n章号: 10\n---\n焦痕。', 'utf-8')
  syncLead(db, {
    编号: '悬念-031', 标题: 'x', 类型: '悬念', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 10, 动词: '推进', 证据: '焦痕' }], _path: 'p',
  })
  // declared = [悬念-001]（声明推进但没写），actual = [悬念-031]（写了没声明）
  const r = checkLeadsForm(db, root, 10, ['悬念'], ['悬念-001'], ['悬念-031'])
  expect(r.items.some((i) => i.checkId === 'lead-declared-not-done' && i.leadId === '悬念-001')).toBe(true)
  expect(r.items.some((i) => i.checkId === 'lead-done-not-declared' && i.leadId === '悬念-031')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 声明与实写一致 → 两端闭合无红', () => {
  const { root, db } = makeLeadsBook()
  writeFileSync(join(root, '写作', '正文', '10-x.md'), '---\n章号: 10\n---\n焦痕。', 'utf-8')
  syncLead(db, {
    编号: '悬念-031', 标题: 'x', 类型: '悬念', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 10, 动词: '推进', 证据: '焦痕' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['悬念'], ['悬念-031'], ['悬念-031'])
  expect(r.items.filter((i) => i.level === 'red')).toHaveLength(0)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

// ── 高频意象（#10 项 7，黄）────────────────────────

test('checkImagery: 词表命中超阈 → 黄；空表 → 静默跳过（X-P2-22，不再产未启用黄）', () => {
  // R26-29：阈值统一为「超过才报」（4 次 > 阈 3）；恰等阈不报见 R26-29 边界用例
  const body = '空气仿佛凝固。又一次空气仿佛凝固。还是空气仿佛凝固。再来一次空气仿佛凝固。'
  expect(checkImagery(body, ['空气仿佛凝固'], 3).items.some((i) => i.level === 'yellow')).toBe(true)
  expect(checkImagery(body, [], 3).items).toHaveLength(0)
})

// ── 文风可量化（#10 项 9，黄）──────────────────────

test('parseIronRules + checkStyleMetrics: 单句超长 / 对话提示语 → 黄', () => {
  const rules = parseIronRules('## 可量化硬约束\n- 单句上限字数: 20\n- 形容词连续堆叠上限: 3')
  expect(rules.maxSentenceLen).toBe(20)
  expect(rules.maxAdjStack).toBe(3)
  const body = '他微笑着深情地说了一句很长很长很长很长很长很长很长很长的话。'
  const r = checkStyleMetrics(body, rules)
  expect(r.items.some((i) => i.checkId === 'style-sentence-overlong')).toBe(true)
  expect(r.items.some((i) => i.checkId === 'style-dialogue-tag')).toBe(true)
})

test('G4: scaffold 文风铁律能激活机检（5 阈值全解析）+ S5 纯配置瘦身', () => {
  const iron = renderStyleRules('玄幻')
  // 机检激活：parseIronRules 从 scaffold 铁律解析出全部可量化阈值（修复「骨架阈值睡着」）
  const rules = parseIronRules(iron)
  expect(rules.maxSentenceLen).toBe(60)
  expect(rules.maxAdjStack).toBe(3)
  expect(rules.maxDialogueTagRatio).toBe(0.5)
  expect(rules.maxParallelStreak).toBe(3)
  expect(rules.avoidSummaryEnding).toBe(true)
  // S5 瘦身：纯配置双段（阈值 + 删除分级）；禁词知识归条目库，不再在铁律
  expect(iron).toContain('可量化约束')
  expect(iron).toContain('轻度 ≤15%')
  expect(iron).toContain('[需复核]')
  expect(iron).not.toContain('反和解段')
  expect(iron).not.toContain('AI 味替换参考')
})

test('parseIronRules + checkStyleMetrics: 去 AI 味扩展维度 → 黄', () => {
  const rules = parseIronRules([
    '对话标签占比: 50%',
    '排比连续数: 2',
    '结尾总结体: 禁止',
  ].join('\n'))
  expect(rules.maxDialogueTagRatio).toBe(0.5)
  expect(rules.maxParallelStreak).toBe(2)
  expect(rules.avoidSummaryEnding).toBe(true)

  const body = [
    '「你来了。」林晚说。',
    '「我来了。」萧策道。',
    '北风卷过长街。',
    '少年握紧刀柄。',
    '少年抬起眼。',
    '少年走进雪里。',
    '直到很久以后，他终于明白，原来这就是命运给他的答案。',
  ].join('\n')
  const r = checkStyleMetrics(body, rules)
  expect(r.items.some((i) => i.checkId === 'style-dialogue-tag-ratio')).toBe(true)
  expect(r.items.some((i) => i.checkId === 'style-parallel-streak')).toBe(true)
  expect(r.items.some((i) => i.checkId === 'style-summary-ending')).toBe(true)
})

test('checkStyleMetrics: 顿号分隔形容词堆叠 + 扩展总结体 → 黄', () => {
  const rules = parseIronRules([
    '形容词连续堆叠上限: 3',
    '结尾总结体: 禁止',
  ].join('\n'))
  const body = [
    '幽暗的、冰冷的、古老的、腐朽的气息从门缝里漫出来。',
    '这一战让沈砚终于明白，所谓修行的真谛从来不是退让。',
  ].join('\n')
  const r = checkStyleMetrics(body, rules)
  expect(r.items.some((i) => i.checkId === 'style-adj-stack')).toBe(true)
  expect(r.items.some((i) => i.checkId === 'style-summary-ending')).toBe(true)
})

test('AA-P3-6 金测: 结尾总结体——动作/画面收束不误报，真总结体不漏报', () => {
  const rules = parseIronRules('结尾总结体: 禁止')
  // 误报基线：动作/物件/画面收束（无触发+收束配对）→ 不报
  const sceneEnding = [
    '他松开手，刀锋贴着地面滑出一线火光。',
    '北风掀开帘子，把桌上的灯吹灭了。',
  ].join('\n')
  expect(checkStyleMetrics(sceneEnding, rules).items.some((i) => i.checkId === 'style-summary-ending')).toBe(false)
  // 漏报基线：真·总结体（触发词 + 收束词同段，跨行也命中）→ 报
  const summaryEnding = [
    '这一刻他终于明白，',
    '所谓命运，不过是自己给的答案。',
  ].join('\n')
  expect(checkStyleMetrics(summaryEnding, rules).items.some((i) => i.checkId === 'style-summary-ending')).toBe(true)
})

// ── 信息差候选（#10 项 11，黄）─────────────────────

test('checkInfoLeak: 关键词命中 → 候选（黄）；空源 → 静默跳过（X-P2-22，不再产未启用黄）', () => {
  expect(checkInfoLeak('他其实是皇子。', ['皇子']).items.some((i) => i.checkId === 'info-leak-candidate')).toBe(true)
  expect(checkInfoLeak('他其实是皇子。', []).items).toHaveLength(0)
})

test('checkGrowth: 跃迁证据提取不到境界名 → 黄 growth-evidence-no-realm（R62-2：修复前静默跳过，三项红检查对该条失明）', () => {
  const dir = mkdtempTracked(join(tmpdir(), '北境-'))
  try {
    const db = new DatabaseSync(join(dir, 'index.db'))
    createAllTables(db)
    syncLead(db, {
      编号: '成长线-004', 标题: 'x', 类型: '成长线', 状态: '进行中', 开启章: 1,
      当前境界: '筑基',
      履历: [
        { 章号: 5, 动词: '突破', 证据: '一举踏入新境' }, // 无序列内确切境界名
        { 章号: 20, 动词: '突破', 证据: '突破至筑基' },
      ], _path: 'p',
    })
    const realmDoc: RealmDoc = { 体系: [{ 名称: '修真', 序列: ['炼气', '筑基', '金丹'] }] }
    const r = checkGrowth(db, realmDoc, ['成长线-004'], 2)
    const noRealm = r.items.find((i) => i.checkId === 'growth-evidence-no-realm')
    expect(noRealm).toBeDefined()
    expect(noRealm!.level).toBe('yellow')
    expect(noRealm!.chapter).toBe(5)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// ── 二十六轮修复批 B 回归（R26-11/29/30/31/32/39）────────

// R26-11：对话标签占比提示语双侧边界锚定——剥引号后构词语素（知道/味道/道理/笑点）
// 不再误命中；「X说：」「XX喊道。」真提示语照常计入
test('R26-11: 对话标签边界锚定——构词语素不计入，提示语形态计入', () => {
  // 反例（修复前误计）：「“走吧。”他知道已经拦不住了。」剥引号后「道」无边界锚定
  const noTag = computeStyleMetrics('“走吧。”他知道已经拦不住了。', { maxDialogueTagRatio: 0.3 })
  expect(noTag._dialogueLines).toBe(1)
  expect(noTag.dialogueTagRatio).toBe(0)
  // 语素词「味道」同判（引号行承载，叙述语素不算标签）
  const flavor = computeStyleMetrics('“嗯。”汤的味道淡了。', { maxDialogueTagRatio: 0.3 })
  expect(flavor.dialogueTagRatio).toBe(0)
  // 正例：「他说：」提示语应计入（修复前裸字面也计，此处锁锚定后不回归）
  const withColon = computeStyleMetrics('他说：“走吧。”', { maxDialogueTagRatio: 0.3 })
  expect(withColon.dialogueTagRatio).toBe(1)
  const withShout = computeStyleMetrics('“走吧。”林晚喊道。', { maxDialogueTagRatio: 0.3 })
  expect(withShout.dialogueTagRatio).toBe(1)
})

// R26-29：高频意象阈值边界统一为 `>`（超过才报）——与身体部位/比喻两项同口径
test('R26-29: 高频意象恰等阈不报、超阈才报（阈值边界统一）', () => {
  expect(checkImagery('焦痕焦痕焦痕', ['焦痕'], 3).items).toHaveLength(0) // 3 = 阈 → 不报
  const over = checkImagery('焦痕'.repeat(4), ['焦痕'], 3)
  expect(over.items).toHaveLength(1)
  expect(over.items[0]!.message).toContain('>3') // 文案同步 ≥ → >
})

// R26-39：占比解析认全角％与省整数位小数（.5）
test('R26-39: 对话标签占比阈值认 50％ / .5（归一后解析）', () => {
  expect(parseIronRules('对话标签占比: 50％').maxDialogueTagRatio).toBe(0.5)
  expect(parseIronRules('对话标签占比: .5').maxDialogueTagRatio).toBe(0.5)
  expect(parseIronRules('对话标签占比: .5%').maxDialogueTagRatio).toBe(0.005)
  expect(parseIronRules('对话标签占比: 50%').maxDialogueTagRatio).toBe(0.5) // 既有语义不回归
})

// R26-30：引文 grep 面改剥 fm 的 body——证据只落在 front matter 时不再误判命中
test('R26-30: 证据只存在于 front matter → lead-evidence-miss（全文 grep 误判不再）', () => {
  const { root, db } = makeLeadsBook()
  // 证据句只写在 fm 标题行；正文完全无关——修复前全文 grep 命中、红闸对该条失明
  writeFileSync(
    join(root, '写作', '正文', '12-灭门.md'),
    '---\n章号: 12\n标题: 那道焦痕在烛火下泛着暗红\n---\n完全无关的正文内容。',
    'utf-8',
  )
  syncLead(db, {
    编号: '悬念-031', 标题: '灭门真凶', 类型: '悬念', 状态: '进行中', 开启章: 12,
    履历: [{ 章号: 12, 动词: '埋下', 证据: '那道焦痕在烛火下泛着暗红' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 12, ['悬念'])
  expect(r.items.some((i) => i.checkId === 'lead-evidence-miss')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

// R26-31：履历末条词表外动词黄项提示（对齐 growth-verb-invalid，仅提示不判红）
test('R26-31: 词表外末条动词 → lead-verb-invalid 黄项；合法动词不产黄', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '悬念-001', 标题: 'x', 类型: '悬念', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 1, 动词: '乱写', 证据: '证据句' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 1, ['悬念'])
  const bad = r.items.find((i) => i.checkId === 'lead-verb-invalid')
  expect(bad).toBeDefined()
  expect(bad!.level).toBe('yellow')
  expect(bad!.message).toContain('乱写')
  // 对照：合法动词（埋下=悬念.open）不产词表外黄项
  const { root: root2, db: db2 } = makeLeadsBook()
  syncLead(db2, {
    编号: '悬念-002', 标题: 'x', 类型: '悬念', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 1, 动词: '设下', 证据: '证据句' }], _path: 'p', // 设下 = 悬念.open（表内动词）
  })
  const ok = checkLeadsForm(db2, root2, 1, ['悬念'])
  expect(ok.items.some((i) => i.checkId === 'lead-verb-invalid')).toBe(false)
  db.close()
  db2.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(root2, { recursive: true, force: true })
})

// R26-32：账本推进格式不符行 warn 留痕（此前静默丢弃）
test('R26-32: 账本推进格式不符行 warn；合法行照常解析', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const out = parseLeadUpdateLines('- 悬念-001 推进：密室尽头的青铜灯亮了\n- 这行缺冒号结构')
    expect(out).toHaveLength(1)
    expect(out[0]!.leadId).toBe('悬念-001')
    expect(out[0]!.证据).toBe('密室尽头的青铜灯亮了')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('格式不符'))).toBe(true)
  } finally {
    warnSpy.mockRestore()
  }
})

// R28-10（二十八轮）：R26-32 warn 收窄——`---` 分隔线与嵌套子列表行（真条目的子项）
// 恢复静默跳过（不告警、不折入证据），顶层真条目格式错仍留痕
test('R28-10: 分隔线与嵌套子项静默，顶层格式错行仍 warn', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    // 真条目格式错（顶层缺「编号 动词：证据」结构）仍告警
    parseLeadUpdateLines('- 这行缺冒号结构')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('格式不符'))).toBe(true)
    // `---` 分隔线静默（不告警、不折入上一条证据）
    warnSpy.mockClear()
    const out1 = parseLeadUpdateLines('- 悬念-001 埋下：焦痕\n---\n- 设定线-001 树立：九品灵气')
    expect(out1).toHaveLength(2)
    expect(out1[0]!.证据).toBe('焦痕')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('格式不符'))).toBe(false)
    // 嵌套子列表行（缩进子项）静默（不告警、不折入、不产条目）
    warnSpy.mockClear()
    const out2 = parseLeadUpdateLines('- 悬念-001 埋下：焦痕\n  - 子项备注一行')
    expect(out2).toEqual([{ leadId: '悬念-001', 动词: '埋下', 证据: '焦痕' }])
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('格式不符'))).toBe(false)
  } finally {
    warnSpy.mockRestore()
  }
})
