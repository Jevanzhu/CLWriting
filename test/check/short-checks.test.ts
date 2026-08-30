import { test, expect } from 'vitest'
import {
  checkFrontMatter,
  checkPieceWordCount,
  checkBodyParts,
  checkSimile,
  checkSectionCount,
  checkOpeningNoEnv,
} from '../../src/check/count.js'
import { checkPieceListForm } from '../../src/check/manifest-check.js'
import type { PieceList } from '../../src/format/types.js'

// ── checkFrontMatter ────────────────────────────

test('checkFrontMatter: 章号文件名一致通过', () => {
  const r = checkFrontMatter({ 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }, '第一卷/001-雪夜.md')
  expect(r.items).toHaveLength(0)
})

test('checkFrontMatter: 章号不一致报红', () => {
  const r = checkFrontMatter({ 章号: 2, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }, '第一卷/001-雪夜.md')
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.level).toBe('red')
})

// ── checkPieceWordCount ──────────────────────────

test('checkPieceWordCount: 区间内通过', () => {
  expect(checkPieceWordCount(12000).items).toHaveLength(0)
})

test('checkPieceWordCount: 低于下限报黄', () => {
  const r = checkPieceWordCount(3000)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.checkId).toBe('piece-word-short')
})

// ── checkBodyParts ───────────────────────────────

test('checkBodyParts: 堆砌超阈报黄', () => {
  const body = '眼睛'.repeat(6) + '手指'.repeat(6) // 各 6 次 > 5
  const r = checkBodyParts(body)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.message).toContain('眼睛')
  expect(r.items[0]!.message).toContain('手指')
})

test('checkBodyParts: 动作语境的「手」纳入计数，惯用语不误报', () => {
  // 带动作前缀的肢体动作计入（伸手/握手/抬手…）
  const r = checkBodyParts('伸手 握手 抬手 拉手 挥手 抓住手')
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.message).toContain('手×6')
  // 惯用语/隐喻里的「手」不误报
  expect(checkBodyParts('他不是对手。随手放下。高手过招。手段高明。一把好手。三只手。').items).toHaveLength(0)
})

test('checkBodyParts: 未超阈通过', () => {
  expect(checkBodyParts('眼睛手指心脏').items).toHaveLength(0) // 各 1 次
})

// ── checkSimile ──────────────────────────────────

test('checkSimile: 明喻句式超阈报黄', () => {
  const r = checkSimile('像雪花一样飘落。像月光一样清冷。像石头一样沉默。像流水一样绵长。像火焰一样炽热。像薄雾一样朦胧。像刀锋一样锋利。像湖水一样平静。像远山一样巍峨。像灯火一样温暖。像尘埃一样渺小。像星河一样浩瀚。', 10)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.message).toContain('12')
})

test('checkSimile: 非明喻「像」字不计入（P3-12 模式约束）', () => {
  expect(checkSimile('他很像他的父亲。相像之处颇多。', 10).items).toHaveLength(0)
  expect(checkSimile('像'.repeat(11), 10).items).toHaveLength(0)
})

test('checkSimile: 未超阈通过', () => {
  expect(checkSimile('像雪花一样飘落。', 10).items).toHaveLength(0)
})

// R-9（十五轮登记销账）：前置排除改零宽 lookbehind——相邻明喻不再因前字符被上一
// 命中消费而漏计（漏报不误报）
test('checkSimile: 相邻明喻逐个计数（R-9 lookbehind）', () => {
  // 「像刀像雪」两个明喻背靠背：修复前第二个「像」前字符「刀」已被吞 → 只计 1
  const r1 = checkSimile('像刀像雪。', 1)
  expect(r1.items).toHaveLength(1) // 计 2 > 阈 1 → 报黄（修复前计 1 ≤ 1 不报）
  expect(r1.items[0]!.message).toContain('2')
  // 对照：间隔一个非「像」字仍计 2（既有行为不变）
  expect(checkSimile('剑像刀，光像雪。', 1).items).toHaveLength(1)
})

