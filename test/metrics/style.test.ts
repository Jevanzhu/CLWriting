import { test, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeFullStats,
  computeSentenceLenVariance,
  computeRepeatRate,
  readChapterBody,
  scanLongChapters,
  scanShortPieces,
  aggregateStyleTrend,
  formatStyleReport,
  freezeBaseline,
  readBaseline,
  baselinePath,
  width,
} from '../../src/metrics/style.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { writeChapter } from '../../src/format/chapters.js'
import { writeSample } from '../../src/format/style.js'
import { parseIronRules, type IronRules } from '../../src/check/count.js'
import type { ChapterMeta } from '../../src/format/types.js'

const TAG_RULES = parseIronRules('对话标签占比: 50%')
const FULL_RULES = parseIronRules([
  '单句上限字数: 30',
  '形容词连续堆叠上限: 2',
  '对话标签占比: 50%',
  '排比连续数: 2',
  '结尾总结体: 禁止',
].join('\n'))

// ── 纯统计函数 ─────────────────────────────────────

test('computeFullStats: 各维度数值正确（正常短文无超标）', () => {
  const body = '林晚走进雪里。北风呼啸。他握紧刀柄。'
  const stats = computeFullStats(body, FULL_RULES)
  expect(stats.overlongRatio).toBe(0) // 无超 30 字句
  expect(stats.adjStackHits).toBe(0)
  expect(stats.summaryEnding).toBe(false)
  expect(stats.sentenceLenVariance).toBeGreaterThan(0)
  expect(stats.repeatRate).toBe(0) // 无重复
})

test('computeSentenceLenVariance: 句长方差口径（与 count.ts 同切句）', () => {
  const body = '短句。这是一个中等长度的句子。这里有一个特别特别特别特别特别长的句子用来拉高方差。'
  const v = computeSentenceLenVariance(body)
  expect(v).toBeGreaterThan(0)
})

test('computeRepeatRate: 重复句计入复读率', () => {
  const body = '北风呼啸而过。北风呼啸而过。他走着。'
  // 句子（≥6字）：北风呼啸而过 ×2、他走着（4字不计）
  // repeatInstances = 2-1 = 1, sentences=2 → 0.5
  expect(computeRepeatRate(body)).toBeCloseTo(0.5, 5)
})

test('computeFullStats: 对话标签占比 = 被标签对话行 / 对话行数', () => {
  const body = [
    '「你来了。」林晚说。',
    '「我来了。」', // 无标签
  ].join('\n')
  const stats = computeFullStats(body, TAG_RULES)
  expect(stats._dialogueLines).toBe(2)
  expect(stats.dialogueTagRatio).toBeCloseTo(0.5, 5) // 1/2
})

test('computeFullStats: 形容词堆叠去重命中数', () => {
  const body = '美丽的温柔的善良的少女走来。'
  const stats = computeFullStats(body, FULL_RULES) // maxAdjStack=2 → 3个连续的 算命中
  expect(stats.adjStackHits).toBeGreaterThan(0)
})

// ── readChapterBody ────────────────────────────────

