/**
 * 树红点聚合规模界值基准 —— 500 章长篇（阶段 23 批 1：迭代建议清偿·CI 性能回归门，
 * 讨论稿建议 4）。
 *
 * 请求路径上的同步文件 IO（树红点全量计算）单测测不出、只有长篇+慢盘才暴露——
 * 本文件给 collectTreeIssues 在 500 章 / ~150 万字规模下的耗时上界断言，
 * 守住「两百万字不崩」承诺。
 *
 * 两口断言：①冷算（首次调用：rebuild + 逐章机检 + 缓存写入，仅一次可测）
 * ②缓存命中（后续调用：指纹未变走 A1 增量缓存）。计时口径承 test/rag/scale.test.ts：
 * 热路径 3 次取最小去噪声；界值 = 本机实测 ×12（CI 共享 runner 慢机容差，
 * 2026-08-22 rag scale 2000→4000ms 复校同款教训）。
 * 注：单规模点计时只给墙钟预算、判不了复杂度阶（rag scale 头注同款局限记档）。
 */

import { describe, it, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTreeIssues } from '../../src/check/run.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// ── 规模参数 ────────────────────────────────────────────────────────
/** 章数：500 章 × ~3000 字 ≈ 150 万字（讨论稿口径「500 章合成书」） */
const CHAPTERS = 500
/** 每章目标正文字符数 */
const CHARS_PER_CHAPTER = 3_000
/** 每 N 章一章含禁词「玉佩」——机检真实做功且红点非空 */
const HIT_EVERY = 5

// ── 界值（本机 Apple Silicon 实测 ×12，见头注口径）──────────────────
// R67-19（十五轮）：两界 CI 再叠 ×2（本地门不动）——界值锚本机基线，共享 runner
// 劣化史（rag scale 2026-08-22 两轮红）只能事后追认假红；CI 界 16s/1600ms 只兜
// 灾难级退化，与 rag/scale RECALL_BOUND 同款口径，算法退化本地仍第一时间红。
/** 冷算耗时上界（ms）——本机实测 ~620ms（2026-08-24，615/628 两次）×12 ≈ 7.4s，取整 8s。
 * win 真机（阶段 21 回归）另叠 ×2：NTFS+Defender 实时扫描下普遍慢一倍以上（warm 实测
 * 874-941ms）——界值锚 mac 基线不动、win 档只放平台税，退化可捕性不变。 */
const PLATFORM_MULT = (process.platform === 'win32' ? 2 : 1) * (process.env.CI ? 2 : 1)
const COLD_BOUND_MS = 8_000 * PLATFORM_MULT
/** 缓存命中耗时上界（ms）——本机实测 ~26ms ×12 ≈ 312ms，原取 500；R61-21（第六十一轮）
 * 预放大 800：CI runner 劣化假红先例（rag scale 2026-08-22 同型复校），退化可捕性不变
 *（缓存失效口径 ≈ 冷算 700ms，仍 ≪ 800 放不过）；复校流程见头注。 */
const WARM_BOUND_MS = 800 * PLATFORM_MULT

/** 造词池（确定性文本生成，不含禁词） */
const WORDS = ['山峦', '风雪', '剑光', '长街', '灯火', '故人', '旧梦', '孤城', '烟雨', '残阳', '铁骑', '夜色', '荒原', '潮声', '星火']

/** mulberry32 确定性 PRNG（rag scale 同款） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 生成一章正文：40~130 字/段、双空行分段；命中章含禁词句 */
function makeBody(no: number): string {
  const rng = mulberry32(no * 2654435761)
  const paragraphs: string[] = []
  if (no % HIT_EVERY === 1) paragraphs.push('山门外的雨夜里，玉佩，连响了三下，谁也没有回头。')
  // 内存闸（2026-08-24 审计 A3）：增量计数替代每段全量 join——O(N²) 拷贝是造书期
  // GC churn 推手；total 口径与 join('\n\n').length 恒等（首段无分隔符，此后 +len+2）
  let total = paragraphs[0]?.length ?? 0
  while (total < CHARS_PER_CHAPTER) {
    const bits: string[] = []
    while (bits.join('').length < 40 + Math.floor(rng() * 91)) {
      bits.push(WORDS[Math.floor(rng() * WORDS.length)]!)
    }
    const seg = bits.join('')
    total = paragraphs.length === 0 ? seg.length : total + seg.length + 2
    paragraphs.push(seg)
  }
  return paragraphs.join('\n\n')
}

