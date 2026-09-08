/**
 * 重审-批2-4（2026-09-07 全量代码重审 §四P3/§六批2）：commitIndexBatch 续传路径
 * 「首批即失败 + 仅有零块章 complete」时零块章指纹落库被整体跳过。
 *
 * 修复背景：首批 embed 失败（failedAt=0、vectors 空）→ vectorDim undefined，原守卫
 * `complete.length > 0 && vectorDim && ...` 把仅含零块章的 complete 整体跳过——零块章
 * 指纹（无向量写入、无维度依赖）持续缺失到端点恢复。修复后：维度守护只约束带 span
 * （有向量待落库）的章，零块章无条件可提交；零向量事务不写 embedding_model/dim
 * （与全成功路径 allChunks.length===0 不写模型/维度同口径）。端点恢复后缺失指纹章经
 * missingFingerprint 自愈重嵌（RB-IF-P1-3 既有闭环）。
 * 测试基建对齐 r26-zero-chunk-reindex.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildIndex } from '../../src/rag/index.js'
import { openRagDb, readAllChunks, getRagMeta } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

let bookRoot = ''

beforeEach(() => {
  bookRoot = join(tmpdir(), `rag-rereview2-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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

describe('重审-批2-4：首批即失败时零块章指纹续传落库', () => {
  it('首批失败（vectorDim undefined）+ 仅零块章 complete → 零块章指纹落库、不写维度', async () => {
    // ch1 有块（1 chunk）、ch2 零块（每段 trim 后 <20 字）——首批（且唯一批）失败
    writeCh(1, '甲卷第一章的正文段落内容，这是一个战斗场景，主角挥剑战斗，描写充分。')
    writeCh(2, '短。\n\n也很短。\n\n第三段。')
    const failEmbed = (): Promise<EmbedResult> => Promise.resolve(null)

    const r = await buildIndex(bookRoot, config, 'key', failEmbed)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('续传')
    // 核心断言（修复前：vectorDim undefined 守卫整体跳过，零块章 ch2 指纹缺失）
    expect(withDb((db) => getRagMeta(db, 'chapter_hash:2'))).toBeTruthy()
    expect(r.chapterCount).toBe(1) // 零块章计章不计块
    expect(r.chunkCount).toBe(0)
    // 零向量事务不写模型/维度（无维度事实可登记；下轮有块章落库时补上）
    expect(withDb((db) => getRagMeta(db, 'embedding_dim'))).toBeNull()
    expect(withDb((db) => getRagMeta(db, 'embedding_model'))).toBeNull()
    // 游标随已提交章推进（ch1 无指纹，下轮经 missingFingerprint 自愈重嵌）
    expect(withDb((db) => getRagMeta(db, 'indexed_max_chapter'))).toBe('2')
  })

  it('端点恢复后重跑 → ch1 经 missingFingerprint 自愈重嵌，全库指纹闭合', async () => {
    writeCh(1, '甲卷第一章的正文段落内容，这是一个战斗场景，主角挥剑战斗，描写充分。')
    writeCh(2, '短。\n\n也很短。\n\n第三段。')
    const failEmbed = (): Promise<EmbedResult> => Promise.resolve(null)
    await buildIndex(bookRoot, config, 'key', failEmbed)

    // 端点恢复：ch1（<=indexedMax 但无指纹）自愈重嵌，ch2 指纹比对命中跳过
    const r2 = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(r2.ok).toBe(true)
    expect(r2.chapterCount).toBe(1)
    expect(r2.chunkCount).toBe(1)
    expect(withDb((db) => getRagMeta(db, 'chapter_hash:1'))).toBeTruthy()
    expect(withDb((db) => getRagMeta(db, 'chapter_hash:2'))).toBeTruthy()
    expect(withDb((db) => readAllChunks(db).filter((c) => c.章号 === 1))).toHaveLength(1)
    expect(withDb((db) => readAllChunks(db).filter((c) => c.章号 === 2))).toHaveLength(0)
    expect(withDb((db) => getRagMeta(db, 'embedding_dim'))).toBe('3')
  })
})
