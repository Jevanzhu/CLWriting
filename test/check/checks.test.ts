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
import { checkFrontMatter, checkBannedWords, checkWordCount, checkRepeat } from '../../src/check/count.js'
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

// ── front matter 格式（⑩ 项 3，红）──────────────

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

// ── 禁词（⑩ 项 4，红）──────────────────────────

test('checkBannedWords: 命中禁词 → 红', () => {
  const r = checkBannedWords('他微笑着深情地说了句废话', ['废话', '深情地说'])
  expect(r.items).toHaveLength(2)
  expect(r.items.every((i) => i.level === 'red')).toBe(true)
})

// ── 字数（⑩ 项 5，黄）──────────────────────────

test('checkWordCount: 偏离目标 → 黄', () => {
  const r = checkWordCount(2000, 3000, 30) // 偏差 33% > 30%
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.level).toBe('yellow')
})

test('checkWordCount: 在容差内 → 无黄', () => {
  const r = checkWordCount(2900, 3000, 30)
  expect(r.items).toHaveLength(0)
})

// ── 复读（⑩ 项 6，黄）──────────────────────────

test('checkRepeat: 重复句多 → 黄', () => {
  // 句子需 ≥6 字才计入（checkRepeat 过滤短句）
  const body = '他大步流星地走了过去。他大步流星地走了过去。他大步流星地走了过去。她轻轻微微地笑了起来。她轻轻微微地笑了起来。这是一句正常的独独立立句子。'
  const r = checkRepeat(body, 0.15)
  expect(r.items.length).toBeGreaterThanOrEqual(1)
  expect(r.items[0]!.level).toBe('yellow')
})

// ── 成长线语义（⑥，红）─────────────────────────

test('checkGrowth: 境界回退 → 红', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)

  syncLead(db, {
    编号: '成长线-003', 标题: '修为', 类型: '成长线', 状态: '进行中', 开启章: 1,
    当前境界: '金丹',
    履历: [
      { 章号: 10, 动词: '跃迁', 证据: '突破至筑基' },
      { 章号: 20, 动词: '跃迁', 证据: '突破至金丹' },
      { 章号: 30, 动词: '跃迁', 证据: '跌落至炼气' }, // 回退
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
      { 章号: 20, 动词: '跃迁', 证据: '突破至筑基' },
    ], _path: 'p',
  })
  const realmDoc: RealmDoc = { 体系: [{ 名称: '修真', 序列: ['炼气', '筑基', '金丹'] }] }
  const r = checkGrowth(db, realmDoc, ['成长线-001'], 2)
  expect(r.items).toHaveLength(0)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── 报告分级（⑩ 第 7 节）────────────────────────

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
