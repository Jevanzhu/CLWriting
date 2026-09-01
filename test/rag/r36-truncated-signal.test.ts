/**
 * R36-16（三十六轮）RAG recall() 兼容包装丢弃 truncated 截断信号回归：
 *
 * - recallDetailed（结构化出口）在召回池超 warnThreshold 硬截断时返回 truncated +
 *   totalBlocks——recall() 兼容包装此前把这两个字段丢弃（仅 log.warn 留痕、消费面
 *   无感），生产消费面（process/materials.ts）已切 recallDetailed 接线（另有
 *   r36-materials-truncated.test.ts 覆盖端到端）。
 * - 本文件：数据驱动构造截断/未截断两种场景，验证结构化信号透出 + 兼容包装
 *   返回值契约不变（存量测试消费面零破坏）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recall, recallDetailed } from '../../src/rag/index.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

/** 桩 embed：确定性、不联网（选定文本首字符相似度最高）。 */
function stubEmbed(_endpoint: string, _model: string, _key: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const code = t.charCodeAt(0) || 1
      const norm = 1 / (code + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

describe('R36-16: recallDetailed truncated 信号透出 + recall() 兼容包装契约不变', () => {
  let bookRoot: string
  const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

  beforeEach(async () => {
    bookRoot = join(tmpdir(), `rag-r36-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    const meta: ChapterMeta = {
      章号: 1, 标题: '第1章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    // 两段正文 → ≥2 块（warnThreshold=1 时必然触发硬截断）
    writeChapter(
      join(bookRoot, '写作', '正文', '1-第1章.md'),
      meta,
      '第一段正文：主角挥剑斩向暗影，剑光如匹练，映出密室深处的古卷记载。\n\n第二段正文：她沉默了一会儿，说：你早就知道，这卷古书藏着下一章的线索。',
    )
    const r = await buildIndex(bookRoot, config, 'stub-key', stubEmbed)
    expect(r.ok).toBe(true)
    expect(r.chunkCount).toBeGreaterThanOrEqual(2) // 截断前提：库内 ≥2 块
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  it('recallDetailed：warnThreshold 压低触发硬截断 → truncated=true 且 totalBlocks 为截断前全量', async () => {
    const r = await recallDetailed(bookRoot, config, 'stub-key', '剑光', 5, stubEmbed, 1)
    // 修复前（recall 兼容包装）：hits 有值但 truncated/totalBlocks 全丢
    expect(r.truncated).toBe(true)
    expect(r.totalBlocks).toBeGreaterThanOrEqual(2)
    expect(r.hits.length).toBeLessThanOrEqual(1) // 硬截断保读出序前缀 1 块
  })

  it('recallDetailed：未触界 → truncated=false（信号不误报）', async () => {
    const r = await recallDetailed(bookRoot, config, 'stub-key', '剑光', 5, stubEmbed, 10_000)
    expect(r.truncated).toBe(false)
    expect(r.hits.length).toBeGreaterThan(0)
  })

  it('recall() 兼容包装：签名与返回契约不变（存量消费面零破坏），meta 丢弃属有意取舍', async () => {
    const hits = await recall(bookRoot, config, 'stub-key', '剑光', 5, stubEmbed, 1)
    // 返回值仍是 RecallHit[]（既有测试断言等式的契约面）
    expect(Array.isArray(hits)).toBe(true)
    expect(hits.length).toBeLessThanOrEqual(1)
    for (const h of hits) {
      expect(h).toHaveProperty('章号')
      expect(h).toHaveProperty('score')
    }
  })
})