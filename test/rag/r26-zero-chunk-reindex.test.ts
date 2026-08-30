/**
 * R26（二十六轮批 F）RAG 修复回归：
 *
 * - R26-15：零块章「指纹刷新但旧向量不删」——正文改成全 <20 字短段后，重索引章的
 *   删旧块集合原从 allChunks 反推（零块章不在其中）：指纹照常刷新、旧向量残留，被
 *   指纹闸判 fresh 后召回永远返回指向旧正文的偏移。修复后删旧块集合扩为本轮全部
 *   待索引章（主路径与 R73-5 续传小事务同口径）。
 * - R26-16a：resetRagIndex——清 chunks 全部行 + rag_meta 全部键（清表不删文件），
 *   为 rag/rebuild 端点提供「请重建索引」死路的程序化出路。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recall, resetRagIndex } from '../../src/rag/index.js'
import { openRagDb, readAllChunks, getRagMeta, setRagMeta } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

let bookRoot = ''

beforeEach(() => {
  bookRoot = join(tmpdir(), `rag-r26-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
})

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

function writeCh(ch: number, body: string): void {
  const meta: ChapterMeta = {
    章号: ch, 标题: `第${ch}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
    _path: '', _wordCount: 100,
  }
  writeChapter(join(bookRoot, '写作', '正文', `${ch}-第${ch}章.md`), meta, body)
}

/** 写 n 段（每段 ≥20 字 → 恰 n 块），段首带章内标记供 embed 调用观测 */
function paras(_ch: number, n: number, marker: string): string {
  return Array.from({ length: n }, (_, i) => `${marker}第${i}段：这是一个足够长的段落文本，用于分块与续传行为的回归验证。`).join('\n\n')
}

/** 桩 embed：文本首字符 charCode 归一化 3 维向量（确定性，不联网） */
function stubEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

function withDb<T>(fn: (db: ReturnType<typeof openRagDb>) => T): T {
  const db = openRagDb(bookRoot)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

// ── R26-15：零块章重索引必须删旧块（主路径）────────────────────────

describe('R26-15：零块章「指纹刷新但旧向量不删」', () => {
  it('章有旧向量 → 正文改成零块 → 重索引后该章 chunks 为零、指纹刷新 → recall 不再返回旧块', async () => {
    // 初始：ch1/ch2 各 1 块（ch1 段首「第」、ch2 段首「乙」——embed 桩按首字符出向量，
    // 查询「第1章」若旧块仍在必排召回前列）
    writeCh(1, '第1章的正文段落内容，这是一个战斗场景，主角挥剑战斗，描写足够充分。')
    writeCh(2, '乙卷第二章的正文段落内容，这是一个朝堂场景，权臣博弈暗流涌动，刻画细致。')
    const r1 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r1.ok).toBe(true)
    expect(withDb((db) => readAllChunks(db).filter((c) => c.章号 === 1))).toHaveLength(1)

    // ch1 正文改成零块（每段 trim 后 <20 字，全部不成块）
    writeCh(1, '短。\n\n也很短。\n\n第三段。')
    const r2 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r2.ok).toBe(true)
    expect(r2.chapterCount).toBe(1) // ch1 重索引

    // 核心断言：ch1 旧向量已删（修复前残留 1 行）、指纹已刷新
    expect(withDb((db) => readAllChunks(db).filter((c) => c.章号 === 1))).toHaveLength(0)
    const newHash = withDb((db) => getRagMeta(db, 'chapter_hash:1'))
    expect(newHash).toBeTruthy()
    // 召回不再返回旧块（修复前：指纹 fresh + 旧向量在 → 旧偏移照常命中）
    const hits = await recall(bookRoot, config, 'key', '第1章', 5, stubEmbed)
    expect(hits.every((h) => h.章号 !== 1)).toBe(true)
    // 其余章不受连坐
    expect(hits.some((h) => h.章号 === 2)).toBe(true)
  })

  it('普通重索引（有块章）不回归：删旧块后只剩新偏移块', async () => {
    writeCh(1, '第1章的正文段落内容，这是一个战斗场景，主角挥剑战斗，描写足够充分。')
    await buildIndex(bookRoot, config, 'key', stubEmbed)
    // 模拟正文变更（指纹过期）+ 游标归零强制整章重索引
    withDb((db) => {
      setRagMeta(db, 'indexed_max_chapter', '0')
      db.prepare("DELETE FROM rag_meta WHERE key = 'chapter_hash:1'").run()
    })
    writeCh(1, '第1章的正文已经被完全重写，这是一个全新的追逃场景，与旧文本毫无相似之处。')
    const r = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r.ok).toBe(true)
    expect(r.chunkCount).toBe(1)
    expect(withDb((db) => readAllChunks(db).filter((c) => c.章号 === 1))).toHaveLength(1) // 不翻倍
  })
})

// ── R26-15：续传路径（R73-5 小事务）零块章同口径 ────────────────────

