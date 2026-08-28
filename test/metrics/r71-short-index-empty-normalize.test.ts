/**
 * R71-33（十九轮）回归：short-index 空串短路——纯标点/emoji 归一化后为空串的
 * 锚点标题/铺垫内容，修复前 `pos.includes('')` / `p.includes('')` 恒真：
 * - 锚点标题「！！」归一化空 → 任何铺垫都被计成「已锚定」（anchoredSetupCount 虚报）
 * - 铺垫内容「……」归一化空 → 任何伏笔回收都被计成「已对应铺垫」（payoffMatched 虚报）
 * 修复后空串短路（不计匹配），计数如实。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeChapter } from '../helpers/chapter.js'
import { writePieceList } from '../../src/format/manifest.js'
import { scanShortCollection } from '../../src/metrics/short-index.js'

let seq = 0

test('R71-33: 纯标点锚点标题不虚报 anchoredSetupCount（空串短路）', () => {
  const root = mkdtempSync(join(tmpdir(), 'r71-short-anchor-'))
  try {
    const name = `00${++seq}-空锚.md`
    const bodyDir = join(root, '写作', '正文', '第一卷')
    mkdirSync(bodyDir, { recursive: true })
    // 正文锚点标题全是标点/emoji——normalize 后空串；铺垫位置是真实文字
    writeChapter(join(bodyDir, name), {
      章号: seq,
      标题: '空锚',
      钩子类型: '悬念钩',
      钩子强弱: '中',
      情绪定位: '压抑',
      目标情绪: '惊悚',
      核心反转: '来客就是死者',
    }, `## ！！\n\n正文。门外没有脚印。\n\n## 🌑🌑\n\n脚印消失了。`)
    mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
    writePieceList(join(root, '大纲', '章纲', name), {
      反转线索表: {
        核心反转: '来客就是死者',
        铺垫点: [
          { 位置: '开头', 内容: '门外没有脚印' },
          { 位置: '中段', 内容: '脚印消失' },
        ],
      },
      情绪曲线: [{ 段落: '反转', 情绪: '震惊', 强度: 8 }],
      伏笔回收: [{ 伏笔: '脚印', 回收位置: '结尾' }],
    })
    const entries = scanShortCollection(root)
    // 修复前：空串锚点对任意位置 includes('') 恒真 → anchoredSetupCount = 2（虚报）
    expect(entries[0]!.reversalQuality.anchoredSetupCount).toBe(0)
    expect(entries[0]!.reversalQuality.issues).toContain('铺垫正文锚点 0/2，位置回指不足')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R71-33: 纯标点铺垫内容不虚报 payoffMatched（空串短路）', () => {
  const root = mkdtempSync(join(tmpdir(), 'r71-short-payoff-'))
  try {
    const name = `00${++seq}-空铺.md`
    const bodyDir = join(root, '写作', '正文', '第一卷')
    mkdirSync(bodyDir, { recursive: true })
    writeChapter(join(bodyDir, name), {
      章号: seq,
      标题: '空铺',
      钩子类型: '悬念钩',
      钩子强弱: '中',
      情绪定位: '压抑',
      目标情绪: '惊悚',
      核心反转: '来客就是死者',
    }, '门外没有脚印。')
    mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
    writePieceList(join(root, '大纲', '章纲', name), {
      反转线索表: {
        核心反转: '来客就是死者',
        铺垫点: [{ 位置: '开头', 内容: '……' }], // normalize 后空串（isPlaceholder 不含省略号）
      },
      情绪曲线: [{ 段落: '反转', 情绪: '震惊', 强度: 8 }],
      伏笔回收: [{ 伏笔: '脚印', 回收位置: '结尾' }],
    })
    const entries = scanShortCollection(root)
    // 修复前：payoff 「脚印」对空串铺垫 includes('') 恒真 → payoffMatched = 1（虚报）
    expect(entries[0]!.reversalQuality.payoffMatched).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