test('AA-P3-6 金测: 真实语料明喻计数——4 处明喻 + 非比喻「像」不误计（漏报/误报基线）', () => {
  const body = [
    '她坐在窗前，很像她母亲年轻时的样子。', // 很像 → 非比喻，不计
    '月光像水一样漫过桌角，他的手指像枯枝般蜷着，心却像刀割一样疼。', // 3 处
    '她不像从前那样容易相信别人了。', // 不像 → 非比喻，不计
    '门外站着一个人，像一尊沉默的石像。', // 1 处
  ].join('')
  // 恰 4 处明喻：阈 4 → 不报（= 不漏报也不误报的临界）；阈 3 → 报
  expect(checkSimile(body, 4).items).toHaveLength(0)
  const over = checkSimile(body, 3)
  expect(over.items).toHaveLength(1)
  expect(over.items[0]!.message).toContain('4')
})

// ── checkSectionCount ────────────────────────────

test('checkSectionCount: 按 ## 标题计数', () => {
  const body = '## 开头\nx\n## 铺垫\nx\n## 升级\nx\n## 反转\nx\n## 余韵\nx'
  expect(checkSectionCount(body, 5).items).toHaveLength(0)
})

test('checkSectionCount: 节数不符报黄', () => {
  const body = '## 开头\nx\n## 反转\nx' // 2 节
  expect(checkSectionCount(body, 5).items).toHaveLength(1)
})

test('checkSectionCount: 无标题不按自然段计节，只提示补五段标题', () => {
  const body = '段一\n\n段二\n\n段三' // 3 段
  const r = checkSectionCount(body, 5)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.checkId).toBe('section-count-heading-missing')
  expect(r.items[0]!.message).toContain('不按自然段计节')
})

test('RB-KN-P2-7: 仅 1 个 ## 标题 → 文案如实（检测到 1 个，不再误称「未使用 ##」）', () => {
  const r = checkSectionCount('## 开头\n只有一段标题的正文', 5)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.checkId).toBe('section-count-heading-missing')
  expect(r.items[0]!.message).toContain('仅检测到 1 个')
  expect(r.items[0]!.message).not.toContain('未使用')
})

// ── checkOpeningNoEnv ────────────────────────────

test('checkOpeningNoEnv: 开头无环境通过', () => {
  expect(checkOpeningNoEnv('他推开门，血溅了一地。').items).toHaveLength(0)
})

test('checkOpeningNoEnv: 开头有环境报黄', () => {
  const r = checkOpeningNoEnv('阳光洒在街道上，一切如常。他推开门。')
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.message).toContain('阳光')
})

test('checkOpeningNoEnv: 常见天气变体纳入环境词', () => {
  const r = checkOpeningNoEnv('乌云压下来，狂风卷着雨点。他推开门。')
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.message).toContain('乌云')
})

// ── checkPieceListForm（清单形式检）──────────────

test('checkPieceListForm: 完整清单通过', () => {
  const list: PieceList = {
    反转线索表: {
      核心反转: 'x',
      铺垫点: [
        { 位置: 'a', 内容: 'x' },
        { 位置: 'b', 内容: 'x' },
        { 位置: 'c', 内容: 'x' },
      ],
    },
    情绪曲线: [
      { 段落: '开头钩子', 情绪: '惊悚', 强度: 3 },
      { 段落: '铺垫', 情绪: '疑惧', 强度: 5 },
      { 段落: '升级', 情绪: '紧张', 强度: 7 },
      { 段落: '反转', 情绪: '震惊', 强度: 9 },
      { 段落: '余韵', 情绪: '后怕', 强度: 6 },
    ],
    伏笔回收: [{ 伏笔: 'y', 回收位置: 'z' }],
  }
  expect(checkPieceListForm(list).items).toHaveLength(0)
})

test('checkPieceListForm: 铺垫<3 报黄', () => {
  const list: PieceList = {
    反转线索表: { 核心反转: 'x', 铺垫点: [{ 位置: 'a', 内容: 'x' }] },
    伏笔回收: [],
  }
  const r = checkPieceListForm(list)
  expect(r.items.some((i) => i.checkId === 'manifest-setup-short')).toBe(true)
})

