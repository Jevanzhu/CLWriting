/**
 * R51-E-N3（五十一轮）回归：buildIndex 维度失配早检（首批后即判，不烧完才发现）。
 *
 * 修复前：既有索引维度（rag_meta.embedding_dim）在全部 embed 批次烧完后才比对——
 * 同模型名换到不同维端点（混服/换供应商）时，全书重嵌白烧完才报「维度不一致」。
 * 修复后：首批返回即与既有维度比对，失配当场按 R26-16 同款信封硬错（指向 rebuild
 * 显式重建，不自动清索引）；已烧成本封顶一个批次。
 * 手法：test/rag/r27-batch-e.test.ts 既有桩 embed + 手建临时书形态。批大小 100，
 * 两章 × 60 段 = 120 块 → 强制跨两批，使「烧完才检」与「首批后即检」可计数区分。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex } from '../../src/rag/index.js'
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

function stubEmbedOf(dim: number, counter: { calls: number; texts: number }) {
  return (_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> => {
    counter.calls++
    counter.texts += texts.length
    return Promise.resolve(texts.map(() => Array.from({ length: dim }, (_, d) => 0.1 * (d + 1))))
  }
}

describe('R51-E-N3：既有索引维度失配 → 首批后即早退', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r51en3-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    for (const n of [1, 2]) {
      writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta(n), bodyOf(`甲${n}`))
    }
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('同模型名 3 维建好后换 4 维端点：只烧 1 批（100 块）即报维度失配，零入库', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const first = await buildIndex(bookRoot, config, 'key', stubEmbedOf(3, { calls: 0, texts: 0 }))
    expect(first.ok).toBe(true)

    // 正文回改（指纹失配 → 全书进 toIndex = 120 块 = 两批），模型名不变、维度漂移
    //（走 writeChapter 保持 frontmatter 合法——裸 writeFile 会把两章打进 fm 解析失败
    // 桶，A-9 跳章口径下 toIndex 反而不含它们）
    for (const n of [1, 2]) {
      writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta(n), bodyOf(`乙${n}`))
    }
    const counter = { calls: 0, texts: 0 }
    const mismatched = await buildIndex(bookRoot, config, 'key', stubEmbedOf(4, counter))
    // 修复前红形态：calls === 2 / texts === 120（全书烧完才在收尾处比对）
    expect(counter.calls).toBe(1)
    expect(counter.texts).toBe(100)
    expect(mismatched.ok).toBe(false)
    expect(mismatched.error).toContain('维度与现有索引不一致')
    expect(mismatched.error).toContain('重建索引')
    // 失配轮零提交：干净 3 维重跑仍把两章按「未索引」全量建起（游标/指纹未被污染）
    const rerun = await buildIndex(bookRoot, config, 'key', stubEmbedOf(3, { calls: 0, texts: 0 }))
    expect(rerun.ok).toBe(true)
    expect(rerun.chapterCount).toBe(2)
  })

  it('全新索引无既有维度：4 维两批照常建满（早检不误伤首次建索引）', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const counter = { calls: 0, texts: 0 }
    const fresh = await buildIndex(bookRoot, config, 'key', stubEmbedOf(4, counter))
    expect(fresh.ok).toBe(true)
    expect(fresh.chunkCount).toBe(120)
    expect(counter.calls).toBe(2)
  })
})