test('readChapterBody: 正确剥 front matter 取正文', () => {
  const root = mkdtempSync(join(tmpdir(), 'style-body-'))
  const dir = join(root, '定稿', '正文')
  mkdirSync(dir, { recursive: true })
  const ch: ChapterMeta = { 章号: 1, 标题: '一', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  const fp = join(dir, '1-一.md')
  writeChapter(fp, ch, '这是正文内容。')
  const body = readChapterBody({ ...ch, _path: fp })
  expect(body).toBe('这是正文内容。')
  rmSync(root, { recursive: true, force: true })
})

// ── 长篇重扫 + 漂移识别（出口验收：50 章后段漂移）──

/** 造 N 章定稿正文，后 K 章对话标签占比人为拉高（漂移段） */
function makeLongBookWithDrift(total: number, driftStart: number): string {
  const root = mkdtempSync(join(tmpdir(), 'style-drift-'))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '对话标签占比: 50%', 'utf-8')
  const dir = join(root, '定稿', '正文')
  mkdirSync(dir, { recursive: true })
  for (let n = 1; n <= total; n++) {
    const ch: ChapterMeta = { 章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
    let body: string
    if (n >= driftStart) {
      // 漂移段：对话行全带标签 → 占比 100%
      body = '「你来了。」他说。\n「我走了。」他道。\n「再见。」他答。'
    } else {
      // 正常段：无标签对话 → 占比 0
      body = '「你来了。」\n「我走了。」\n雪落无声。'
    }
    writeChapter(join(dir, `${n}-第${n}章.md`), ch, body)
  }
  return root
}

test('scanLongChapters: 逐章采样，按章号排序', () => {
  const root = makeLongBookWithDrift(5, 999) // 无漂移
  const samples = scanLongChapters(root)
  expect(samples).toHaveLength(5)
  expect(samples.map((s) => s.num)).toEqual([1, 2, 3, 4, 5])
  rmSync(root, { recursive: true, force: true })
})

test('aggregateStyleTrend: 后段对话标签拉高 → 识别漂移信号', () => {
  // 10 章，后 5 章漂移（窗口 5，便于测试不造 50 章）
  const root = makeLongBookWithDrift(10, 6)
  const samples = scanLongChapters(root)
  const trend = aggregateStyleTrend(samples, 'long', null, { driftWindow: 5 })
  // 后 5 章（6-10）对话标签占比 100% > 50%，连续 5 章超阈 → 应报漂移
  expect(trend.drifts.length).toBeGreaterThan(0)
  expect(trend.drifts.some((d) => d.message.includes('对话标签'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('aggregateStyleTrend: 无漂移的正常章 → 不报漂移', () => {
  const root = makeLongBookWithDrift(10, 999)
  const samples = scanLongChapters(root)
  const trend = aggregateStyleTrend(samples, 'long', null, { driftWindow: 5 })
  expect(trend.drifts.filter((d) => d.message.includes('对话标签'))).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('aggregateStyleTrend: 基线存在时漂移阈值用基线对照值', () => {
  const root = makeLongBookWithDrift(10, 6)
  const samples = scanLongChapters(root)
  // 基线对话标签占比很低 → 阈值被抬高到 max(0.2*1.3, 0.5)=0.5，后段 100% 仍超
  const baseline = {
    version: 1, frozenAt: 't', frozenFrom: 'test',
    byScene: {},
    overall: { overlongRatio: 0, adjStackHits: 0, dialogueTagRatio: 0.2, parallelStreakMax: 0, summaryEnding: false, sentenceLenVariance: 10, repeatRate: 0.05, _dialogueLines: 0 },
  }
  const trend = aggregateStyleTrend(samples, 'long', baseline, { driftWindow: 5 })
  expect(trend.drifts.some((d) => d.message.includes('对话标签'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('formatStyleReport: 空样本 → 友好提示', () => {
  const trend = aggregateStyleTrend([], 'long', null)
  expect(formatStyleReport(trend)).toContain('尚无已定稿正文')
})

test('formatStyleReport: 无基线 → 标注"仅绝对值"', () => {
  const root = makeLongBookWithDrift(6, 999)
  const samples = scanLongChapters(root)
  const trend = aggregateStyleTrend(samples, 'long', null)
  const out = formatStyleReport(trend)
  expect(out).toContain('无基线')
  rmSync(root, { recursive: true, force: true })
})

test('formatStyleReport: 含全角括号（…）的行与不含的行标记列对齐（#2 width 补全角标点）', () => {
  // 造有超限 + 无超限的样本：格式化后「单句超限」行含全角括号（如 `1/2 章（50%）`），
  // 「对话标签占比」行不含。各行结尾的 ⚠/✓ 标记应在同一显示列（按显示宽度，非字符数）。
  const root = mkdtempSync(join(tmpdir(), 'style-width-'))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'),
    '单句上限字数: 4\n形容词连续堆叠上限: 2\n对话标签占比: 50%\n排比连续数: 2\n结尾总结体: 禁止', 'utf-8')
  const dir = join(root, '定稿', '正文')
  mkdirSync(dir, { recursive: true })
  const ch1: ChapterMeta = { 章号: 1, 标题: '甲', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  writeChapter(join(dir, '1-甲.md'), ch1, '这是一个超过四个字的句子。')
  const ch2: ChapterMeta = { 章号: 2, 标题: '乙', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  writeChapter(join(dir, '2-乙.md'), ch2, '雪落。')
  const samples = scanLongChapters(root)
  const out = formatStyleReport(aggregateStyleTrend(samples, 'long', null))

  // 取出 6 个指标行，验证 ⚠/✓ 标记的起始显示列一致（按显示宽度，非字符数）。
  const metricRows = out.split('\n').filter((l) => /[⚠✓○]/.test(l))
  expect(metricRows.length).toBe(6)
  const MARK = new Set(['✓', '⚠', '○'])
  const markCol = (l: string): number => {
    let w = 0
    for (const ch of l) {
      if (MARK.has(ch)) break
      w += width(ch) // 用源码同口径 width
    }
    return w
  }
  const markCols = metricRows.map(markCol)
  expect(new Set(markCols).size).toBe(1) // 标记列对齐
  // 含全角括号的行确实存在（否则该用例本身没覆盖到 #2）
  expect(metricRows.some((l) => l.includes('（'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('width: 全角标点/全角ASCII/全角符号算 2 宽（#2 核心断言）', () => {
  // CJK 汉字（基线，原本就该算 2）
  expect(width('汉')).toBe(2)
  // 全角括号「」、全角句号。
  expect(width('（')).toBe(2)
  expect(width('）')).toBe(2)
  expect(width('。')).toBe(2)
  // 全角 ASCII：！＃％＆（）
  expect(width('！')).toBe(2)
  expect(width('％')).toBe(2)
  // 全角符号 ￠￦
  expect(width('￠')).toBe(2)
  // 半角 ASCII 仍算 1（回归保护）
  expect(width('a')).toBe(1)
  expect(width('1')).toBe(1)
  expect(width('(')).toBe(1)
  // 半宽片假名 ｡ﾞ 不纳入，算 1（工单强调勿纳入）
  expect(width('｡')).toBe(1)
  // 组合：报告里实际出现的 `1/2 章（50%）`
  // 1 / 2 空格 章 （ 5 0 % ） = 1+1+1+1+2+2+1+1+1+2 = 13
  expect(width('1/2 章（50%）')).toBe(13)
})

test('aggregateStyleTrend: 对话标签漂移的 drift.metric === "dialogueTag"（#3 参数化不贴错标签）', () => {
  const root = makeLongBookWithDrift(10, 6)
  const samples = scanLongChapters(root)
  const trend = aggregateStyleTrend(samples, 'long', null, { driftWindow: 5 })
  const tagDrift = trend.drifts.find((d) => d.message.includes('对话标签'))
  expect(tagDrift).toBeDefined()
  expect(tagDrift!.metric).toBe('dialogueTag')
  rmSync(root, { recursive: true, force: true })
})

// ── 基线冻结（#9）──────────────────────────────────

function makeBookWithSamples(): string {
  const root = mkdtempSync(join(tmpdir(), 'style-freeze-'))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG })
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true })
  mkdirSync(join(root, '文风', '样章库', '对话'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '对话标签占比: 50%', 'utf-8')
  writeSample(join(root, '文风', '样章库', '战斗', '战斗-001.md'), {
    场景: '战斗', 来源: '作者原作', 正文: '刀光闪过。他挥剑。鲜血飞溅。敌人倒下。',
  })
  writeSample(join(root, '文风', '样章库', '对话', '对话-001.md'), {
    场景: '对话', 来源: '作者原作', 正文: '「你来了。」\n「我来了。」\n两人对视。',
  })
  return root
}

test('freezeBaseline: 有样章 → 生成基线.json 含各场景 + overall', () => {
  const root = makeBookWithSamples()
  expect(existsSync(baselinePath(root))).toBe(false)
  const baseline = freezeBaseline(root)
  expect(existsSync(baselinePath(root))).toBe(true)
  expect(Object.keys(baseline.byScene).sort()).toEqual(['对话', '战斗'])
  expect(baseline.overall.sentenceLenVariance).toBeGreaterThan(0)
  rmSync(root, { recursive: true, force: true })
})

test('freezeBaseline: 幂等重跑（覆盖，learn 新样章后指纹变）', () => {
  const root = makeBookWithSamples()
  freezeBaseline(root)
  const b1 = readBaseline(root)!
  expect(b1.byScene['战斗']).toBeDefined()
  // 再加一个战斗样章 → overall 字符总量变，复读率指纹应随之更新
  writeSample(join(root, '文风', '样章库', '战斗', '战斗-002.md'), {
    场景: '战斗', 来源: '导入', 正文: '第二场战斗完全不同的节奏内容，剑气纵横千里。',
  })
  const varianceBefore = b1.overall.sentenceLenVariance
  freezeBaseline(root)
  const b2 = readBaseline(root)!
  // 重跑不崩 + 内容可更新（方差随新样章变化）
  expect(b2.byScene['战斗']).toBeDefined()
  expect(b2.overall.sentenceLenVariance).not.toBe(varianceBefore)
  rmSync(root, { recursive: true, force: true })
})

test('freezeBaseline: 空样章库 → 报错不写文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'style-empty-'))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG })
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true }) // 空场景目录
  expect(() => freezeBaseline(root)).toThrow(/样章库为空/)
  expect(existsSync(baselinePath(root))).toBe(false) // 不写空文件
  rmSync(root, { recursive: true, force: true })
})

test('freezeBaseline: 样章文件无 场景 front matter → 提示样章格式', () => {
  const root = mkdtempSync(join(tmpdir(), 'style-bad-sample-'))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG })
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true })
  writeFileSync(join(root, '文风', '样章库', '战斗', '战斗-001.md'), '只有正文，没有 front matter', 'utf-8')
  expect(() => freezeBaseline(root)).toThrow(/front matter.*场景/)
  expect(existsSync(baselinePath(root))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('freezeBaseline: 样章库目录不存在 → 报错', () => {
  const root = mkdtempSync(join(tmpdir(), 'style-nodir-'))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG })
  expect(() => freezeBaseline(root)).toThrow(/样章库目录不存在/)
  rmSync(root, { recursive: true, force: true })
})

test('readBaseline: 文件不存在 → null（重扫降级为仅绝对值）', () => {
  const root = mkdtempSync(join(tmpdir(), 'style-nobase-'))
  expect(readBaseline(root)).toBeNull()
  rmSync(root, { recursive: true, force: true })
})

// ── 短篇适配（#10）─────────────────────────────────

function makeShortBook(pieceCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'style-short-'))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG, kind: 'short' })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '对话标签占比: 50%', 'utf-8')
  for (let n = 1; n <= pieceCount; n++) {
    const dir = join(root, '篇', `${String(n).padStart(3, '0')}-短篇${n}`)
    mkdirSync(dir, { recursive: true })
    const fm = `篇号: ${n}\n标题: 短篇${n}`
    const body = '「你来了。」他说。\n雪落无声。\n刀光闪过。'
    writeFileSync(join(dir, '正文.md'), `---\n${fm}\n---\n${body}`, 'utf-8')
  }
  return root
}

test('scanShortPieces: 扫 篇 下各目录的正文.md', () => {
  const root = makeShortBook(3)
  const samples = scanShortPieces(root)
  expect(samples).toHaveLength(3)
  expect(samples.map((s) => s.num)).toEqual([1, 2, 3])
  expect(samples[0]!.title).toBe('短篇1')
  rmSync(root, { recursive: true, force: true })
})

test('短篇: <5 篇只报明细，不做趋势判定（无漂移信号）', () => {
  const root = makeShortBook(3)
  const samples = scanShortPieces(root)
  const trend = aggregateStyleTrend(samples, 'short', null)
  expect(trend.drifts).toHaveLength(0) // 小样本不判定
  const out = formatStyleReport(trend)
  expect(out).toContain('仅报明细') // 降级提示
  rmSync(root, { recursive: true, force: true })
})

test('短篇: ≥5 篇可做趋势判定', () => {
  const root = makeShortBook(6)
  const samples = scanShortPieces(root)
  const trend = aggregateStyleTrend(samples, 'short', null, { driftWindow: 5 })
  // 6 篇 ≥ 5，进入趋势判定（是否有漂移取决于内容，这里只验证不再降级提示）
  const out = formatStyleReport(trend)
  expect(out).not.toContain('仅报明细')
  rmSync(root, { recursive: true, force: true })
})

// ── 综合：冻结基线后重扫有对照 ───────────────────

test('综合: 先冻结基线 → 重扫报告含基线对照', () => {
  const root = makeBookWithSamples()
  freezeBaseline(root)
  // 加一章定稿正文（用长篇格式，仅为验证基线读取）
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG })
  const dir = join(root, '定稿', '正文')
  mkdirSync(dir, { recursive: true })
  const ch: ChapterMeta = { 章号: 1, 标题: '一', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  writeChapter(join(dir, '1-一.md'), ch, '「来了。」他说。\n雪落。')
  const samples = scanLongChapters(root)
  const baseline = readBaseline(root)
  const trend = aggregateStyleTrend(samples, 'long', baseline)
  const out = formatStyleReport(trend)
  expect(out).toContain('基线')
  expect(trend.baseline).not.toBeNull()
  rmSync(root, { recursive: true, force: true })
})
