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
