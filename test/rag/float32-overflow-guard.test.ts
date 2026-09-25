/**
 * R34D-32（三十四轮）回归：RAG 向量 Float32 溢出毒行守卫。
 *
 * embed() 的 finite 校验在 double 层（embed.ts 槽位校验只拒 Infinity/NaN double），
 * 分量 >3.4e38 的**有限** double 经 Float32Array.from 物化收窄成 ±Infinity 静默入库
 * 成永久毒行：norm=∞、余弦对它恒 NaN，一行毒数据打乱整库 topK 排序且无告警
 *（触发面为故障/恶意端点）。修复三层：
 * - commitIndexBatch 物化点：非有限 → 该批按失败收口（failedAt 续传，毒批零入库）；
 * - storeChunk 入库末道：非有限 → 抛错拒绝写入（未来新入库路径兜底）；
 * - recall 查询向量物化点：非有限 → 降级返回空（topK 不被 NaN 打乱）。
 * 桩 embed 不联网；bookRoot 手建临时目录（与 test/rag/index.test.ts 同口径）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recall } from '../../src/rag/index.js'
import { openRagDb, readAllChunks, storeChunk } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

/** 好桩：确定性 3 维（全部 double 与 Float32 双层有限） */
function cleanEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

/** 毒桩：首分量 1e39——Number.isFinite(1e39)===true（过 embed.ts double 层校验），
 *  但 >Float32 上限 3.4e38，物化后收窄成 Infinity（正是 finding 的触发形态） */
function overflowEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(texts.map(() => [1e39, 0.2, 0.3]))
}

describe('R34D-32：Float32 溢出守卫（入库物化点）', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r34d32-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    for (const n of [1, 2]) {
      const meta: ChapterMeta = {
        章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: 100,
      }
      writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta, `第${n}章正文，战斗场景描写充分，主角挥剑。`)
    }
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('批响应含溢出分量（double 有限、Float32 物化后 ±Infinity）→ 整批失败收口、零毒行入库、游标不推进', async () => {
    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    try {
      const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
      const result = await buildIndex(bookRoot, config, 'key', overflowEmbed)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('embedding 端点调用失败')
      // 溢出告警可定位（区别于普通端点失败——作者能看出是端点返回异常量级）
      expect(spy).toHaveBeenCalled()
      expect(spy.mock.calls.some((c) => c[1]!.includes('Float32 溢出'))).toBe(true)
      // 零毒行证明：库中无任何行（物化守卫先于入库）
      const db = openRagDb(bookRoot)
      try {
        expect(readAllChunks(db)).toEqual([])
      } finally {
        db.close()
      }
      // 游标未推进：换干净桩重跑，两章仍全部按「未索引」建索引
      const rerun = await buildIndex(bookRoot, config, 'key', cleanEmbed)
      expect(rerun.ok).toBe(true)
      expect(rerun.chapterCount).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('R34D-32：storeChunk 入库末道守卫（非有限拒绝写入）', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r34d32store-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('±Infinity（溢出）与 NaN 两形态都抛错拒绝，库零写入', () => {
    const db = openRagDb(bookRoot)
    try {
      // Float32Array.from(1e39) 即物化溢出形态；NaN 为相邻坏形态（同为非有限）
      const overflow = Float32Array.from([1e39, 0.2, 0.3])
      expect(Number.isFinite(overflow[0])).toBe(false) // 前置自证：物化后确为 Infinity
      expect(() =>
        storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 10, embedding: overflow, model: 'm' }),
      ).toThrow('非有限')
      expect(() =>
        storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 10, embedding: Float32Array.of(NaN, 0.2, 0.3), model: 'm' }),
      ).toThrow('非有限')
      expect(readAllChunks(db)).toEqual([]) // 两形态均零入库
      // 合法向量照常写入（守卫不误伤）
      storeChunk(db, { 章号: 2, start_offset: 0, end_offset: 10, embedding: Float32Array.from([0.1, 0.2, 0.3]), model: 'm' })
      expect(readAllChunks(db)).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})

describe('R34D-32：recall 查询向量物化守卫', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r34d32q-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    const meta: ChapterMeta = {
      章号: 1, 标题: '第1章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    writeChapter(join(bookRoot, '写作', '正文', '1-第1章.md'), meta, '第一章正文，战斗场景描写充分，主角挥剑。')
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('查询向量溢出 → 召回降级空（修复前：全库相似度 NaN、topK 排序失真）；好查询照常召回', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const built = await buildIndex(bookRoot, config, 'key', cleanEmbed)
    expect(built.ok).toBe(true)

    // 对照臂：好查询向量 → 正常召回（守卫不误伤干净路径）
    const goodHits = await recall(bookRoot, config, 'key', '战斗', 5, cleanEmbed)
    expect(goodHits.length).toBeGreaterThan(0)

    // 毒查询向量：降级空（不把整库相似度算成 NaN）
    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    try {
      const hits = await recall(bookRoot, config, 'key', '战斗', 5, overflowEmbed)
      expect(hits).toEqual([])
      expect(spy.mock.calls.some((c) => c[1]!.includes('Float32 溢出'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
