import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead, syncChapter } from '../../src/cache/sync.js'
import { runAllChecks, hasRed, getRedItems } from '../../src/check/runner.js'
import { formatReport, formatRedForRewrite } from '../../src/check/report.js'
import { checkGrowth } from '../../src/check/growth.js'
import {
  checkFrontMatter,
  checkBannedWords,
  checkWordCount,
  checkRepeat,
  checkImagery,
  checkStyleMetrics,
  checkInfoLeak,
  parseIronRules,
} from '../../src/check/count.js'
import { checkLeadsForm } from '../../src/check/leads.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { ChapterMeta, BookConfig, RealmDoc } from '../../src/format/types.js'

function makeFixture(): { root: string; db: DatabaseSync } {
  const root = mkdtempSync(join(tmpdir(), '北境往事-'))
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  mkdirSync(join(root, '.cache'), { recursive: true })
  // 注意：db 路径需在 .cache 下，重建上面这行
  return { root, db: new DatabaseSync(join(root, '.cache', 'index.db')) }
}

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
  const dir = mkdtempSync(join(tmpdir(), '北境-'))
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
  const dir = mkdtempSync(join(tmpdir(), '北境-'))
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

// ── 报告分级（#10 第 7 节）────────────────────────

test('formatReport: brief 模式红项逐条 + 黄项计数', () => {
  const report = {
    sections: [
      { name: '禁词', items: [
        { checkId: 'banned-word', level: 'red' as const, message: '命中「废话」' },
      ]},
      { name: '复读', items: [
        { checkId: 'repeat', level: 'yellow' as const, message: '复读3处' },
        { checkId: 'repeat', level: 'yellow' as const, message: '复读2处' },
      ]},
    ],
  }
  const brief = formatReport(report, 'brief')
  expect(brief).toContain('红项 1 条')
  expect(brief).toContain('命中「废话」')
  expect(brief).toContain('复读 2 处') // 黄项分类计数
  expect(brief).not.toContain('复读3处') // brief 不出黄项明细
})

test('formatReport: full 模式出全明细', () => {
  const report = {
    sections: [
      { name: '复读', items: [
        { checkId: 'repeat', level: 'yellow' as const, message: '复读3处' },
      ]},
    ],
  }
  const full = formatReport(report, 'full')
  expect(full).toContain('复读3处')
})

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

/** 造一个最小书仓库（含 .cache + 定稿/正文/），供 checkLeadsForm 测试 */
function makeLeadsBook(): { root: string; db: DatabaseSync } {
  const root = mkdtempSync(join(tmpdir(), '账本-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  return { root, db }
}

test('checkLeadsForm: 引文命中正文 → 无红', () => {
  const { root, db } = makeLeadsBook()
  writeFileSync(join(root, '定稿', '正文', '12-灭门.md'), '---\n章号: 12\n---\n那道焦痕在烛火下泛着暗红。', 'utf-8')
  syncLead(db, {
    编号: '伏笔-031', 标题: '灭门真凶', 类型: '伏笔', 状态: '进行中', 开启章: 12,
    履历: [{ 章号: 12, 动词: '埋下', 证据: '那道焦痕在烛火下泛着暗红' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 12, ['伏笔'])
  expect(r.items.filter((i) => i.level === 'red')).toHaveLength(0)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 假引文（正文未命中）→ 红', () => {
  const { root, db } = makeLeadsBook()
  writeFileSync(join(root, '定稿', '正文', '12-灭门.md'), '---\n章号: 12\n---\n完全无关的正文内容。', 'utf-8')
  syncLead(db, {
    编号: '伏笔-031', 标题: '灭门真凶', 类型: '伏笔', 状态: '进行中', 开启章: 12,
    履历: [{ 章号: 12, 动词: '埋下', 证据: '那道焦痕在烛火下泛着暗红' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 12, ['伏笔'])
  expect(r.items.some((i) => i.checkId === 'lead-evidence-miss')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 履历声称未来章 → 红', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '伏笔-031', 标题: 'x', 类型: '伏笔', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 99, 动词: '埋下', 证据: 'xx' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['伏笔'])
  expect(r.items.some((i) => i.checkId === 'lead-chapter-future')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 履历章号乱序 → 红', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '伏笔-031', 标题: 'x', 类型: '伏笔', 状态: '进行中', 开启章: 1,
    履历: [
      { 章号: 20, 动词: '埋下', 证据: 'a' },
      { 章号: 10, 动词: '推进', 证据: 'b' }, // 乱序：10 < 20
    ], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 30, ['伏笔'])
  expect(r.items.some((i) => i.checkId === 'lead-chapter-disorder')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 状态与末条动词不一致 → 红', () => {
  const { root, db } = makeLeadsBook()
  syncLead(db, {
    编号: '伏笔-031', 标题: 'x', 类型: '伏笔', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 5, 动词: '回收', 证据: 'a' }], // 末条"回收"是收尾，但状态仍"进行中"
    _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['伏笔'])
  expect(r.items.some((i) => i.checkId === 'lead-status-open')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 两端闭合——声明了没做 / 做了没声明', () => {
  const { root, db } = makeLeadsBook()
  writeFileSync(join(root, '定稿', '正文', '10-x.md'), '---\n章号: 10\n---\n焦痕。', 'utf-8')
  syncLead(db, {
    编号: '伏笔-031', 标题: 'x', 类型: '伏笔', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 10, 动词: '推进', 证据: '焦痕' }], _path: 'p',
  })
  // declared = [悬念-001]（声明推进但没写），actual = [伏笔-031]（写了没声明）
  const r = checkLeadsForm(db, root, 10, ['伏笔', '悬念'], ['悬念-001'], ['伏笔-031'])
  expect(r.items.some((i) => i.checkId === 'lead-declared-not-done' && i.leadId === '悬念-001')).toBe(true)
  expect(r.items.some((i) => i.checkId === 'lead-done-not-declared' && i.leadId === '伏笔-031')).toBe(true)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('checkLeadsForm: 声明与实写一致 → 两端闭合无红', () => {
  const { root, db } = makeLeadsBook()
  writeFileSync(join(root, '定稿', '正文', '10-x.md'), '---\n章号: 10\n---\n焦痕。', 'utf-8')
  syncLead(db, {
    编号: '伏笔-031', 标题: 'x', 类型: '伏笔', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 10, 动词: '推进', 证据: '焦痕' }], _path: 'p',
  })
  const r = checkLeadsForm(db, root, 10, ['伏笔'], ['伏笔-031'], ['伏笔-031'])
  expect(r.items.filter((i) => i.level === 'red')).toHaveLength(0)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

// ── 高频意象（#10 项 7，黄）────────────────────────

test('checkImagery: 词表命中超阈 → 黄；空表 → 无', () => {
  const body = '空气仿佛凝固。又一次空气仿佛凝固。还是空气仿佛凝固。'
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

// ── 信息差候选（#10 项 11，黄）─────────────────────

test('checkInfoLeak: 关键词命中 → 候选（黄）；空源 → 无', () => {
  expect(checkInfoLeak('他其实是皇子。', ['皇子']).items.some((i) => i.checkId === 'info-leak-candidate')).toBe(true)
  expect(checkInfoLeak('他其实是皇子。', []).items).toHaveLength(0)
})
