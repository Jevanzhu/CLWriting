import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePiece } from '../../src/format/pieces.js'
import { writePieceList } from '../../src/format/manifest.js'
import {
  analyzeShortBudgetCalibration,
  analyzeShortCalibration,
  analyzeShortCollection,
  formatShortBudgetCalibrationReport,
  formatShortCalibrationReport,
  formatShortCollectionReport,
  scanShortCalibrationSamples,
  scanShortCollection,
} from '../../src/metrics/short-index.js'
import type { PieceList } from '../../src/format/types.js'
import type { MetricRecord } from '../../src/metrics/ledger.js'

function makePiece(root: string, num: number, title: string, opts: {
  emotion: string
  reversal: string
  object: string
  ending: string
}): void {
  const dir = join(root, '篇', `${String(num).padStart(3, '0')}-${title}`)
  mkdirSync(dir, { recursive: true })
  writePiece(join(dir, '正文.md'), {
    篇号: num,
    标题: title,
    目标情绪: opts.emotion,
    核心反转: opts.reversal,
  }, `正文 ${title}`)
  const list: PieceList = {
    反转线索表: {
      核心反转: opts.reversal,
      铺垫点: [
        { 位置: '开头钩子', 内容: opts.object },
        { 位置: '铺垫', 内容: `${opts.object}再次出现` },
        { 位置: '升级', 内容: `${opts.object}意义变化` },
      ],
    },
    情绪曲线: [
      { 段落: '开头钩子', 情绪: opts.emotion, 强度: 3 },
      { 段落: '铺垫', 情绪: opts.emotion, 强度: 5 },
      { 段落: '升级', 情绪: opts.emotion, 强度: 7 },
      { 段落: '反转', 情绪: opts.emotion, 强度: 9 },
      { 段落: '余韵', 情绪: opts.ending, 强度: 6 },
    ],
    伏笔回收: [{ 伏笔: opts.object, 回收位置: '结尾' }],
  }
  writePieceList(join(dir, '清单.md'), list)
}

test('scanShortCollection: 扫正文与清单生成短篇集索引', () => {
  const root = mkdtempSync(join(tmpdir(), 'short-index-'))
  try {
    makePiece(root, 1, '雪夜', {
      emotion: '惊悚',
      reversal: '来客就是死者',
      object: '门外没有脚印',
      ending: '后怕',
    })
    const entries = scanShortCollection(root)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      num: 1,
      title: '雪夜',
      targetEmotion: '惊悚',
      coreReversal: '来客就是死者',
      reversalType: '死者反转',
      endingFlavor: '后怕',
    })
    expect(entries[0]!.structureObjects).toContain('门外没有脚印')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('analyzeShortCollection: 最近重复与全书重复会出风险', () => {
  const root = mkdtempSync(join(tmpdir(), 'short-index-'))
  try {
    for (let i = 1; i <= 3; i++) {
      makePiece(root, i, `雪夜${i}`, {
        emotion: '惊悚',
        reversal: i < 3 ? '来客就是死者' : '门后的人是死者',
        object: '门外没有脚印',
        ending: '后怕',
      })
    }
    const report = analyzeShortCollection(scanShortCollection(root))
    const messages = report.risks.map((r) => r.message).join('\n')
    expect(messages).toContain('最近 3 篇目标情绪都为「惊悚」')
    expect(messages).toContain('最近 3 篇反转类型都为「死者反转」')
    expect(messages).toContain('最近 3 篇结尾味道都为「后怕」')
    expect(messages).toContain('核心反转重复')
    expect(messages).toContain('结构物件/伏笔「门外没有脚印」重复出现')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('formatShortCollectionReport: 无风险时输出节奏体检绿项', () => {
  const out = formatShortCollectionReport({
    count: 1,
    entries: [{
      num: 1,
      title: '雪夜',
      targetEmotion: '惊悚',
      coreReversal: '来客就是死者',
      reversalType: '死者反转',
      structureObjects: ['脚印'],
      endingFlavor: '后怕',
    }],
    risks: [],
  })
  expect(out).toContain('短篇集节奏体检')
  expect(out).toContain('暂未发现明显重复风险')
})

test('analyzeShortCalibration: 从定稿短篇样本生成阈值回灌建议', () => {
  const root = mkdtempSync(join(tmpdir(), 'short-calibration-'))
  try {
    for (let i = 1; i <= 5; i++) {
      const dir = join(root, '篇', `${String(i).padStart(3, '0')}-样本${i}`)
      mkdirSync(dir, { recursive: true })
      writePiece(join(dir, '正文.md'), {
        篇号: i,
        标题: `样本${i}`,
        目标情绪: '惊悚',
        核心反转: '来客就是死者',
      }, [
        '## 开头钩子',
        `${'故事'.repeat(1200 + i * 80)}眼睛眼睛像`,
        '## 铺垫',
        `${'推进'.repeat(900 + i * 60)}像`,
        '## 升级',
        `${'反应'.repeat(800 + i * 40)}`,
        '## 反转',
        `${'真相'.repeat(700 + i * 30)}`,
        '## 余韵',
        `${'后怕'.repeat(500 + i * 20)}`,
      ].join('\n'))
    }
    const samples = scanShortCalibrationSamples(root, 220)
    const report = analyzeShortCalibration(samples, { word_min: 6000, word_max: 16000, opening_env_chars: 220 })
    expect(report.count).toBe(5)
    expect(report.confidence).toBe('medium')
    expect(report.recommended.word_min).toBeGreaterThanOrEqual(3000)
    expect(report.recommended.word_max).toBeGreaterThan(report.recommended.word_min!)
    expect(report.recommended.section_count).toBe(5)

    const out = formatShortCalibrationReport(report)
    expect(out).toContain('短篇阈值回灌建议')
    expect(out).toContain('建议 short:')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('analyzeShortBudgetCalibration: 从短篇指标账生成每篇调用预算候选', () => {
  const records: MetricRecord[] = [4, 5, 6, 7, 8].map((total, idx) => ({
    kind: 'short',
    num: idx + 1,
    title: `短篇${idx + 1}`,
    words: 8000,
    at: `2026-06-23T00:00:0${idx}.000Z`,
    calls: { outline: 1, draft: total - 4, review: 3, total, limit: 8 },
    tokens: null,
    review: { tier: 'full', downgrade: false, downgrade_reason: null, blockers: 0, warnings: 0, invalid: 0, lenses: ['hook', 'emotion_peak', 'payoff'] },
  }))
  const report = analyzeShortBudgetCalibration(records, 8)
  expect(report.count).toBe(5)
  expect(report.recommendedLimit).toBe(9)
  expect(report.nearLimit).toBe(2)

  const out = formatShortBudgetCalibrationReport(report)
  expect(out).toContain('短篇预算校准建议')
  expect(out).toContain('建议候选 9')
})
