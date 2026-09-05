/**
 * R49-20（评审 R49）：召回硬截断盲 pop 回归。
 *
 * streamChunkScores 的 produced 计数先于 model/维度过滤（store.ts）——截断态下探针行
 * （第 maxRows 个产出行）可以是不匹配行而**不入 rows**，旧口径 index.ts 的
 * `if (truncated) rows.pop()` 会错删第 N 个合法命中。修复：streamChunkScores 返回
 * lastProducedWasMatch，调用方仅当最后产出行确为命中时才剔除探针行。
 *
 * 两个层面：
 * - store 层：真实临时库 + 混 model 行流（行序 = 插入序 rowid）验证探针行标记与
 *   rows 内容（不匹配探针行只计数不产元组）；
 * - recallDetailed 层：正常 buildIndex 后追加一条不匹配 model 行（恰落探针位）+
 *   压低 warnThreshold 触发截断——两条合法命中都在（修复前盲 pop 只剩一条）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRagDb, storeChunk, streamChunkScores } from '../../src/rag/store.js'
import { buildIndex, recallDetailed } from '../../src/rag/index.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

/** 桩 embed：确定性、不联网（3 维，与 r36 先例同风格）。 */
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

describe('R49-20 store 层：streamChunkScores 探针行标记', () => {
  let bookRoot = ''

  afterEach(() => {
    if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
    bookRoot = ''
  })

  it('探针行（第 maxRows 个产出行）为不匹配行时：只计数不入 rows，lastProducedWasMatch=false', () => {
    bookRoot = mkdtempSync(join(tmpdir(), 'rag-r49-store-'))
    const db = openRagDb(bookRoot)
    try {
      // 行序 = 插入序（rowid 扫表序）：A1, A2, B1(mismatch), A3
      // maxRows=3 时 B1 恰为第 3 个产出行（探针位），A3 不再读
      storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 10, embedding: Float32Array.from([1, 0, 0]), model: 'm-a' })
      storeChunk(db, { 章号: 1, start_offset: 10, end_offset: 20, embedding: Float32Array.from([0, 1, 0]), model: 'm-a' })
      storeChunk(db, { 章号: 2, start_offset: 0, end_offset: 10, embedding: Float32Array.from([0, 0, 1]), model: 'm-b' })
      storeChunk(db, { 章号: 3, start_offset: 0, end_offset: 10, embedding: Float32Array.from([1, 1, 0]), model: 'm-a' })
      const scanned = streamChunkScores(db, Float32Array.from([1, 0, 0]), 'm-a', 3)
      expect(scanned.produced).toBe(3) // B1 不匹配也计入 produced（totalBlocks 口径不变）
      expect(scanned.rows).toHaveLength(2) // 探针行 B1 未入 rows；A3 未读到
      expect(scanned.lastProducedWasMatch).toBe(false) // 修复前调用方盲 pop 会错删 A2
    } finally {
      db.close()
    }
  })

  it('探针行为匹配行时：lastProducedWasMatch=true（调用方照旧剔除，旧语义不回退）', () => {
    bookRoot = mkdtempSync(join(tmpdir(), 'rag-r49-store-'))
    const db = openRagDb(bookRoot)
    try {
      storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 10, embedding: Float32Array.from([1, 0, 0]), model: 'm-a' })
      storeChunk(db, { 章号: 1, start_offset: 10, end_offset: 20, embedding: Float32Array.from([0, 1, 0]), model: 'm-a' })
      storeChunk(db, { 章号: 2, start_offset: 0, end_offset: 10, embedding: Float32Array.from([0, 0, 1]), model: 'm-b' })
      const scanned = streamChunkScores(db, Float32Array.from([1, 0, 0]), 'm-a', 2)
      expect(scanned.produced).toBe(2)
      expect(scanned.rows).toHaveLength(2)
      expect(scanned.lastProducedWasMatch).toBe(true)
    } finally {
      db.close()
    }
  })
})

describe('R49-20 recallDetailed 层：截断边界不多删合法命中', () => {
  let bookRoot = ''

  afterEach(() => {
    if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
    bookRoot = ''
  })

  it('混 model 库截断：探针行不匹配时不删第 N 条合法命中', async () => {
    bookRoot = mkdtempSync(join(tmpdir(), 'rag-r49-recall-'))
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    const meta: ChapterMeta = {
      章号: 1, 标题: '第1章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    // 两段正文 → 恰 2 块（warnThreshold=2 时第 3 个产出行 = 探针位）
    writeChapter(
      join(bookRoot, '写作', '正文', '1-第1章.md'),
      meta,
      '第一段正文：主角挥剑斩向暗影，剑光如匹练，映出密室深处的古卷记载。\n\n第二段正文：她沉默了一会儿，说：你早就知道，这卷古书藏着下一章的线索。',
    )
    const built = await buildIndex(bookRoot, CONFIG, 'stub-key', stubEmbed)
    expect(built.ok).toBe(true)
    expect(built.chunkCount).toBe(2)
    // 追加一条不匹配 model 的行（模拟混 model 库）——插入序在最末，恰为截断探针位
    const db = openRagDb(bookRoot)
    try {
      storeChunk(db, {
        章号: 99, start_offset: 0, end_offset: 10,
        embedding: Float32Array.from([1, 0, 0]), model: 'other-model',
      })
    } finally {
      db.close()
    }
    const r = await recallDetailed(bookRoot, CONFIG, 'stub-key', '剑光', 5, stubEmbed, 2)
    expect(r.truncated).toBe(true)
    expect(r.totalBlocks).toBe(3) // produced = 2 匹配 + 1 不匹配（探针）
    // 修复前：盲 pop 错删第 2 条合法命中 → hits 只剩 1 条
    expect(r.hits).toHaveLength(2)
    expect(r.hits.every((h) => h.章号 === 1)).toBe(true)
  })
})
