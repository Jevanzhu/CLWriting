/**
 * R52-E-2（五十二轮）回归：机检阈值五键的 runner 生效链——
 * book.yaml checks.* 经 config 直达 checkWordCount / checkRepeat / checkImagery /
 * checkSentenceLength（undefined 直落引擎默认参数，行为不变）；附严格短篇升红
 * 三项（repeat / sentence-length / imagery-overuse）的边界钉。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAllChecks, promoteStrictShort } from '../../src/check/runner.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { ChapterMeta, BookConfig } from '../../src/format/types.js'
import type { CheckItem } from '../../src/check/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempTracked(join(tmpdir(), 'clwriting-r52-check-thr-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const CH: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }

function itemsById(report: ReturnType<typeof runAllChecks>, checkId: string): CheckItem[] {
  return report.sections.flatMap((s) => s.items).filter((i) => i.checkId === checkId)
}

// ── word_count_tolerance（长篇字数容差）──────────────

test('R52-E-2: 字数容差——默认 30% 报黄，checks.word_count_tolerance 放宽后不报', () => {
  const base = {
    bookRoot: tmp,
    config: structuredClone(DEFAULT_CONFIG), // 长篇（无 short 段）
    chapter: { ...CH, _wordCount: 5000 },
    body: '正文。',
    fileName: '001-雪夜.md',
    targetWords: 10000, // 偏差 50%
  }
  // 默认容差 30% → 黄
  expect(itemsById(runAllChecks({ ...base }), 'word-count')).toHaveLength(1)
  // 容差 60% → 同一章不报
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.checks = { word_count_tolerance: 60 }
  expect(itemsById(runAllChecks({ ...base, config: cfg }), 'word-count')).toHaveLength(0)
})

// ── repeat_threshold / repeat_chars_threshold（复读双口径）──────────────

const REP = '他推开门走了出去，雪落了下来，屋里的灯还亮着。'
const REP_BODY = REP.repeat(30) // 8-gram 重复率 ≈ 0.967；重复字符量 ≈ 3700 字

test('R52-E-2: 复读默认双口径报黄；双阈抬高一并静默', () => {
  const base = {
    bookRoot: tmp,
    config: structuredClone(DEFAULT_CONFIG),
    chapter: CH,
    body: REP_BODY,
    fileName: '001-雪夜.md',
  }
  // 默认（0.15 / 200）→ 比率口径命中
  const def = itemsById(runAllChecks(base), 'repeat')
  expect(def).toHaveLength(1)
  expect(def[0]!.message).toContain('复读率')
  // 比率阈 0.99 + 绝对阈 100 万 → 双口径全静默
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.checks = { repeat_threshold: 0.99, repeat_chars_threshold: 1_000_000 }
  expect(itemsById(runAllChecks({ ...base, config: cfg }), 'repeat')).toHaveLength(0)
})

test('R52-E-2: 比率阈抬高后绝对口径兜底——repeat_chars_threshold 单独收紧仍报', () => {
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.checks = { repeat_threshold: 0.99 } // 压掉比率口径（0.967 < 0.99）
  const r = runAllChecks({
    bookRoot: tmp,
    config: cfg,
    chapter: CH,
    body: REP_BODY,
    fileName: '001-雪夜.md',
  })
  const rep = itemsById(r, 'repeat')
  expect(rep).toHaveLength(1)
  expect(rep[0]!.message).toContain('重复字符量') // 绝对口径接棒（默认 200 字 < ~3700）
})

// ── max_sentence_len（句式体检判定长度）──────────────

const LONG1 = '夜色渐深山道弯弯他提着灯笼慢慢往前走心里惦记着家里生病的母亲脚步却不敢停下半夜的风吹得灯笼摇晃不定远处偶尔传来几声犬吠让这条路显得更长了。' // 68 字
const SENT_BODY = `${LONG1}\n他到家了。` // 2 句中超长 1 句 = 50% > 20%

test('R52-E-2: 句长默认 60 报黄；checks.max_sentence_len 放宽后不报', () => {
  const base = {
    bookRoot: tmp,
    config: structuredClone(DEFAULT_CONFIG), // 无文风铁律 → 汇总句式体检照跑
    chapter: CH,
    body: SENT_BODY,
    fileName: '001-雪夜.md',
  }
  expect(itemsById(runAllChecks(base), 'sentence-length')).toHaveLength(1)
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.checks = { max_sentence_len: 100 }
  expect(itemsById(runAllChecks({ ...base, config: cfg }), 'sentence-length')).toHaveLength(0)
})

// ── imagery_threshold（高频意象次数阈值）──────────────

const IMG_BODY = '空气忽然安静下来。窗外的空气有点冷。他说空气里有一股土腥味。她深吸一口空气。' // 空气 ×4

test('R52-E-2: 意象默认 >3 报黄；checks.imagery_threshold 抬高后不报', () => {
  const base = {
    bookRoot: tmp,
    config: structuredClone(DEFAULT_CONFIG),
    chapter: CH,
    body: IMG_BODY,
    fileName: '001-雪夜.md',
    imageryWords: ['空气'], // 入参显式词表（供给链最顶级）
  }
  expect(itemsById(runAllChecks(base), 'imagery-overuse')).toHaveLength(1)
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.checks = { imagery_threshold: 10 }
  expect(itemsById(runAllChecks({ ...base, config: cfg }), 'imagery-overuse')).toHaveLength(0)
})

// ── 严格短篇升红三项 ──────────────────────────────

test('R52-E-2: 严格短篇下 repeat 黄项升红（配了宽阈后黄项消失=绿过闸面收口）', () => {
  const cfg: BookConfig = { ...structuredClone(DEFAULT_CONFIG), kind: 'short', short: {} }
  const r = runAllChecks({
    bookRoot: tmp,
    config: cfg,
    chapter: CH,
    body: REP_BODY,
    fileName: '001-雪夜.md',
    strictShort: true,
  })
  const rep = itemsById(r, 'repeat')
  expect(rep).toHaveLength(1)
  expect(rep[0]!.level).toBe('red')
  expect(rep[0]!.message.startsWith('短篇严格模式：')).toBe(true)
})

test('R52-E-2: promoteStrictShort 升红 repeat/sentence-length/imagery-overuse，word-count 不在列', () => {
  const sections = [
    {
      name: '机检',
      items: [
        { checkId: 'repeat', level: 'yellow', message: '复读' },
        { checkId: 'sentence-length', level: 'yellow', message: '句长' },
        { checkId: 'imagery-overuse', level: 'yellow', message: '意象' },
        { checkId: 'word-count', level: 'yellow', message: '字数（长篇项，刻意不升红）' },
      ] as CheckItem[],
    },
  ]
  promoteStrictShort(sections as unknown as ReturnType<typeof runAllChecks>['sections'])
  const byId = (id: string): CheckItem | undefined => sections[0]!.items.find((i) => i.checkId === id)
  expect(byId('repeat')!.level).toBe('red')
  expect(byId('sentence-length')!.level).toBe('red')
  expect(byId('imagery-overuse')!.level).toBe('red')
  expect(byId('word-count')!.level).toBe('yellow') // 长篇项不在严格短篇升红面（报告 §七 E-2 范围）
})