describe('R26-15：R73-5 续传小事务零块章先删旧块再落指纹', () => {
  it('批失败续传：已成功整章（ch1）与零块章（ch3）落库，ch3 旧向量删除、指纹刷新', async () => {
    // 初始全量建索引：ch1 3 块、ch2 150 块（跨批）、ch3 1 块 → 154 块 2 批
    writeCh(1, paras(1, 3, '甲'))
    writeCh(2, paras(2, 150, '乙'))
    writeCh(3, paras(3, 1, '丙'))
    const r0 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r0.ok).toBe(true)

    // 三章全部改写：ch1 仍 3 块（新文本）、ch2 仍 150 块、ch3 → 零块
    writeCh(1, paras(1, 3, '甲贰'))
    writeCh(2, paras(2, 150, '乙贰'))
    writeCh(3, '短。\n\n也很短。\n\n第三段。')

    // 第 2 批失败：ch1（span 0-3 ≤ 100）整章续传；ch2 半章不提交；ch3 零块章随指纹续传
    let calls = 0
    const failSecondBatch = (_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> => {
      calls++
      if (calls >= 2) return Promise.resolve(null)
      return stubEmbed(_e, _m, _k, texts)
    }
    const r = await buildIndex(bookRoot, config, 'key', failSecondBatch)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('续传')
    expect(r.error).toContain('2 章') // ch1 + ch3

    expect(withDb((db) => readAllChunks(db).filter((c) => c.章号 === 1))).toHaveLength(3) // 新文本整章落库
    expect(withDb((db) => readAllChunks(db).filter((c) => c.章号 === 2))).toHaveLength(150) // 旧块在（指纹过期，召回侧过滤）
    // 核心断言：ch3 旧向量已删（修复前残留旧偏移 1 行 + 指纹已刷新 = fresh 毒块）
    expect(withDb((db) => readAllChunks(db).filter((c) => c.章号 === 3))).toHaveLength(0)
    expect(withDb((db) => getRagMeta(db, 'chapter_hash:3'))).toBeTruthy()
  })
})

// ── R26-16a：resetRagIndex ──────────────────────────────────────────

describe('R26-16：resetRagIndex 清空索引（清表不删文件）', () => {
  it('建索引后 reset → chunks/rag_meta 全清、库文件仍在；再以新模型 build 不再报失配', async () => {
    writeCh(1, '第1章的正文段落内容，这是一个战斗场景，主角挥剑战斗，描写足够充分。')
    await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(existsSync(join(bookRoot, '.cache', 'rag.db'))).toBe(true)

    expect(() => resetRagIndex(bookRoot)).not.toThrow()

    expect(withDb((db) => readAllChunks(db))).toHaveLength(0)
    expect(withDb((db) => getRagMeta(db, 'embedding_model'))).toBeNull()
    expect(withDb((db) => getRagMeta(db, 'indexed_max_chapter'))).toBeNull()
    expect(withDb((db) => getRagMeta(db, 'chapter_hash:1'))).toBeNull()
    expect(existsSync(join(bookRoot, '.cache', 'rag.db'))).toBe(true) // 清表不删文件

    // 清库后换模型建索引：修复前路径会报「模型不一致…请重建索引」死路，现在全新建起
    const r = await buildIndex(bookRoot, { ...config, model: 'other-model' }, 'key', stubEmbed)
    expect(r.ok).toBe(true)
    expect(r.chunkCount).toBeGreaterThan(0)
    expect(withDb((db) => getRagMeta(db, 'embedding_model'))).toBe('other-model')
    // 召回恢复
    const hits = await recall(bookRoot, { ...config, model: 'other-model' }, 'key', '第1章', 5, stubEmbed)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('从未建过索引的书 reset → 幂等不抛（openRagDb 顺带建表）', () => {
    expect(() => resetRagIndex(bookRoot)).not.toThrow()
    expect(existsSync(join(bookRoot, '.cache', 'rag.db'))).toBe(true)
    expect(withDb((db) => readAllChunks(db))).toHaveLength(0)
  })

  it('R26-16c：模型/维度失配错误信封指向 POST /rag/rebuild（不再「请重建索引」死路）', async () => {
    writeCh(1, '第1章的正文段落内容，这是一个战斗场景，主角挥剑战斗，描写足够充分。')
    await buildIndex(bookRoot, config, 'key', stubEmbed)

    const modelMiss = await buildIndex(bookRoot, { ...config, model: 'other-model' }, 'key', stubEmbed)
    expect(modelMiss.ok).toBe(false)
    expect(modelMiss.error).toContain('模型与现有索引不一致')
    expect(modelMiss.error).toContain('POST /rag/rebuild')

    // 维度失配：同模型但 embedding_dim 元数据与本次向量维度不符
    withDb((db) => {
      setRagMeta(db, 'embedding_dim', '999')
      setRagMeta(db, 'indexed_max_chapter', '0')
      db.prepare("DELETE FROM rag_meta WHERE key = 'chapter_hash:1'").run()
    })
    const dimMiss = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(dimMiss.ok).toBe(false)
    expect(dimMiss.error).toContain('维度与现有索引不一致')
    expect(dimMiss.error).toContain('POST /rag/rebuild')
  })
})
