/**
 * RAG 召回规模界值基准 —— 200 万字目标场景（y 轮观察第 3 条落地，批次 G4）。
 *
 * 量化 store.ts「全表读 + 内存余弦 topK」在目标规模（200 万字 / 700 章 / ~3.5 万块 /
 * 1536 维，对齐 text-embedding-3-small）下的一次召回耗时，给后来者判断是否需要
 * FTS/向量索引的依据（界值内明确不引索引——量化结论同步 store.ts readAllChunks 注释）。
 *
 * 构造走真实 buildIndex 增量路径（分批入库，批内 embed 桩输出确定性伪向量，不联网）；
 * 断言一次召回耗时 < 界值 + topK 语义不破坏（植入的唯一段落必为 top1、分数 ≈ 1、
 * 降序、≤ topK、偏移精确命中原文）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recall } from '../../src/rag/index.js'
import { openRagDb } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'
import type { RecallHit } from '../../src/rag/index.js'

// A3（批 7）：数正文整读次数——惰性指纹校验的回归锚（旧口径每次召回全量校验 700 章）
vi.mock('../../src/format/frontmatter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/format/frontmatter.js')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
import { readFile } from '../../src/format/frontmatter.js'
const readFileMock = vi.mocked(readFile)

// ── 规模参数（200 万字目标场景）──────────────────────────────────────
/** 章数：700 章 × ~2850 字 ≈ 200 万字（网文单章 2000~4000 字取中） */
const CHAPTERS = 700
/** 每章目标正文字符数 */
const CHARS_PER_CHAPTER = 2850
/** 伪向量维度：对齐 text-embedding-3-small 实际维度，线性扫描成本不失真 */
const VECTOR_DIM = 1536
/** 植入唯一段落的章（用于验证 topK 语义：同向量召回必为 top1） */
const PLANTED_CHAPTER = 350
/** 植入段在章正文中的标记前缀（全库唯一，保证 top1 无歧义） */
const PLANTED_MARKER = '锚点段落甲乙丙丁'

// ── 界值 ────────────────────────────────────────────────────────────
/**
 * 一次召回耗时上界（ms）。实测（Apple Silicon 本机，2026-08）：~3.5 万块 / 1536 维
 * 单次召回 320~350ms。界值 = 本机 ×12 ≈ 4000：原 ×6（2000ms）按 2026-08-22 之前
 * 的 CI 代际校准，当日 ubuntu · Node 24 连续两轮 CI 实测 2140ms（三次取最小仍红，
 * run 32515282093 / 32562903911）——共享 runner 整体变慢（本机基线未变、算法无退化，
 * 本地全量 2879 用例含本文件全绿），×6 余量耗尽，复校为 ×12。
 * 注：单规模点计时只能给墙钟预算、判不了复杂度阶；真要守「超线性退化」需块数-耗时
 * 斜率护栏，届时另立——界值失败先对照本机基线，同涨才是算法问题。
 */
const RECALL_BOUND_MS = 4_000

/** 造词池（确定性文本生成用，内容语义不影响测试——向量由文本哈希决定） */
const WORDS = ['山峦', '风雪', '剑光', '长街', '灯火', '故人', '旧梦', '孤城', '烟雨', '残阳', '铁骑', '夜色', '荒原', '潮声', '星火']

/** FNV-1a 字符串哈希（确定性，跨运行/跨平台一致） */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 确定性 PRNG */
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

/** 文本 → 确定性归一化伪向量（同文本必同向量，嵌入语义由召回断言另验） */
function pseudoVec(text: string): Float32Array {
  const rng = mulberry32(fnv1a(text))
  const v = new Float32Array(VECTOR_DIM)
  let norm = 0
  for (let i = 0; i < VECTOR_DIM; i++) {
    const x = rng() * 2 - 1
    v[i] = x
    norm += x * x
  }
  const inv = 1 / Math.sqrt(norm)
  for (let i = 0; i < VECTOR_DIM; i++) v[i] = v[i]! * inv
  return v
}

/** embed 桩：确定性伪向量，不联网（buildIndex/recall 的注入点） */
function stubEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(texts.map((t) => Array.from(pseudoVec(t))))
}

