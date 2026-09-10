/**
 * H-1（二轮复审）回归：learn 收割只认定稿章——草稿/在写章混入候选池会污染文风基准。
 * 判定与导出 V-P2-2 同一函数（manifest.finalizedPathSet）；旧书无清单 → 全量（降级一致）。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { learnFromBook } from '../../src/learn/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const QUALIFYING_BODY =
  '林远踏出山门，暮色四合，青石阶尽头的灯火次第亮起。玉佩在胸前微微发烫，像一颗不肯安分的心。他抬手覆上，那温度便缓缓沉下去。\n\n他忽然感到一阵锥心之痛，仿佛有旧事在血里翻身。'

function makeBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'learn-final-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\n', 'utf-8')
  writeFileSync(
    join(root, '写作', '正文', '0001-草稿章.md'),
    `---\n章号: 1\n标题: 草稿章\n---\n${QUALIFYING_BODY}`,
    'utf-8',
  )
  writeFileSync(
    join(root, '写作', '正文', '0002-定稿章.md'),
    `---\n章号: 2\n标题: 定稿章\n---\n${QUALIFYING_BODY}`,
    'utf-8',
  )
  return root
}

test('H-1: 无清单（旧书降级）→ 全量收割（草稿也收，与导出口径一致）', async () => {
  const root = makeBook()
  try {
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sampleCount).toBeGreaterThan(0)
      expect(r.skippedDrafts).toBe(0)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('H-1: 有清单 → 草稿章被跳过，只有定稿章进候选池', async () => {
  const root = makeBook()
  try {
    writeFileSync(
      join(root, '项目', '文档清单.jsonl'),
      [
        JSON.stringify({ version: 1, type: 'header' }),
        JSON.stringify({ id: 'd1', nodeType: 'document', path: '写作/正文/0001-草稿章.md', parentId: null }),
        JSON.stringify({
          id: 'd2',
          nodeType: 'document',
          path: '写作/正文/0002-定稿章.md',
          parentId: null,
          finalizedRevision: 'sha256:x',
        }),
      ].join('\n') + '\n',
      'utf-8',
    )
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sampleCount).toBeGreaterThan(0)
      expect(r.skippedDrafts).toBe(1)
      // 候选全部来自定稿章（章号 2），草稿章（章号 1）零候选
      for (const s of r.samples ?? []) expect(s.章号).toBe(2)
      for (const q of r.quotes ?? []) expect(q.章号).toBe(2)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('H-1: 全部是草稿 → 没有定稿正文可收割（400 口径的内核来源）', async () => {
  const root = makeBook()
  try {
    writeFileSync(
      join(root, '项目', '文档清单.jsonl'),
      [
        JSON.stringify({ version: 1, type: 'header' }),
        JSON.stringify({ id: 'd1', nodeType: 'document', path: '写作/正文/0001-草稿章.md', parentId: null }),
      ].join('\n') + '\n',
      'utf-8',
    )
    const r = await learnFromBook(root)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/没有定稿正文/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A5（五十九轮）回归：金句候选按章号倒序再取 top5——原 slice 直接取章节序最前 5 条，
// 候选系统性偏旧（每章一条合格金句时 top5 恒为第 1-5 章，第 6/7 章永不可入池）。
test('A5: 金句 top5 按章号倒序取最新候选（不再系统性偏旧）', async () => {
  const root = makeBook()
  try {
    // makeBook 已有第 1/2 章；补第 3-7 章（每章 1 条合格金句，共 7 条候选）
    for (let n = 3; n <= 7; n++) {
      writeFileSync(
        join(root, '写作', '正文', `000${n}-定稿章${n}.md`),
        `---\n章号: ${n}\n标题: 定稿章${n}\n---\n${QUALIFYING_BODY}`,
        'utf-8',
      )
    }
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.quoteCount).toBe(5)
      const nums = (r.quotes ?? []).map((q) => q.章号)
      // 最新 5 章（3-7）占据名额，第 1/2 章不再凭章节序靠前霸位
      for (const n of nums) expect(n).toBeGreaterThanOrEqual(3)
      expect(nums).toContain(7)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** R72-2（二十轮 A-1）大书 fixture：30 章 × 150 段合格正文（≈270KB），收割同步段足够
 *  长（>10ms），让「定时器能否插入」的计数断言与收割体量解耦（小书收割 <1ms 时新旧
 *  实现都可能 0 探测，无区分度）。 */
