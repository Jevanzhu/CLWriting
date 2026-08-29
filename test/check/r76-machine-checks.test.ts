/**
 * R76（二十四轮修复批 B）：机检正确性域回归。
 *
 * - R76-3：checkNewNames 句读守卫改在剥句读前的原文上判——动作+对白混排行不再穿透成
 *   伪专名黄项（原 spanPunctRe.test(name) 判的是已被 punctRe 剥净的 name，恒 false）。
 * - R76-4：parseBannedWordsLine 引号窗口 {2,24}→{1,}+后置过滤——单字禁词（「了」类）
 *   不再带引号整行成词（includes 永不命中的静默失明）；超长引号段交 unparsed。
 * - R76-15：book.yaml 正数语义键（budget 键族/leads.thresholds/auto.batch_size/
 *   relation_mine_threshold）空值/非正数拒收按未设（原 Number('')=0 混过 isFinite）。
 * - R76-19：履历证据剥引号后为空 → lead-evidence-unverifiable 黄项（原两不报静默失明）。
 * - R76-21：headingEndsSection 连续标题链（## 分组+### 详注+条目）不再误判节终。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { checkNewNames } from '../../src/check/count.js'
import { parseBannedWordsLine } from '../../src/format/style-entry.js'
import { parseBookConfig } from '../../src/format/yaml.js'
import { headingEndsSection } from '../../src/format/leads.js'
import { checkLeadsBookItems } from '../../src/check/leads.js'
import { collectTreeIssues } from '../../src/check/run.js'
import { readManifest, writeManifest, upsertEntry, type ManifestEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-r76-b-'))
})
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// ── R76-3：混排行不再误报新专名 ─────────────────────────────────

test('R76-3: 动作+对白混排行的引语段不再报伪专名；真新名照报', () => {
  const roster = join(dir, '名册.md')
  writeFileSync(roster, '# 名册\n- 已登记：林远、赵衡\n')
  const namesOf = (body: string): string[] =>
    checkNewNames(body, roster).items.map((i) => i.message.match(/「(.+?)」/)?.[1] ?? '')
  // 报告 tsx 实测复现的两条穿透样例
  expect(namesOf('他低声道：「别动。」然后按住她的肩。\n')).toEqual([])
  expect(namesOf('她喊着「快走，掩护」头也不回地冲了出去。\n')).toEqual([])
  // 阳性对照：无句读的真新名仍报
  expect(namesOf('他们口中的「玄天宗」势力庞大。\n')).toContain('玄天宗')
})

// ── R76-4：单字禁词不再静默失明 ─────────────────────────────────

test('R76-4: 单字引号禁词入表；超长引号段交 unparsed（返回空）', () => {
  expect(parseBannedWordsLine('「地」')).toEqual(['地'])
  expect(parseBannedWordsLine('禁用「了」开头的句式')).toEqual(['了'])
  expect(parseBannedWordsLine('「快走」')).toEqual(['快走'])
  // 25+ 字引号段：不是「词」，整行 [] → readBannedEntryWords 报 unparsed 黄项
  expect(parseBannedWordsLine('「这一句是超过二十四个字的长示例禁句用来验证超长引号段的处理口径。」')).toEqual([])
})

// ── R76-15：空值键按未设 ────────────────────────────────────────

test('R76-15: budget/thresholds/batch_size 空值键按未设（不再静默落 0）', () => {
  const r = parseBookConfig(
    [
      'spec_version: 1',
      'kind: long',
      'book:',
      '  title: 测试书',
      'host: cc',
      'budget:',
      '  tokens_per_chapter:',
      '  calls_per_chapter: 5',
      'leads:',
      '  enabled: []',
      '  thresholds:',
      '    leading_burn:',
      'auto:',
      '  batch_size:',
      '  relation_mine_threshold:',
    ].join('\n'),
  )
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.config.budget.tokens_per_chapter).toBeUndefined()
  expect(r.config.budget.calls_per_chapter).toBe(5)
  expect(r.config.leads.thresholds).toBeUndefined()
  expect(r.config.auto).toBeUndefined()
})

// ── R76-19：空证据报黄 ──────────────────────────────────────────

/** 复刻 tree-issues-leads-book.test 的最小造书（证据为空引号对「」）。 */
function makeEmptyEvidenceBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-r76-empty-ev-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-空证据.md'),
    '---\n编号: 悬念-001\n标题: 空证据\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第2章 埋下：「」\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (const no of [1, 2, 3]) {
    const pad = String(no).padStart(3, '0')
    const rel = `写作/正文/${pad}-第${no}章.md`
    writeFileSync(
      join(root, rel),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${no}章的叙述文本，山门外落了整夜的雨。\n`,
      'utf-8',
    )
    const entry: ManifestEntry = { id: generateDocId(), nodeType: 'document', path: rel, parentId: null }
    if (no === 3) {
      entry.finalizedRevision =
        'sha256:' + createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')
    }
    upsertEntry(m, entry)
  }
  writeManifest(manifestPath, m)
  return root
}

test('R76-19: 证据剥引号后为空 → unverifiable 黄项（修复前：miss/unverifiable 两不报）', () => {
  const root = makeEmptyEvidenceBook()
  try {
    // 建库（collectTreeIssues 内部 rebuild 布线 db），再以只读库直查全书性检查
    collectTreeIssues(root, () => undefined)
    const db = new DatabaseSync(join(root, '.cache', 'index.db'), { readOnly: true })
    try {
      const items = checkLeadsBookItems(db, root, 3, ['悬念'])
      const unverifiable = items.filter((i) => i.checkId === 'lead-evidence-unverifiable')
      expect(unverifiable).toHaveLength(1)
      expect(unverifiable[0]!.level).toBe('yellow')
      expect(unverifiable[0]!.message).toContain('剥引号后为空')
      expect(items.some((i) => i.checkId === 'lead-evidence-miss')).toBe(false)
    } finally {
      db.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R76-21：连续标题链 ──────────────────────────────────────────

const isHistoryEntry = (line: string): boolean => /^\s*-\s*第(\d+)章\s+(.+?)[：:](.+)$/.test(line)

test('R76-21: 连续标题链（## 分组+### 详注+条目）判分组；孤立标题原口径不变', () => {
  // 修复前：## 分组 的下一行是标题 → 误判节终，条目掉出解析
  const chain = ['## 分组', '### 详注', '- 第012章 埋下：证据甲乙']
  expect(headingEndsSection(chain, 0, isHistoryEntry)).toBe(false)
  expect(headingEndsSection(chain, 1, isHistoryEntry)).toBe(false)
  // 孤立节终标题（其后人工内容归 after）：文末无条目 → true
  expect(headingEndsSection(['## 备注', '作者手写的一段说明。'], 0, isHistoryEntry)).toBe(true)
  expect(headingEndsSection(['## 旧档'], 0, isHistoryEntry)).toBe(true)
  // 标题链直达文末（无条目）→ 仍节终
  expect(headingEndsSection(['## 归档', '### 旧'], 0, isHistoryEntry)).toBe(true)
  // 空行分隔的条目仍属分组（原语义保持：非标题非条目行跳过继续）
  expect(headingEndsSection(['## 分组', '', '- 第012章 埋下：证据甲乙'], 0, isHistoryEntry)).toBe(false)
})
