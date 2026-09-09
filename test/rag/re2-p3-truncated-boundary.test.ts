/**
 * 重评2-P3-4（2026-09-09 全量重评 GLM-5.3，RAG 域 P3-②）回归：truncated 边界误报。
 *
 * recallDetailed 的 truncated 旧判定 `produced > warnThreshold` 在「全表恰为
 * warnThreshold+1 行且探针行非命中」时误报 true——探针行（第 N+1 个产出行）是
 * model/维度不匹配行而未入 rows（R49-20 口径），此时零命中被丢，截断信号虚发。
 * 修复：判定对齐 R49-20 的 pop 侧口径——确实丢弃命中行（produced 超阈且探针行
 * 确为命中、被 pop）才 true。
 *
 * 边界矩阵（recallDetailed 层，真实临时书库）：
 * - 全表恰为 warnThreshold 行（无探针）→ false，hits 全保留；
 * - 全表超 warnThreshold+1 行但探针非命中 → false（未丢弃任何命中——超出扫描
 *   窗的未扫行不翻转信号，早停语义由 warn 日志承载），hits 全保留；
 * - 探针为命中（确实 pop 掉一行）→ true，hits ≤ warnThreshold。
 * 探针非命中且表恰为 N+1 的第四象限由 r49-probe-row-truncation.test.ts 锚定
 * （其 truncated 断言已随本批改 false）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, recallDetailed } from '../../src/rag/index.js'
import { openRagDb, storeChunk } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

/** 桩 embed：确定性、不联网（3 维，与 r49 先例同风格）。 */
function stubEmbed(_endpoint: string, _model: string, _key: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const code = t.charCodeAt(0) || 1
      const norm = 1 / (code + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

const CONFIG = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

const META: ChapterMeta = {
  章号: 1, 标题: '第1章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
  _path: '', _wordCount: 100,
}

/** 建临时书并写入三段正文（每段一块，共 3 块）后建索引 */
function setupBook(paragraphs: number): string {
  const bookRoot = mkdtempSync(join(tmpdir(), 'rag-re2-trunc-'))
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  const body = Array.from(
    { length: paragraphs },
    (_, i) => `第${i + 1}段正文：主角挥剑斩向暗影，剑光如匹练，映出密室深处的古卷记载。`,
  ).join('\n\n')
  writeChapter(join(bookRoot, '写作', '正文', '1-第1章.md'), META, body)
  return bookRoot
}

/** 向库追加一条不匹配 model 的行（模拟混 model 库；插入序最末） */
function appendMismatchRow(bookRoot: string): void {
  const db = openRagDb(bookRoot)
  try {
    storeChunk(db, {
      章号: 99, start_offset: 0, end_offset: 10,
      embedding: Float32Array.from([1, 0, 0]), model: 'other-model',
    })
  } finally {
    db.close()
  }
}

describe('重评2-P3-4: truncated 边界——确实丢弃命中行才 true', () => {
  let bookRoot = ''

  afterEach(() => {
    if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
    bookRoot = ''
  })

  it('全表恰为 warnThreshold 行（无探针）→ truncated=false 且 hits 全保留', async () => {
    bookRoot = setupBook(2)
    const built = await buildIndex(bookRoot, CONFIG, 'stub-key', stubEmbed)
    expect(built.ok).toBe(true)
    expect(built.chunkCount).toBe(2)
    // warnThreshold=2：produced=2 恰等于阈值，探针行（第 3 产出）不存在
    const r = await recallDetailed(bookRoot, CONFIG, 'stub-key', '剑光', 5, stubEmbed, 2)
    expect(r.truncated).toBe(false)
    expect(r.totalBlocks).toBe(2)
    expect(r.hits).toHaveLength(2)
  })

  it('全表超 warnThreshold+1 行但探针行非命中 → truncated=false（零命中被丢，不虚发截断信号）', async () => {
    bookRoot = setupBook(2)
    const built = await buildIndex(bookRoot, CONFIG, 'stub-key', stubEmbed)
    expect(built.ok).toBe(true)
    expect(built.chunkCount).toBe(2)
    // 追加两条不匹配行：表 4 行 > warnThreshold+1=3，但第 3 产出行（探针位）非命中
    // ——扫描早停在产出 3 行处，rows 内 2 条命中一条未丢
    appendMismatchRow(bookRoot)
    appendMismatchRow(bookRoot)
    const r = await recallDetailed(bookRoot, CONFIG, 'stub-key', '剑光', 5, stubEmbed, 2)
    // 旧判定 produced(3) > warnThreshold(2) 会误报 true（修复主诉场景的「表更大」变体：
    // 未扫到的第 4 行不翻转信号——是否本会命中无从判定，截断语义只对确实丢弃的命中负责）
    expect(r.truncated).toBe(false)
    expect(r.totalBlocks).toBe(3)
    expect(r.hits).toHaveLength(2)
    expect(r.hits.every((h) => h.章号 === 1)).toBe(true)
  })

  it('探针行为命中（确实 pop 掉一行）→ truncated=true 且 hits ≤ warnThreshold', async () => {
    bookRoot = setupBook(3)
    const built = await buildIndex(bookRoot, CONFIG, 'stub-key', stubEmbed)
    expect(built.ok).toBe(true)
    expect(built.chunkCount).toBe(3)
    // warnThreshold=2：produced=3（全命中），探针行（第 3 产出）为命中 → pop + true
    const r = await recallDetailed(bookRoot, CONFIG, 'stub-key', '剑光', 5, stubEmbed, 2)
    expect(r.truncated).toBe(true)
    expect(r.totalBlocks).toBe(3)
    expect(r.hits).toHaveLength(2) // 探针命中行被 pop，硬截断至 warnThreshold 块
  })
})