function makeBigBook(): string {
  const root = makeBook()
  const para = '林远踏出山门，暮色四合，青石阶尽头的灯火次第亮起，玉佩在胸前微微发烫，像一颗不肯安分的心。'.repeat(2)
  for (let n = 3; n <= 30; n++) {
    const body = Array.from({ length: 150 }, () => para).join('\n\n')
    writeFileSync(
      join(root, '写作', '正文', `${String(n).padStart(4, '0')}-定稿章${n}.md`),
      `---\n章号: ${n}\n标题: 定稿章${n}\n---\n${body}`,
      'utf-8',
    )
  }
  return root
}

// R72-2（二十轮 A-1）回归：收割期间事件循环不再被整段占死——旧同步实现下 await
// 求值即同步跑完全书（数千段正则打分），定时器全程饿死 probes 必为 0；async 化后
// 逐章 yield（setImmediate），1ms 心跳必然获得调度机会。计数断言（0 vs ≥1）无阈值
// 调参，对慢机不敏感。
test('R72-2: 收割期间定时器可插入（事件循环不再被长时阻塞）', async () => {
  const root = makeBigBook()
  let probes = 0
  const t = setInterval(() => {
    probes++
  }, 1)
  try {
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true)
    expect(r.sampleCount).toBeGreaterThan(0)
  } finally {
    clearInterval(t)
  }
  expect(probes).toBeGreaterThan(0)
}, 15_000)

// ── R55-D-2（五十五轮）：收割打分 checkRepeat 透传书级阈值 ─────────────────
// 头注口径「扣分项来自 #10 机检，作者调阈值能直接影响打分」此前对 checkRepeat 不成立：
// scoreByChecks 裸调用落引擎默认 0.15/200（机检链 runner 同函数已透传书级阈值），作者
// 在 book.yaml checks 调宽松阈值后收割打分仍按默认扣分漂移。fixture 用同一句重复 3 次
// 的复读块（8-gram 重复率 ≈2/3，超引擎默认 0.15、不超放宽阈值 0.99）钉两阈值透传。
const REPEAT_BODY = '他忽然感到一阵锥心之痛，仿佛有旧事在血里翻身。'.repeat(3)

function makeBookWithChecks(checksYaml: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'learn-threshold-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    `spec_version: 1\nkind: long\nbook:\n  title: 测试书\n${checksYaml}`,
    'utf-8',
  )
  writeFileSync(
    join(root, '写作', '正文', '0001-定稿章.md'),
    `---\n章号: 1\n标题: 定稿章\n---\n${REPEAT_BODY}`,
    'utf-8',
  )
  return root
}

test('R55-D-2: config 设宽松复读阈值 → 打分按书级阈值生效（不再按引擎默认扣分）', async () => {
  const loose = makeBookWithChecks('checks:\n  repeat_threshold: 0.99\n  repeat_chars_threshold: 999999\n')
  const strict = makeBookWithChecks('')
  try {
    const rLoose = await learnFromBook(loose)
    const rStrict = await learnFromBook(strict)
    expect(rLoose.ok && rStrict.ok).toBe(true)
    if (!rLoose.ok || !rStrict.ok) return
    // 同一正文：checkStyleMetrics 扣分两书相同，差值只来自 checkRepeat
    expect(rStrict.samples).toHaveLength(1) // 复读率超引擎默认 0.15 → yellow 扣 10
    expect(rLoose.samples).toHaveLength(1) // 宽松阈值下不复读扣分，仍过 60 分低分过滤
    const looseScore = rLoose.samples?.[0]?.打分
    const strictScore = rStrict.samples?.[0]?.打分
    expect(strictScore).toBeDefined()
    expect(looseScore).toBe(strictScore! + 10)
  } finally {
    rmSync(loose, { recursive: true, force: true })
    rmSync(strict, { recursive: true, force: true })
  }
})

