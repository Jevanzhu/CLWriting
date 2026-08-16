/**
 * RAG index 测试（建索引 + 召回，桩 embed 不联网）—— M7 #37 第 4/5 节。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recall, chunkBody } from '../../src/rag/index.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

describe('chunkBody', () => {
  it('按双空行分块，记偏移', () => {
    const body = '第一段内容，这是战斗场景的详细描写，描写很充分。\n\n第二段内容，这是对话场景的详细描写，对话也充分。\n\n第三段。'
    const chunks = chunkBody(body)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // 每块有 start/end 偏移
    for (const c of chunks) {
      expect(c.end).toBeGreaterThan(c.start)
    }
  })

  it('短块（<20 字）被过滤', () => {
    const body = '短。\n\n这是一个足够长的段落内容用于通过过滤。'
    const chunks = chunkBody(body)
    expect(chunks.every((c) => c.text.trim().length >= 20)).toBe(true)
  })

  // ── 单块长度上限（MAX_CHUNK_CHARS = 1000）────────────────────────

  it('超长无分隔文本（无空行/无标点）→ 所有块 ≤ 上限，偏移连续覆盖原文', () => {
    const body = '长'.repeat(5000) // 一个 5000 字段，任何切点都没有
    const chunks = chunkBody(body)
    expect(chunks.length).toBeGreaterThanOrEqual(5)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1000)
      expect(c.text.length).toBeGreaterThanOrEqual(20)
    }
    // 偏移连续覆盖 [0, 5000)，拼回原文无损
    expect(chunks[0]!.start).toBe(0)
    expect(chunks[chunks.length - 1]!.end).toBe(body.length)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.start).toBe(chunks[i - 1]!.end)
    }
    expect(chunks.map((c) => c.text).join('')).toBe(body)
  })

  it('超长带句读段 → 细分块 ≤ 上限且在句末断开（非最后块以句读收尾）', () => {
    // 每句 110 字（含句号），40 句 = 4400 字一段
    const sentence = '风'.repeat(109) + '。'
    const body = sentence.repeat(40)
    const chunks = chunkBody(body)
    expect(chunks.length).toBeGreaterThanOrEqual(5) // 1000/110 ≈ 9 句一块
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1000)
    }
    // 句读优先于硬切：除最后一块外都以句号收尾（硬切会切在句中）
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.text.endsWith('。')).toBe(true)
    }
    expect(chunks.map((c) => c.text).join('')).toBe(body)
  })

  it('正常短段落 + 超长段混合 → 短段整段一块不变，超长段细分', () => {
    const shortSeg = '正常段落内容，这是一个普通长度的段落，不应被细分。'
    const longSeg = '字'.repeat(2500)
    const body = `${shortSeg}\n\n${longSeg}`
    const chunks = chunkBody(body)
    expect(chunks.length).toBe(4) // 2500 = 1000 + 1000 + 500
    expect(chunks[0]!.text).toBe(shortSeg) // 短段行为与上限前完全一致
    expect(chunks[0]!.start).toBe(0)
    expect(chunks[0]!.end).toBe(shortSeg.length)
    for (const c of chunks.slice(1)) {
      expect(c.text.length).toBeLessThanOrEqual(1000)
    }
  })

  it('恰好等于上限的段 → 不细分，整段一块', () => {
    const body = '好'.repeat(1000)
    const chunks = chunkBody(body)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.text.length).toBe(1000)
  })

  it('硬切不劈开代理对（emoji 跨在切点上仍是合法字符串）', () => {
    // 999 个汉字 + 一个 emoji（2 码元）× N，使代理对恰好横跨 1000 切点
    const body = '前'.repeat(999) + '😀'.repeat(1001)
    const chunks = chunkBody(body)
    expect(chunks.length).toBeGreaterThan(1)
    const loneHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/
    const loneLow = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (const c of chunks) {
      expect(loneHigh.test(c.text)).toBe(false)
      expect(loneLow.test(c.text)).toBe(false)
      expect(c.text.length).toBeLessThanOrEqual(1000)
    }
  })
})

describe('buildIndex + recall（桩 embed）', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-index-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })

    // 写 2 章
    for (const n of [1, 2]) {
      const meta: ChapterMeta = {
        章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: 100,
      }
      writeChapter(
        join(bookRoot, '写作', '正文', `${n}-第${n}章.md`),
        meta,
        `第${n}章的正文段落内容，这是一个战斗场景，主角挥剑战斗。`,
      )
    }
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  /** 桩 embed：把文本首字符的 charCode 归一化成 3 维向量（确定性，不联网） */
  function stubEmbed(_endpoint: string, _model: string, _key: string, texts: string[]): Promise<EmbedResult> {
    return Promise.resolve(
      texts.map((t) => {
        const code = t.charCodeAt(0) || 1
        const norm = 1 / (code + 1)
        return [norm, norm * 0.5, norm * 0.3]
      }),
    )
  }

  function twoDimEmbed(_endpoint: string, _model: string, _key: string, texts: string[]): Promise<EmbedResult> {
    return Promise.resolve(texts.map(() => [0.1, 0.2]))
  }

  it('建索引：分块 embed 存 .rag.db（增量，不重跑已索引章）', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const result = await buildIndex(bookRoot, config, 'stub-key', stubEmbed)

    expect(result.ok).toBe(true)
    expect(result.chapterCount).toBe(2)
    expect(result.chunkCount).toBeGreaterThan(0)
    expect(existsSync(join(bookRoot, '.rag.db'))).toBe(true)

    // 再跑一次：增量，应 0 新块（已索引）
    const result2 = await buildIndex(bookRoot, config, 'stub-key', stubEmbed)
    expect(result2.ok).toBe(true)
    expect(result2.chapterCount).toBe(0)
    expect(result2.chunkCount).toBe(0)
  })

  it('建索引：已有索引模型不一致时拒绝混写', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(bookRoot, config, 'stub-key', stubEmbed)

    const result = await buildIndex(bookRoot, { ...config, model: 'other-model' }, 'stub-key', stubEmbed)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('模型')
  })

  it('建索引：已索引章节正文变更时拒绝沿用旧索引', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(bookRoot, config, 'stub-key', stubEmbed)
    const meta: ChapterMeta = {
      章号: 1, 标题: '第1章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    writeChapter(
      join(bookRoot, '写作', '正文', '1-第1章.md'),
      meta,
      '第1章的正文段落内容已经重写，这是一个完全不同的追逃场景，旧向量不能继续使用。',
    )

    const result = await buildIndex(bookRoot, config, 'stub-key', stubEmbed)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('已变更')
  })

  it('召回：query embed → 余弦 topK → 返回位置', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(bookRoot, config, 'stub-key', stubEmbed)

    const hits = await recall(bookRoot, config, 'stub-key', '第1章', 5, stubEmbed)

    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(5)
    // 每条有位置 + 分数
    for (const h of hits) {
      expect(typeof h.章号).toBe('number')
      expect(typeof h.start_offset).toBe('number')
      expect(typeof h.score).toBe('number')
    }
  })

  it('召回：模型不一致时降级为空，避免混用旧索引', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(bookRoot, config, 'stub-key', stubEmbed)

    const hits = await recall(bookRoot, { ...config, model: 'other-model' }, 'stub-key', '第1章', 5, stubEmbed)

    expect(hits).toEqual([])
  })

  it('召回：查询向量维度不一致时降级为空', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(bookRoot, config, 'stub-key', stubEmbed)

    const hits = await recall(bookRoot, config, 'stub-key', '第1章', 5, twoDimEmbed)

    expect(hits).toEqual([])
  })

  it('召回：已索引章节正文变更时降级为空，避免返回旧向量位置', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(bookRoot, config, 'stub-key', stubEmbed)
    const meta: ChapterMeta = {
      章号: 1, 标题: '第1章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    writeChapter(
      join(bookRoot, '写作', '正文', '1-第1章.md'),
      meta,
      '第1章的正文段落内容已经重写，这是一个完全不同的追逃场景，旧向量不能继续使用。',
    )

    const hits = await recall(bookRoot, config, 'stub-key', '第1章', 5, stubEmbed)

    expect(hits).toEqual([])
  })

  it('未完整配置 → 建索引失败但不崩', async () => {
    const result = await buildIndex(bookRoot, { enabled: true }, 'key', stubEmbed)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未完整配置')
  })

  it('降级：embed 返回 null → 建索引失败但不崩', async () => {
    const failEmbed = (): Promise<EmbedResult> => Promise.resolve(null)
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const result = await buildIndex(bookRoot, config, 'key', failEmbed)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('embedding 端点调用失败')
  })

  it('降级：recall embed 失败 → 返回空数组（不崩）', async () => {
    const failEmbed = (): Promise<EmbedResult> => Promise.resolve(null)
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const hits = await recall(bookRoot, config, 'key', 'query', 5, failEmbed)
    expect(hits).toEqual([])
  })
})

