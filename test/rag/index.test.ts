/**
 * RAG index 测试（建索引 + 召回，桩 embed 不联网）—— M7 #37 第 4/5 节。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recall, chunkBody } from '../../src/rag/index.js'
import { writeChapter } from '../../src/format/chapters.js'
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
})

describe('buildIndex + recall（桩 embed）', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-index-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })

    // 写 2 章
    for (const n of [1, 2]) {
      const meta: ChapterMeta = {
        章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: 100,
      }
      writeChapter(
        join(bookRoot, '定稿', '正文', `${n}-第${n}章.md`),
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
      join(bookRoot, '定稿', '正文', '1-第1章.md'),
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
      join(bookRoot, '定稿', '正文', '1-第1章.md'),
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
