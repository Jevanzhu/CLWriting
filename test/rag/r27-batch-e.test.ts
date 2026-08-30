/**
 * R27-93/94（二十七轮）回归：embed 批内维度校验 + 章指纹去 fmRaw。
 * 桩 embed 不联网；bookRoot 用手建临时目录（beforeEach 各测独立，不进 trackTempDir——
 * 与 test/rag/index.test.ts 同口径）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex } from '../../src/rag/index.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

describe('R27-93：embed 批内维度/条数校验（混维行零入库）', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r27e-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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

  it('批内混入异维行 → 整批按失败收口，零向量入库、游标不推进', async () => {
    // 首批（也是唯一批）第 2 行维度坏：3 维基准里混一行 2 维（端点混服/截断的模拟）
    const raggedEmbed = (_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> =>
      Promise.resolve(
        texts.map((t, i) => {
          const code = t.charCodeAt(0) || 1
          const norm = 1 / (code + 1)
          return i === 1 ? [norm, norm * 0.5] : [norm, norm * 0.5, norm * 0.3]
        }),
      )
    const result = await buildIndex(bookRoot, { enabled: true, endpoint: 'http://stub', model: 'stub-model' }, 'key', raggedEmbed)
    expect(result.ok).toBe(false)
    // 零入库证明：换干净桩重跑，两章仍全部按「未索引」建索引（游标未推进）
    const cleanEmbed = (_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> =>
      Promise.resolve(texts.map((t) => [1 / ((t.charCodeAt(0) || 1) + 1), 0.2, 0.1]))
    const rerun = await buildIndex(bookRoot, { enabled: true, endpoint: 'http://stub', model: 'stub-model' }, 'key', cleanEmbed)
    expect(rerun.ok).toBe(true)
    expect(rerun.chapterCount).toBe(2)
  })
})

describe('R27-94：章指纹只摘 body（改 frontmatter 不触发重嵌）', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r27f-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  function stubEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
    return Promise.resolve(texts.map((t) => [1 / ((t.charCodeAt(0) || 1) + 1), 0.2, 0.1]))
  }
  const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

  function meta(n: number, mood: ChapterMeta['情绪定位']): ChapterMeta {
    return { 章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: mood, _path: '', _wordCount: 100 }
  }
  const body1 = '第一章正文，战斗场景描写充分，主角挥剑战斗。'
  const body2 = '第二章正文，对话场景描写充分，两人交谈。'

  it('仅改 frontmatter（情绪定位）→ 指纹命中，0 章重嵌；改正文 → 正常重嵌', async () => {
    writeChapter(join(bookRoot, '写作', '正文', '1-第1章.md'), meta(1, '铺垫'), body1)
    writeChapter(join(bookRoot, '写作', '正文', '2-第2章.md'), meta(2, '铺垫'), body2)
    const first = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(first.ok).toBe(true)
    expect(first.chapterCount).toBe(2)

    // 同 body、仅 frontmatter 变更 → 修复前 fmRaw 掺哈希会整章重嵌（白烧费用）
    writeChapter(join(bookRoot, '写作', '正文', '1-第1章.md'), meta(1, '转折'), body1)
    const afterFm = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(afterFm.ok).toBe(true)
    expect(afterFm.chapterCount).toBe(0)
    expect(afterFm.chunkCount).toBe(0)

    // 对照臂：body 真变 → 该章重嵌
    writeChapter(join(bookRoot, '写作', '正文', '1-第1章.md'), meta(1, '转折'), body1 + '新增了一段收尾的描写。')
    const afterBody = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(afterBody.ok).toBe(true)
    expect(afterBody.chapterCount).toBe(1)
  })
})
