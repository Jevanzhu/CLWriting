/**
 * R35-40（三十五轮）回归：存量毒行读取闸。
 *
 * R34D-32 的 Float32 溢出守卫只防新写入，历史毒行无迁移/清扫——召回仍产 NaN 挤占
 * topK。修复：readAllChunks 剔毒 + 一次性 warn（不阻断）。
 * 实测口径（备案）：node:sqlite 对非有限 REAL 绑定/读回都转 NULL，可达毒形是
 * 「norm=NULL + embedding BLOB 含 ±Inf」（毒行 l2Norm=±Inf 回填时绑定 Inf→NULL 永久
 * 存不进）；「norm 非有限」分支为前向防御（发现原文口径），经由 node:sqlite 不可
 * 物化，不单独造例。手工插行绕过 storeChunk 守卫模拟历史存量。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recallDetailed } from '../../src/rag/index.js'
import { openRagDb, readAllChunks, float32ToBuffer } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

function cleanEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

describe('R35-40：存量毒行剔除（readAllChunks 读取闸）', () => {
  let bookRoot: string
  const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r35-poison-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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

  it('毒行（norm=NULL + 向量含 ±Inf）→ 读取剔除 + warn；召回不产 NaN、毒行不占 topK', async () => {
    const built = await buildIndex(bookRoot, config, 'key', cleanEmbed)
    expect(built.ok).toBe(true)

    // 手工插一行毒行（绕过 storeChunk 守卫——模拟 R34D-32 修复前的历史存量）：
    // 章号 1、指纹新鲜、模型/维度全对得上，唯一拦它的是 norm 读取闸。1e39 double 经
    // Float32 物化成 ±Inf（与 R34D-32 同触发形态）；norm 留 NULL（可达毒形，见文件头）
    const db = openRagDb(bookRoot)
    try {
      db.prepare(
        `INSERT INTO chunks (章号, start_offset, end_offset, embedding, model, indexed_at, norm)
         VALUES (1, 9990, 9999, ?, 'stub-model', '2026-01-01T00:00:00.000Z', NULL)`,
      ).run(float32ToBuffer(Float32Array.from([1e39, 0, 0])))
      // 前置自证：毒行确以 norm=NULL + Inf 分量形态在库（node:sqlite 对 Inf 的绑定/读回转 NULL）
      const raw = db.prepare('SELECT norm FROM chunks WHERE start_offset = 9990').get() as { norm: number | null }
      expect(raw.norm).toBeNull()
    } finally {
      db.close()
    }

    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    try {
      // 读取闸：毒行剔除、干净行不误伤
      const db2 = openRagDb(bookRoot)
      let chunks: ReturnType<typeof readAllChunks>
      try {
        chunks = readAllChunks(db2)
      } finally {
        db2.close()
      }
      expect(chunks).toHaveLength(2)
      expect(chunks.some((c) => c.start_offset === 9990)).toBe(false)
      expect(spy.mock.calls.some((c) => c[1]!.includes('毒向量块'))).toBe(true)

      // 召回：无 NaN、毒行偏移不出现在命中里
      const r = await recallDetailed(bookRoot, config, 'key', '战斗', 5, cleanEmbed)
      expect(r.hits.length).toBeGreaterThan(0)
      expect(r.hits.length).toBeLessThanOrEqual(2)
      for (const h of r.hits) {
        expect(Number.isFinite(h.score)).toBe(true)
        expect(h.start_offset).not.toBe(9990)
      }
      // warn 每次读取批量留痕一条（不逐行刷屏）：此处共两次读取（上面直读 + recall 内部）
      const poisonWarns = spy.mock.calls.filter((c) => c[1]!.includes('毒向量块'))
      expect(poisonWarns.length).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })
})