// ── V-P2-3：中断重跑不得重复入库（唯一键 + 事务）──────────────────────

import { DatabaseSync } from 'node:sqlite'
import { openRagDb, readAllChunks, setRagMeta, storeChunk, getIndexedChapterNumbers } from '../../src/rag/store.js'

describe('buildIndex 去重与事务（V-P2-3）', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    for (const n of [1, 2]) {
      const meta: ChapterMeta = {
        章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: 100,
      }
      writeChapter(
        join(bookRoot, '写作', '正文', `${n}-第${n}章.md`),
        meta,
        `第${n}章的正文段落内容，这是一个战斗场景，主角挥剑战斗。`,
      )
    }
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  function stubEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
    return Promise.resolve(texts.map((t) => {
      const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }))
  }

  it('游标被重置（模拟崩溃：块已入库但游标未推进）→ 重跑不产生重复块', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const r1 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    if (!r1.ok) throw new Error('prereq')
    const before = (() => {
      const db = openRagDb(bookRoot)
      try {
        return readAllChunks(db).length
      } finally {
        db.close()
      }
    })()

    // 模拟崩溃残留：游标归零、指纹清掉（chunks 却已在库）
    const db = openRagDb(bookRoot)
    setRagMeta(db, 'indexed_max_chapter', '0')
    db.exec("DELETE FROM rag_meta WHERE key LIKE 'chapter_hash:%'")
    db.close()

    const r2 = await buildIndex(bookRoot, config, 'key', stubEmbed) // 重跑：重新 embed + INSERT
    expect(r2.ok).toBe(true)
    const after = (() => {
      const db2 = openRagDb(bookRoot)
      try {
        return readAllChunks(db2).length
      } finally {
        db2.close()
      }
    })()
    expect(after).toBe(before) // 唯一键兜底：无重复行（修复前会翻倍）
  })

  it('存量库历史重复行 → openRagDb 迁移去重 + 建唯一索引', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(bookRoot, config, 'key', stubEmbed)

    // 手工制造历史重复：删唯一索引 + 复制行（模拟旧版本库的崩溃遗留）
    const db = new DatabaseSync(join(bookRoot, '.rag.db'))
    db.exec('DROP INDEX idx_chunks_unique')
    db.exec('INSERT INTO chunks (章号, start_offset, end_offset, embedding, model, indexed_at) SELECT 章号, start_offset, end_offset, embedding, model, indexed_at FROM chunks')
    db.close()

    const db2 = openRagDb(bookRoot) // 迁移入口：去重 + 重建唯一索引
    try {
      expect(readAllChunks(db2).length).toBeGreaterThan(0)
      const row = db2.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
      const distinct = db2.prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT 章号, start_offset, end_offset, model FROM chunks)').get() as { n: number }
      expect(row.n).toBe(distinct.n)
    } finally {
      db2.close()
    }
  })

  it('storeChunk 同块幂等（INSERT OR REPLACE）', () => {
    const db = openRagDb(bookRoot)
    try {
      const input = { 章号: 9, start_offset: 0, end_offset: 10, embedding: Float32Array.from([0.1, 0.2, 0.3]), model: 'm' }
      storeChunk(db, input)
      storeChunk(db, input)
      const row = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
      expect(row.n).toBe(1)
    } finally {
      db.close()
    }
  })
})