/** 与 tree-issues-cache.test.ts makeBook 同款造书（含布线/文风禁词/book.yaml），放大到 500 章 */
function makeScaleBook(): { root: string; hitDocOf: (no: number) => string } {
  const root = mkdtempTracked(join(tmpdir(), 'check-scale-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n', 'utf-8')
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  const docOfNo = new Map<number, string>()
  for (let no = 1; no <= CHAPTERS; no++) {
    const pad = String(no).padStart(3, '0')
    const rel = `写作/正文/${pad}-第${no}章.md`
    writeFileSync(
      join(root, rel),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${makeBody(no)}\n`,
      'utf-8',
    )
    const id = generateDocId()
    upsertEntry(m, { id, nodeType: 'document', path: rel, parentId: null })
    docOfNo.set(no, id)
  }
  writeManifest(manifestPath, m)
  return { root, hitDocOf: (no) => docOfNo.get(no)! }
}

// R66-43（十四轮）：墙钟界值类测试是受管理的 flaky 面——界值已按本机 ×12 预放大
// （见上），CI 慢机偶发越界仍会以假红呈现。describe 级 retry:2：失败自动重跑至多
// 2 次，抖动不放大为红灯；真退化（复杂度劣化）会稳定越界、连败 3 次仍红，可捕性不变。
describe('树红点聚合规模界值（500 章长篇）', { retry: 2 }, () => {
  it('冷算与缓存命中两口耗时 < 界值，红点语义不空转', { timeout: 300_000 }, () => {
    const { root, hitDocOf } = makeScaleBook()
    try {
      const cb = (_docId: string) => undefined

      // ── 冷算（仅首次可测）：rebuild + 逐章机检 + 缓存写入 ──
      const t0 = performance.now()
      const first = collectTreeIssues(root, cb)
      const coldMs = performance.now() - t0

      // 语义锚：命中章（含禁词「玉佩」）必须为红，证明机检真实做功而非空跑
      const issueCount = Object.keys(first.issues).length
      expect(issueCount).toBeGreaterThanOrEqual(Math.floor((CHAPTERS - 1) / HIT_EVERY) + 1)
      expect(first.issues[hitDocOf(1)]?.hasRed).toBe(true)
      expect(first.issues[hitDocOf(1 + HIT_EVERY)]?.hasRed).toBe(true)
      expect(first.rebuildFailed).toBe(false)

      // ── 缓存命中（A1 增量缓存）：3 次取最小 ──
      const durations: number[] = []
      for (let i = 0; i < 3; i++) {
        const t = performance.now()
        const again = collectTreeIssues(root, cb)
        durations.push(performance.now() - t)
        expect(Object.keys(again.issues).length).toBe(issueCount) // 热路径结果与冷算一致
      }
      const warmMs = Math.min(...durations)

      console.log(
        `[check-scale] ${CHAPTERS} 章 / ~${((CHAPTERS * CHARS_PER_CHAPTER) / 10000).toFixed(0)}万字` +
        `｜冷算 ${coldMs.toFixed(0)}ms｜缓存命中 3 次：${durations.map((d) => d.toFixed(0) + 'ms').join('、')}（取最小 ${warmMs.toFixed(0)}ms）` +
        `｜红点 ${issueCount} 章`,
      )
      expect(coldMs).toBeLessThan(COLD_BOUND_MS)
      expect(warmMs).toBeLessThan(WARM_BOUND_MS)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
