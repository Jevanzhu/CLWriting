/**
 * A3（批 7）RAG 惰性指纹校验 + 预存范数专项测试：
 * - 惰性校验：召回只整读候选章文件（≤ K'，只读命中涉及的章），不再全书逐章校验；
 * - top-5 与全量余弦口径逐一等价（位置 + 分数）；
 * - stale 章剔除、顺位递补；指纹元数据缺失的章剔除不连坐；
 * - norm 列迁移幂等（旧库无列 ALTER + 存量 NULL 回填，二次打开零写）；
 * - candidate_depth 可覆盖（P4：缺省 20）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../src/format/frontmatter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/format/frontmatter.js')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

import { readFile } from '../../src/format/frontmatter.js'
import { buildIndex, recall } from '../../src/rag/index.js'
import {
  openRagDb,
  readAllChunks,
  readAllChapterFingerprints,
  deleteRagMeta,
  l2Norm,
  float32ToBuffer,
} from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'
import type { RecallHit } from '../../src/rag/index.js'

const readFileMock = vi.mocked(readFile)

let bookRoot = ''

beforeEach(() => {
  bookRoot = join(tmpdir(), `rag-lazy-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  for (let n = 1; n <= 25; n++) {
    writeChapterAbs(n, `第${n}章独特正文段落，场景人物编号${String(n).padStart(3, '0')}号，各章内容互不相同。`)
  }
})

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

function writeChapterAbs(n: number, body: string): void {
  const meta: ChapterMeta = {
    章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
    _path: '', _wordCount: 100,
  }
  writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta, body)
}

function chapterBody(n: number): string {
  return `第${n}章独特正文段落，场景人物编号${String(n).padStart(3, '0')}号，各章内容互不相同。`
}

/** 桩 embed：全文哈希 → 3 维确定性向量（同文同向量、异文异向量，不联网） */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
function hashEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const h = fnv1a(t)
      return [(h % 97) + 1, ((h >>> 5) % 89) + 1, ((h >>> 10) % 83) + 1]
    }),
  )
}

const CONFIG = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

/** 全量余弦基准（旧口径的排序语义）：全部块算 cosine → 排序取 top5 */
function bruteForceTop5(queryVec: Float32Array): RecallHit[] {
  const db = openRagDb(bookRoot)
  try {
    const chunks = readAllChunks(db).filter((c) => c.model === CONFIG.model)
    const hits = chunks.map((c) => {
      let dot = 0
      let na = 0
      let nb = 0
      for (let i = 0; i < queryVec.length; i++) {
        dot += queryVec[i]! * c.embedding[i]!
        na += queryVec[i]! * queryVec[i]!
        nb += c.embedding[i]! * c.embedding[i]!
      }
      return {
        章号: c.章号,
        start_offset: c.start_offset,
        end_offset: c.end_offset,
        score: dot / (Math.sqrt(na) * Math.sqrt(nb)),
      }
    })
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, 5)
  } finally {
    db.close()
  }
}

function bodyFileReads(): number {
  return readFileMock.mock.calls.filter((args) => String(args[0]).includes(join('写作', '正文'))).length
}

