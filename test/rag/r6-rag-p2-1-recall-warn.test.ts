/**
 * R6-RAG-P2-1（2026-09-09 修复批）回归：召回降级空出口补告警留痕。
 *
 * 修复前：recallDetailed 在索引模型失配 / 查询向量维度失配时静默降级回空——
 * 消费方无从区分「模型/维度失配」与「无相关内容」（:866 溢出 / :894 poisonRows
 * 等降级出口均有留痕，此两出口漏网），排障零线索。修复后三出口（预检模型失配 /
 * 维度失配 / 重开库二次校验模型失配）均 log.warn 文案可定位。
 *
 * 手法对齐 r34d-float32-overflow.test.ts：手建临时书 + buildIndex 桩 embed 建真库，
 * recallDetailed 注入桩 embed；log.warn spy 断言告警文案；空召回语义（hits 空）不变。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recallDetailed } from '../../src/rag/index.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

/** 单段 ≥20 字（chunkBody 的段落成块下限），60 段/章 → 60 块/章 */
function bodyOf(seed: string): string {
  const para = `这一段正文描写战斗场景充分，足够跨过二十字的分块下限。${seed}`
  return Array.from({ length: 60 }, (_, i) => `${i + 1}、${para}`).join('\n\n')
}

function meta(n: number): ChapterMeta {
  return { 章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫', _path: '', _wordCount: 100 }
}

/** 确定性 dim 维桩 embed（携带调用计数） */
function stubEmbedOf(dim: number): { fn: typeof import('../../src/rag/embed.js').embed; counter: { calls: number } } {
  const counter = { calls: 0 }
  const fn = (_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> => {
    counter.calls++
    const vec = Array.from({ length: dim }, (_, d) => 0.1 * (d + 1))
    return Promise.resolve(texts.map(() => vec))
  }
  return { fn: fn as typeof import('../../src/rag/embed.js').embed, counter }
}

describe('R6-RAG-P2-1：召回降级空出口告警', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r6p21-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    for (const n of [1, 2]) {
      writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta(n), bodyOf(`甲${n}`))
    }
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('索引模型失配 → 预检即退（零 embed 调用）+ warn 可定位', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const built = await buildIndex(bookRoot, config, 'key', stubEmbedOf(3).fn)
    expect(built.ok).toBe(true)

    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    try {
      const { fn, counter } = stubEmbedOf(3)
      const r = await recallDetailed(bookRoot, { ...config, model: 'other-model' }, 'key', '主角的剑', 5, fn)
      expect(r.hits).toEqual([]) // 空召回语义不变
      expect(counter.calls).toBe(0) // 预检早退——不烧 API 调用
      expect(spy).toHaveBeenCalled()
      expect(spy.mock.calls.some((c) => c[1]!.includes('模型失配'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('查询向量维度失配 → 空召回 + warn 可定位', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const built = await buildIndex(bookRoot, config, 'key', stubEmbedOf(3).fn)
    expect(built.ok).toBe(true)

    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    try {
      const { fn, counter } = stubEmbedOf(4) // 4 维查询向量 ≠ 索引 3 维
      const r = await recallDetailed(bookRoot, config, 'key', '主角的剑', 5, fn)
      expect(r.hits).toEqual([])
      expect(counter.calls).toBe(1) // 维度比对在查询 embed 之后——查询向量已烧（不烧客户端后续）
      expect(spy.mock.calls.some((c) => c[1]!.includes('维度失配'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('模型/维度匹配的正常召回 → 失配 warn 零误报（守卫无噪音）', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(bookRoot, config, 'key', stubEmbedOf(3).fn)

    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    try {
      const { fn } = stubEmbedOf(3)
      const r = await recallDetailed(bookRoot, config, 'key', '主角的剑', 5, fn)
      expect(r.hits.length).toBeGreaterThan(0) // 正常召回不受影响
      const mismatchWarns = spy.mock.calls.filter((c) => {
        const m = String(c[1])
        return m.includes('模型失配') || m.includes('维度失配')
      })
      expect(mismatchWarns).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})