// ── cc 批4：P1-9 分批 embed / P1-31 空库不烧 API / P1-28 删除章残留 ─────

describe('cc批4（P1-9 分批 / P1-31 空库 / P1-28 删除残留）', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-cc4-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  function stubEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
    return Promise.resolve(
      texts.map((t) => {
        const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
        return [norm, norm * 0.5, norm * 0.3]
      }),
    )
  }

  it('P1-9：超 100 块分多批 embed，每批 ≤100（修复前单次全量 POST 必超端点上限）', async () => {
    // 2 章 × 每章 60 块（无空行 6 万字段细分）= 120 块 → 必须 ≥2 批
    for (const n of [1, 2]) {
      const meta: ChapterMeta = {
        章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: 100,
      }
      writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta, '字'.repeat(60000))
    }
    const batchSizes: number[] = []
    const trackingEmbed: typeof stubEmbed = (_e, _m, _k, texts) => {
      batchSizes.push(texts.length)
      return Promise.resolve(
        texts.map((t) => {
          const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
          return [norm, norm * 0.5, norm * 0.3]
        }),
      )
    }
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const r = await buildIndex(bookRoot, config, 'key', trackingEmbed)
    expect(r.ok).toBe(true)
    expect(r.chunkCount).toBeGreaterThan(100) // 120 块
    expect(batchSizes.length).toBeGreaterThan(1) // 已分批
    expect(batchSizes.every((n) => n <= 100)).toBe(true) // 每批封顶
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(r.chunkCount) // 无块丢失
  })

  it('P1-31：空库 recall 不调用 embed（修复前先 embed 再查空，白烧一次 API）', async () => {
    let embedCalls = 0
    const countingEmbed: typeof stubEmbed = (_e, _m, _k, texts) => {
      embedCalls++
      return Promise.resolve(
        texts.map((t) => {
          const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
          return [norm, norm * 0.5, norm * 0.3]
        }),
      )
    }
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    // 无正文 → 无索引 → 空库：直接返回空命中，embed 一次都不调
    const hits = await recall(bookRoot, config, 'key', '查询', 5, countingEmbed)
    expect(hits).toEqual([])
    expect(embedCalls).toBe(0)
  })

  it('P1-28：已索引章被删 → 重建时清其残留向量与指纹（不再参与召回）', async () => {
    for (const n of [1, 2, 3]) {
      const meta: ChapterMeta = {
        章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: 100,
      }
      writeChapter(
        join(bookRoot, '写作', '正文', `${n}-第${n}章.md`),
        meta,
        `第${n}章的正文段落内容，这是一个战斗场景，主角挥剑战斗。`,
      )
    }
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(bookRoot, config, 'key', stubEmbed)

    // 删除第 2 章正文文件
    rmSync(join(bookRoot, '写作', '正文', '2-第2章.md'))

    const r = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r.ok).toBe(true)

    const db = openRagDb(bookRoot)
    try {
      const chapterNums = getIndexedChapterNumbers(db)
      expect(chapterNums).not.toContain(2) // 向量残留已清
      expect(getRagMeta(db, 'chapter_hash:2')).toBeNull() // 指纹 meta 已清
      // 章 1/3 指纹保留（未误伤存活章）
      expect(getRagMeta(db, 'chapter_hash:1')).not.toBeNull()
      expect(getRagMeta(db, 'chapter_hash:3')).not.toBeNull()
    } finally {
      db.close()
    }
  })
})