describe('A3 惰性指纹校验', () => {
  it('召回只整读候选章（25 章书 top5 → ≤5 次正文整读，top-5 与全量余弦逐一等价）', async () => {
    await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    const query = chapterBody(13)
    // 全量基准（readFile 计数剔除——基准自身读库不读文件）
    const qVec = Float32Array.from(((await hashEmbed('', '', '', [query])) as number[][])[0]!)
    const expected = bruteForceTop5(qVec)

    readFileMock.mockClear()
    const hits = await recall(bookRoot, CONFIG, 'stub-key', query, 5, hashEmbed)

    expect(hits).toHaveLength(5)
    // 惰性校验：只读命中候选的章（≤ topK 涉及的 5 章；旧口径 25 章全量读）
    expect(bodyFileReads()).toBeLessThanOrEqual(5)
    // 与全量余弦基准逐一等价（位置相同 + 分数一致）
    expect(hits.map((h) => [h.章号, h.start_offset])).toEqual(expected.map((h) => [h.章号, h.start_offset]))
    hits.forEach((h, i) => expect(h.score).toBeCloseTo(expected[i]!.score, 6))
  })

  it('stale 章剔除、顺位递补（top-1 章正文改写 → 该章不出现，其余满额）', async () => {
    await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    const query = chapterBody(13)
    const before = await recall(bookRoot, CONFIG, 'stub-key', query, 5, hashEmbed)
    expect(before[0]!.章号).toBe(13) // 前提：查询即第 13 章原文 → 同向量 top1
    // 改写第 13 章（索引指纹过期）
    writeChapterAbs(13, '第13章正文被完全重写，旧向量不应再命中。')
    readFileMock.mockClear()
    const after = await recall(bookRoot, CONFIG, 'stub-key', query, 5, hashEmbed)
    expect(after.some((h) => h.章号 === 13)).toBe(false) // stale 剔除
    expect(after).toHaveLength(5) // 顺位递补仍满额
    expect(bodyFileReads()).toBeLessThanOrEqual(7) // 5 候选 + 1 章 stale 重读 + 余量
  })

  it('指纹元数据缺失的章剔除不连坐（其余章照常召回）', async () => {
    await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    const db = openRagDb(bookRoot)
    try {
      deleteRagMeta(db, 'chapter_hash:13')
    } finally {
      db.close()
    }
    const hits = await recall(bookRoot, CONFIG, 'stub-key', chapterBody(13), 5, hashEmbed)
    expect(hits.some((h) => h.章号 === 13)).toBe(false)
    expect(hits).toHaveLength(5)
  })

  it('candidate_depth 可覆盖（P4：缺省 20；设 2 → 校验章数 ≤ 2）', async () => {
    await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    readFileMock.mockClear()
    const hits = await recall(
      bookRoot,
      { ...CONFIG, candidate_depth: 2 },
      'stub-key',
      chapterBody(13),
      5,
      hashEmbed,
    )
    // 深度 2：最多校验 2 章 → 最多收 2 章的块（每章 1 块 → ≤2 条）
    expect(hits.length).toBeLessThanOrEqual(2)
    expect(bodyFileReads()).toBeLessThanOrEqual(2)
  })
})

describe('A3 预存范数与迁移', () => {
  it('storeChunk 写入 norm = L2；readAllChunks 带回', async () => {
    await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    const db = openRagDb(bookRoot)
    try {
      const chunks = readAllChunks(db)
      expect(chunks.length).toBeGreaterThan(0)
      for (const c of chunks) {
        expect(c.norm).not.toBeNull()
        expect(c.norm!).toBeCloseTo(l2Norm(c.embedding), 5)
      }
    } finally {
      db.close()
    }
  })

  it('存量行 norm 置 NULL（模拟加列后未回填）→ 打开库自动回填，幂等', async () => {
    await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    const db = openRagDb(bookRoot)
    db.prepare('UPDATE chunks SET norm = NULL').run()
    db.close()
    // 重新打开 → ensureNormColumn 回填
    const db2 = openRagDb(bookRoot)
    try {
      const chunks = readAllChunks(db2)
      for (const c of chunks) expect(c.norm).not.toBeNull()
    } finally {
      db2.close()
    }
    // 第三次打开：全值在位 → 零写（幂等），值稳定
    const db3 = openRagDb(bookRoot)
    try {
      const chunks = readAllChunks(db3)
      for (const c of chunks) expect(c.norm!).toBeCloseTo(l2Norm(c.embedding), 5)
    } finally {
      db3.close()
    }
  })

  it('旧库无 norm 列（手建旧 schema）→ ALTER + 回填一次到位', async () => {
    // 手工建一个旧版（无 norm 列）库 + 一行向量
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    const legacy = new DatabaseSync(join(bookRoot, '.cache', 'rag.db'))
    legacy.exec(`CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, 章号 INTEGER NOT NULL, start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL, embedding BLOB NOT NULL, model TEXT NOT NULL, indexed_at TEXT NOT NULL)`)
    legacy.exec(`CREATE TABLE rag_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    const vec = Float32Array.from([3, 4])
    legacy.prepare('INSERT INTO chunks (章号, start_offset, end_offset, embedding, model, indexed_at) VALUES (1, 0, 10, ?, ?, ?)').run(float32ToBuffer(vec), 'stub-model', new Date().toISOString())
    legacy.close()
    // openRagDb → ALTER 加列 + 回填 L2(3,4,0)=5
    const db = openRagDb(bookRoot)
    try {
      const chunks = readAllChunks(db)
      expect(chunks).toHaveLength(1)
      expect(chunks[0]!.norm).toBeCloseTo(5, 6)
      expect(readAllChapterFingerprints(db).size).toBe(0)
    } finally {
      db.close()
    }
  })
})