/** 生成一章正文：40~130 字/段、双空行分段，含可选植入段（返回正文 + 植入信息） */
function makeChapterBody(
  chapterNumber: number,
  plant: boolean,
): { body: string; plantedText: string | null } {
  const rng = mulberry32(chapterNumber * 2654435761)
  const paragraphs: string[] = []
  let plantedText: string | null = null
  if (plant) {
    // 植入段：全库唯一标记 + 随机词填充（< 1000 字上限，整段一块）
    const bits: string[] = [PLANTED_MARKER]
    while (bits.join('').length < 60) bits.push(WORDS[Math.floor(rng() * WORDS.length)]!)
    plantedText = bits.join('')
    paragraphs.push(plantedText)
  }
  let total = paragraphs.join('\n\n').length
  while (total < CHARS_PER_CHAPTER) {
    const bits: string[] = []
    while (bits.join('').length < 40 + Math.floor(rng() * 91)) {
      bits.push(WORDS[Math.floor(rng() * WORDS.length)]!)
    }
    paragraphs.push(bits.join(''))
    total = paragraphs.join('\n\n').length
  }
  return { body: paragraphs.join('\n\n'), plantedText }
}

describe('RAG 召回规模界值（200 万字目标场景）', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-scale-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  it('200 万字 / 1536 维：一次召回 < 界值，topK 语义不破坏', { timeout: 300_000 }, async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'bench-model' }

    // ── 构造：700 章 ~200 万字，走真实 buildIndex 增量路径分批入库 ──
    // 分批（100 章/批）控 embed 桩的瞬时内存（每批 ~3 千块 × 1536 维 number[]）。
    const BATCH = 100
    let plantedText = ''
    let totalChars = 0
    for (let batchStart = 1; batchStart <= CHAPTERS; batchStart += BATCH) {
      for (let n = batchStart; n < batchStart + BATCH && n <= CHAPTERS; n++) {
        const { body, plantedText: p } = makeChapterBody(n, n === PLANTED_CHAPTER)
        if (p) plantedText = p
        totalChars += body.length
        const meta: ChapterMeta = {
          章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
          _path: '', _wordCount: 0,
        }
        writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta, body)
      }
      const r = await buildIndex(bookRoot, config, 'stub-key', stubEmbed)
      expect(r.ok, `buildIndex 批 ${batchStart} 失败：${r.error}`).toBe(true)
    }
    expect(totalChars).toBeGreaterThan(1_900_000) // 规模前提：确在 200 万字量级

    // 库内块数（规模数据点，随汇报口径）
    const chunkCount = (() => {
      const db = openRagDb(bookRoot)
      try {
        return (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
      } finally {
        db.close()
      }
    })()
    expect(chunkCount).toBeGreaterThan(20_000) // ~2 万+ 块规模前提

    // ── 召回正确性：植入唯一段（自向量余弦 = 1）必为 top1，偏移精确命中 ──
    const hits = await recall(bookRoot, config, 'stub-key', plantedText, 5, stubEmbed)
    expect(hits.length).toBe(5) // 库内块数 >> topK，应满额返回
    expect(hits[0]!.章号).toBe(PLANTED_CHAPTER)
    expect(hits[0]!.start_offset).toBe(0) // 植入段是章首段，偏移精确
    expect(hits[0]!.score).toBeGreaterThan(0.999) // 同向量余弦 ≈ 1
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score) // 降序
      expect(hits[i]!.score).toBeLessThan(hits[0]!.score) // 无并列歧义
    }

    // ── A3（批 7）：惰性指纹校验——单次召回正文文件整读 ≤ K'（20）────
    // 旧口径：召回前对全部已索引章逐个读文件校验 SHA-256（700 次整读）；
    // 新口径：排序后只校验命中候选章（topK 涉及 ≤ 5 章 + 同章去重）
    readFileMock.mockClear()
    const lazyHits = await recall(bookRoot, config, 'stub-key', plantedText, 5, stubEmbed)
    expect(lazyHits.length).toBe(5)
    const bodyFileReads = readFileMock.mock.calls.filter((args) =>
      String(args[0]).includes(join('写作', '正文')),
    ).length
    expect(bodyFileReads).toBeLessThanOrEqual(20)
    readFileMock.mockClear()

    // ── 耗时界值：3 次取最小（去冷启动/页缓存噪声），断言 < 界值 ──
    const durations: number[] = []
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      const again: RecallHit[] = await recall(bookRoot, config, 'stub-key', plantedText, 5, stubEmbed)
      durations.push(performance.now() - t0)
      expect(again.length).toBe(5)
    }
    const best = Math.min(...durations)
    // eslint-disable-next-line no-console
    console.log(
      `[rag-scale] ${CHAPTERS} 章 / ${(totalChars / 10000).toFixed(1)} 万字 / ${chunkCount} 块 / ${VECTOR_DIM} 维` +
      `｜召回耗时 3 次：${durations.map((d) => d.toFixed(0) + 'ms').join('、')}（取最小 ${best.toFixed(0)}ms）` +
      `｜rag.db ${((statSync(join(bookRoot, '.cache', 'rag.db')).size) / 1024 / 1024).toFixed(1)}MB`,
    )
    expect(best).toBeLessThan(RECALL_BOUND_MS)
  })
})