test('checkPieceListForm: 待定/待补占位不算有效内容', () => {
  const list: PieceList = {
    反转线索表: {
      核心反转: '待定',
      铺垫点: [
        { 位置: '开头钩子', 内容: '待补' },
        { 位置: '铺垫', 内容: '待补' },
        { 位置: '升级', 内容: '待补' },
      ],
    },
    情绪曲线: [
      { 段落: '开头钩子', 情绪: '待定', 强度: 1, 说明: '待补' },
      { 段落: '铺垫', 情绪: '待定', 强度: 3, 说明: '待补' },
      { 段落: '升级', 情绪: '待定', 强度: 5, 说明: '待补' },
      { 段落: '反转', 情绪: '待定', 强度: 9, 说明: '待补' },
      { 段落: '余韵', 情绪: '待定', 强度: 6, 说明: '待补' },
    ],
    伏笔回收: [],
  }
  const ids = checkPieceListForm(list).items.map((i) => i.checkId)
  expect(ids).toContain('manifest-no-reversal')
  expect(ids).toContain('manifest-setup-short')
  expect(ids).toContain('emotion-curve-short')
})

test('checkPieceListForm: 情绪曲线缺反转或峰值不足报黄', () => {
  const list: PieceList = {
    反转线索表: {
      核心反转: 'x',
      铺垫点: [
        { 位置: 'a', 内容: 'x' },
        { 位置: 'b', 内容: 'x' },
        { 位置: 'c', 内容: 'x' },
      ],
    },
    情绪曲线: [
      { 段落: '开头钩子', 情绪: '惊悚', 强度: 3 },
      { 段落: '铺垫', 情绪: '疑惧', 强度: 4 },
      { 段落: '升级', 情绪: '紧张', 强度: 6 },
      { 段落: '揭示', 情绪: '震惊', 强度: 7 },
      { 段落: '余韵', 情绪: '后怕', 强度: 5 },
    ],
    伏笔回收: [],
  }
  const ids = checkPieceListForm(list).items.map((i) => i.checkId)
  expect(ids).toContain('emotion-curve-no-reversal')
  expect(ids).toContain('emotion-curve-peak-low')
})

test('checkPieceListForm: 未回收伏笔报黄', () => {
  const list: PieceList = {
    反转线索表: {
      核心反转: 'x',
      铺垫点: [
        { 位置: 'a', 内容: 'x' },
        { 位置: 'b', 内容: 'x' },
        { 位置: 'c', 内容: 'x' },
      ],
    },
    伏笔回收: [{ 伏笔: 'y', 回收位置: '', 未回收: true }],
  }
  const r = checkPieceListForm(list)
  expect(r.items.some((i) => i.checkId === 'manifest-payoff-open')).toBe(true)
})

test('checkPieceListForm: 缺核心反转报黄', () => {
  const list: PieceList = {
    反转线索表: {
      核心反转: '',
      铺垫点: [
        { 位置: 'a', 内容: 'x' },
        { 位置: 'b', 内容: 'x' },
        { 位置: 'c', 内容: 'x' },
      ],
    },
    伏笔回收: [],
  }
  const r = checkPieceListForm(list)
  expect(r.items.some((i) => i.checkId === 'manifest-no-reversal')).toBe(true)
})


// R26-43：`##` 后空白可选——`##标题` 紧排形态此前漏配，全落「未使用 ## 标注」误导文案
test('R26-43: ##标题（## 后空白可选）计入节数；带空格形态不回归', () => {
  const tight = checkSectionCount('##开头\nx\n##铺垫\nx', 5)
  expect(tight.items).toHaveLength(1)
  expect(tight.items[0]!.checkId).toBe('section-count') // 2 节 ≠ 5 → 节数黄项，非 heading-missing
  expect(checkSectionCount('## 开头\nx\n## 铺垫\nx', 5).items[0]!.checkId).toBe('section-count')
})