test('R55-D-2: config 未设 checks → 引擎默认口径不变（复读块仍被扣 10 分）', async () => {
  const root = makeBookWithChecks('')
  try {
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.samples).toHaveLength(1)
    // 复读率 ≈2/3 超引擎默认 0.15 → -10；checkStyleMetrics 对该块零扣分 → 90
    expect(r.samples?.[0]?.打分).toBe(90)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R-P3-3（评审修复批）：chapterBodies 全书数组改单遍流式逐章消费 ──────────
// 原实现把全书正文累积成数组、样章/金句两环各遍历一次（大书峰值内存 = 全书正文）；
// 现合并为单遍：每章读一次、章内同完成两路提取。本用例在定稿/草稿交错的多章书上
// 钉等价面：两路候选的章归属与正文内容逐章对应（章间零串染）、草稿跳过计数、
// 金句 top5 章号倒序口径不变。内存峰值断言（heapUsed 差）受 GC 采样噪声影响
// 不可靠，不加——流式化证据 = chapterBodies 数组已不存在 + 本等价面 + R72-2 大书
// 事件循环用例走合并后单遍路径全绿。
const CH1_MARK = '甲字号'
const CH3_MARK = '丙字号'
const DRAFT_MARK = '乙字号'

/** 单章正文：样章合格段（≥50 字，含章标记）+ 金句合格句（10-50 字，钩子+情绪，含章标记） */
function markedBody(mark: string): string {
  const para = '林远踏出山门，暮色四合，青石阶尽头的灯火次第亮起。'.repeat(2) + `${mark}火光未熄。`
  const quote = `${mark}之下，他忽然感到一阵锥心之痛。`
  return `${para}\n\n${quote}`
}

test('R-P3-3: 单遍流式——多章混合书上两路候选逐章对应、草稿跳过、章间零串染', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'learn-stream-'))
  try {
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    mkdirSync(join(root, '项目'), { recursive: true })
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\n', 'utf-8')
    // 第 1 章（定稿·甲）、第 2 章（草稿·乙）、第 3 章（定稿·丙）
    writeFileSync(join(root, '写作', '正文', '0001-定稿章.md'), `---\n章号: 1\n标题: 定稿章\n---\n${markedBody(CH1_MARK)}`, 'utf-8')
    writeFileSync(join(root, '写作', '正文', '0002-草稿章.md'), `---\n章号: 2\n标题: 草稿章\n---\n${markedBody(DRAFT_MARK)}`, 'utf-8')
    writeFileSync(join(root, '写作', '正文', '0003-定稿章.md'), `---\n章号: 3\n标题: 定稿章\n---\n${markedBody(CH3_MARK)}`, 'utf-8')
    writeFileSync(
      join(root, '项目', '文档清单.jsonl'),
      [
        JSON.stringify({ version: 1, type: 'header' }),
        JSON.stringify({ id: 'd1', nodeType: 'document', path: '写作/正文/0001-定稿章.md', parentId: null, finalizedRevision: 'sha256:x' }),
        JSON.stringify({ id: 'd2', nodeType: 'document', path: '写作/正文/0002-草稿章.md', parentId: null }),
        JSON.stringify({ id: 'd3', nodeType: 'document', path: '写作/正文/0003-定稿章.md', parentId: null, finalizedRevision: 'sha256:y' }),
      ].join('\n') + '\n',
      'utf-8',
    )
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.skippedDrafts).toBe(1)
    // 两路候选均只出自定稿章，且候选正文携带所属章标记（单遍流式无章间串染）
    const markOf = (n: number): string => (n === 1 ? CH1_MARK : n === 3 ? CH3_MARK : DRAFT_MARK)
    expect(r.sampleCount).toBeGreaterThanOrEqual(2)
    for (const s of r.samples ?? []) {
      expect([1, 3]).toContain(s.章号)
      expect(s.正文).toContain(markOf(s.章号))
    }
    expect(r.quoteCount).toBe(2)
    for (const q of r.quotes ?? []) {
      expect([1, 3]).toContain(q.章号)
      expect(q.正文).toContain(markOf(q.章号))
    }
    // A5 口径保持：金句按章号倒序（最新章在前）
    expect((r.quotes ?? []).map((q) => q.章号)).toEqual([3, 1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R0910-W：候选池循环内有界化（容量 = 终取数 ×2）━━━━━━━━━━━━━━━━━━
// 原实现全书 push、末了才 slice（大书峰值 O(全书)）。现循环内即保有界 top-N 池，
// 结果须与全量稳定排序后 slice 逐位一致。此处用超过池容量的章数（12 章 × 1 金句）
// 真实走一遍裁剪路径，钉金句 top5 仍为最新 5 章（章号倒序）。
test('R0910-W: 候选数超池容量后裁剪——金句 top5 仍为最新 5 章（章号倒序）', async () => {
  const root = makeBook() // 含第 1/2 章
  try {
    for (let n = 3; n <= 12; n++) {
      writeFileSync(
        join(root, '写作', '正文', `${String(n).padStart(4, '0')}-定稿章${n}.md`),
        `---\n章号: ${n}\n标题: 定稿章${n}\n---\n${QUALIFYING_BODY}`,
        'utf-8',
      )
    }
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 12 条金句候选 > QUOTE_POOL_CAP(10)，裁剪路径生效；终取 top5 = 最新 5 章
    expect(r.quoteCount).toBe(5)
    expect((r.quotes ?? []).map((q) => q.章号)).toEqual([12, 11, 10, 9, 8])
    // 样章候选同章多条，裁剪后恰为容量上限 top10
    expect(r.sampleCount).toBe(10)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

