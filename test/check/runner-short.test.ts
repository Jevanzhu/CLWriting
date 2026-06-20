import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAllChecks, hasRed } from '../../src/check/runner.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { writePieceList } from '../../src/format/manifest.js'
import type { ChapterMeta, BookConfig, PieceList } from '../../src/format/types.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clwriting-runner-short-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function shortConfig(): BookConfig {
  return { ...DEFAULT_CONFIG, kind: 'short' }
}

// ── 短篇机检不依赖 db（零 db 依赖）──────────────

test('runAllChecks short: 不传 db 不崩', () => {
  const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }
  const r = runAllChecks({
    bookRoot: tmp,
    config: shortConfig(),
    chapter: ch,
    body: '他推开门，血溅了一地。',
    fileName: '篇/001-雪夜/正文.md',
  })
  expect(r.sections.length).toBeGreaterThan(0)
  // 短篇无账本变动清单
  expect(r.byproducts?.leadChanges ?? []).toHaveLength(0)
})

// ── 跳长程项（无账本/成长线 section）──────────────

test('runAllChecks short: 不含账本/成长线 section', () => {
  const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }
  const r = runAllChecks({
    bookRoot: tmp,
    config: shortConfig(),
    chapter: ch,
    body: '正文',
    fileName: '篇/001-雪夜/正文.md',
  })
  const names = r.sections.map((s) => s.name)
  expect(names).not.toContain('账本形式')
  expect(names).not.toContain('成长线')
})

// ── 跑通用项 + 短篇专属项 ────────────────────────

test('runAllChecks short: 含禁词/复读/句式 + 短篇专属项', () => {
  const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }
  const r = runAllChecks({
    bookRoot: tmp,
    config: shortConfig(),
    chapter: ch,
    body: '正文内容',
    fileName: '篇/001-雪夜/正文.md',
    bannedWords: ['禁词x'],
  })
  const names = r.sections.map((s) => s.name)
  expect(names).toContain('禁词')
  expect(names).toContain('复读')
  expect(names).toContain('句式体检')
  expect(names).toContain('身体部位词')
  expect(names).toContain('比喻密度')
  expect(names).toContain('节数守恒')
  expect(names).toContain('开头零环境')
})

test('runAllChecks short: 文风铁律反和解段命中 → 禁词红项', () => {
  mkdirSync(join(tmp, '文风'), { recursive: true })
  writeFileSync(join(tmp, '文风', '文风铁律.md'), [
    '## 反和解段（AI 味防御）',
    '- 倒吸凉气、时间静止',
    '',
    '## 可量化约束',
    '- 单句上限字数: 60',
  ].join('\n'), 'utf-8')

  const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }
  const r = runAllChecks({
    bookRoot: tmp,
    config: shortConfig(),
    chapter: ch,
    body: '全场倒吸凉气，仿佛时间静止。',
    fileName: '篇/001-雪夜/正文.md',
  })
  const red = r.sections.flatMap((s) => s.items).filter((i) => i.level === 'red')
  expect(red.some((i) => i.checkId === 'banned-word' && i.message.includes('倒吸凉气'))).toBe(true)
  expect(red.some((i) => i.checkId === 'banned-word' && i.message.includes('时间静止'))).toBe(true)
})

// ── 篇号文件名不一致报红（短篇 front matter）──────

test('runAllChecks short: 篇号文件名不一致 → 红项', () => {
  const ch: ChapterMeta = { 章号: 2, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }
  const r = runAllChecks({
    bookRoot: tmp,
    config: shortConfig(),
    chapter: ch,
    body: '正文',
    fileName: '篇/001-雪夜/正文.md', // 文件名 001 但章号 2
  })
  expect(hasRed(r)).toBe(true)
})

// ── 清单形式检接入（同目录有 清单.md）────────────

test('runAllChecks short: 同目录有清单.md → 跑清单形式检', () => {
  const pieceDir = join(tmp, '篇', '001-雪夜')
  mkdirSync(pieceDir, { recursive: true })
  const piecePath = join(pieceDir, '正文.md')
  writeFileSync(piecePath, '---\n篇号: 1\n标题: 雪夜\n---\n正文', 'utf-8')

  // 铺垫点仅 1 处（<3）→ manifest-setup-short 触发；核心反转占位「待补」不算缺
  const list: PieceList = {
    反转线索表: { 核心反转: 'x', 铺垫点: [{ 位置: 'a', 内容: 'x' }] },
    伏笔回收: [{ 伏笔: 'y', 回收位置: '', 未回收: true }], // 未回收标记
  }
  writePieceList(join(pieceDir, '清单.md'), list)

  const ch: ChapterMeta = {
    章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
    _path: piecePath,
  }
  const r = runAllChecks({
    bookRoot: tmp,
    config: shortConfig(),
    chapter: ch,
    body: '正文',
    fileName: '篇/001-雪夜/正文.md',
  })
  const names = r.sections.map((s) => s.name)
  expect(names).toContain('清单形式检')
  expect(r.byproducts?.pieceListChecks).toEqual([
    { type: 'reversal', subject: 'x', location: 'a', detail: 'x' },
    { type: 'payoff', subject: 'y', location: '', detail: '未回收' },
  ])
  const form = r.sections.find((s) => s.name === '清单形式检')!
  expect(form.items.length).toBeGreaterThanOrEqual(2) // 铺垫<3 + 未回收
})
