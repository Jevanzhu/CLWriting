import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeChapter } from '../helpers/chapter.js'
import { writePieceList } from '../../src/format/manifest.js'
import {
  analyzeShortCollection,
  formatShortSubmissionView,
  scanShortCollection,
} from '../../src/metrics/short-index.js'
import type { PieceList } from '../../src/format/types.js'

function makePiece(root: string, num: number, title: string, opts: {
  emotion: string
  reversal: string
  object: string
  ending: string
}): void {
  const name = `${String(num).padStart(3, '0')}-${title}.md`
  // 短篇正文进卷结构：写作/正文/<卷>/（resolveDraftPath 统一 inferVolumeDir）
  const bodyDir = join(root, '写作', '正文', '第一卷')
  mkdirSync(bodyDir, { recursive: true })
  writeChapter(join(bodyDir, name), {
    章号: num,
    标题: title,
    钩子类型: '悬念钩',
    钩子强弱: '中',
    情绪定位: '压抑',
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
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  writePieceList(join(root, '大纲', '章纲', name), list)
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
      wordCount: 4,
      targetEmotion: '惊悚',
      coreReversal: '来客就是死者',
      reversalType: '死者反转',
      endingFlavor: '后怕',
    })
    expect(entries[0]!.structureObjects).toContain('门外没有脚印')
    expect(entries[0]!.reversalQuality).toMatchObject({ grade: '强', setupCount: 3 })
    expect(entries[0]!.reversalQuality.score).toBeGreaterThanOrEqual(90)
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
    expect(messages).toContain('最近 3 章目标情绪都为「惊悚」')
    expect(messages).toContain('最近 3 章反转类型都为「死者反转」')
    expect(messages).toContain('最近 3 章结尾味道都为「后怕」')
    expect(messages).toContain('核心反转重复')
    expect(messages).toContain('结构物件/伏笔「门外没有脚印」重复出现')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('analyzeShortCollection: 输出平台画像、策划分布与弱反转评分', () => {
  const root = mkdtempSync(join(tmpdir(), 'short-index-weak-'))
  try {
    mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
    writeChapter(join(root, '写作', '正文', '第一卷', '001-薄反转.md'), {
      章号: 1,
      标题: '薄反转',
      钩子类型: '悬念钩',
      钩子强弱: '中',
      情绪定位: '压抑',
      目标情绪: '惊悚',
      核心反转: '待补',
    }, '很短的正文')
    mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
    writePieceList(join(root, '大纲', '章纲', '001-薄反转.md'), {
      反转线索表: {
        核心反转: '待补',
        铺垫点: [{ 位置: '开头', 内容: '脚印' }],
      },
      情绪曲线: [{ 段落: '反转', 情绪: '震惊', 强度: 5 }],
      伏笔回收: [{ 伏笔: '脚印', 回收位置: '', 未回收: true }],
    })

    const report = analyzeShortCollection(scanShortCollection(root), {
      profile: '悬疑反转',
      word_min: 6000,
      word_max: 16000,
      opening_env_chars: 220,
    })
    expect(report.platform.profile).toBe('悬疑反转')
    expect(report.platform.weakReversals).toBe(1)
    expect(report.planning.emotions[0]).toMatchObject({ value: '惊悚', count: 1, pieces: [1] })
    expect(report.entries[0]!.reversalQuality.grade).toBe('弱')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('analyzeShortCollection: 画像目标分布会提示缺口，清单质量校验正文锚点与回收链路', () => {
  const root = mkdtempSync(join(tmpdir(), 'short-index-targets-'))
  try {
    makePiece(root, 1, '雪夜', {
      emotion: '惊悚',
      reversal: '来客就是死者',
      object: '门外没有脚印',
      ending: '后怕',
    })
    const report = analyzeShortCollection(scanShortCollection(root), {
      profile: '悬疑反转',
      target_emotions: ['惊悚', '不安'],
      target_reversal_types: ['死者反转', '真凶反转'],
      target_ending_flavors: ['后怕', '余寒'],
    })
    expect(report.platform.targetGaps).toEqual([
      '情绪 不安',
      '反转 真凶反转',
      '结尾 余寒',
    ])
    expect(report.entries[0]!.reversalQuality.payoffMatched).toBe(1)
    expect(report.entries[0]!.reversalQuality.issues).toContain('正文缺少 ## 段落锚点，铺垫位置只能做弱校验')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('formatShortSubmissionView: 生成投稿视图含平台模板与策划分布', () => {
  const root = mkdtempSync(join(tmpdir(), 'short-guidance-'))
  try {
    for (let i = 1; i <= 3; i++) {
      makePiece(root, i, `雪夜${i}`, {
        emotion: '惊悚',
        reversal: i === 3 ? '门后的人是死者' : '来客就是死者',
        object: '门外没有脚印',
        ending: '后怕',
      })
    }
    const entries = scanShortCollection(root)

    const submission = formatShortSubmissionView(entries, { profile: '悬疑反转' }, '夜语集')
    expect(submission).toContain('# 投稿视图-夜语集')
    expect(submission).toContain('| 001 | 雪夜1 |')
    expect(submission).toContain('核心反转：来客就是死者')
    expect(submission).toContain('## 策划分布')

    const zhihu = formatShortSubmissionView(entries, { profile: '悬疑反转' }, '夜语集', 'zhihu-salt')
    expect(zhihu).toContain('# 投稿视图-夜语集-知乎盐选')
    expect(zhihu).toContain('平台模板：知乎盐选')
    expect(zhihu).toContain('付费后反转')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