// ── RB-IF-P1-3：增量游标死锁自愈 ──────────────────────────────

/** 读失败注入开关（vi.mock 工厂被提升到文件顶部，运行时状态须经 vi.hoisted 传递）。
 *  第 1 次读取放行（readChapterDir 扫描建 chapters 列表），第 2 次起失败——
 *  模拟「建索引中途文件被占用」的瞬时读失败。 */
const readFailState = vi.hoisted(() => ({ path: null as string | null, seen: 0 }))
vi.mock('../../src/format/frontmatter.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/format/frontmatter.js')>()
  return {
    ...orig,
    readFile: (fp: string) => {
      if (readFailState.path !== null && fp === readFailState.path) {
        readFailState.seen++
        if (readFailState.seen >= 2) {
          return { ok: false as const, error: { file: fp, line: 0, message: '模拟文件占用' } }
        }
      }
      return orig.readFile(fp)
    },
  }
})

import { openRagDb as openRagDbForMeta, getRagMeta } from '../../src/rag/store.js'

describe('buildIndex 游标自愈（RB-IF-P1-3）', () => {
  let bookRoot: string
  const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-heal-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    readFailState.path = null
    readFailState.seen = 0
  })

  afterEach(() => {
    readFailState.path = null
    readFailState.seen = 0
    rmSync(bookRoot, { recursive: true, force: true })
  })

  function stubEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
    return Promise.resolve(texts.map((t) => {
      const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }))
  }

  function addChapter(n: number): void {
    const meta: ChapterMeta = {
      章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta, `第${n}章的正文段落内容，这是一个战斗场景，主角挥剑战斗。`)
  }

  function cursor(): string | null {
    const db = openRagDbForMeta(bookRoot)
    try {
      return getRagMeta(db, 'indexed_max_chapter')
    } finally {
      db.close()
    }
  }

  function hasFingerprint(n: number): boolean {
    const db = openRagDbForMeta(bookRoot)
    try {
      return getRagMeta(db, `chapter_hash:${n}`) !== null
    } finally {
      db.close()
    }
  }

  it('补写低章号章（<=indexedMax 无指纹）→ 下轮自动补索引成功，不再要求删库重建', async () => {
    for (const n of [1, 3, 4, 5]) addChapter(n) // 第 2 章暂缺
    const r1 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r1.ok).toBe(true)
    expect(cursor()).toBe('5')

    addChapter(2) // 补写低章号章
    const r2 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r2.ok).toBe(true) // 修复前：「缺少第 2 章内容指纹，请删除 .rag.db 后重建索引」死锁
    expect(r2.chapterCount).toBe(1)
    expect(hasFingerprint(2)).toBe(true)
    expect(cursor()).toBe('5') // 重索引低章号不回退游标

    // 再跑一轮：全部已索引，0 新块；召回校验通过
    const r3 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r3.ok).toBe(true)
    expect(r3.chunkCount).toBe(0)
    expect((await recall(bookRoot, config, 'key', '第2章', 5, stubEmbed)).length).toBeGreaterThan(0)
  })

  it('单章读取失败 → 游标不越过该章；恢复后重跑成功（瞬时故障可自愈）', async () => {
    for (const n of [1, 2, 3, 4]) addChapter(n)
    readFailState.path = join(bookRoot, '写作', '正文', '3-第3章.md')

    const r1 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain('第 3 章')
    expect(r1.error).toContain('读取失败')
    // 部分成功：1-2 已入库；游标停在 2 不越过失败章（修复前照常推到 4 → 永久缺指纹）
    expect(r1.chunkCount).toBeGreaterThan(0)
    expect(cursor()).toBe('2')
    expect(hasFingerprint(3)).toBe(false)

    // 占用解除 → 重跑补齐 3、4，指纹齐全
    readFailState.path = null
    readFailState.seen = 0
    const r2 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r2.ok).toBe(true)
    expect(cursor()).toBe('4')
    for (const n of [1, 2, 3, 4]) expect(hasFingerprint(n)).toBe(true)
    const r3 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r3.ok).toBe(true)
    expect(r3.chunkCount).toBe(0)
  })
})
