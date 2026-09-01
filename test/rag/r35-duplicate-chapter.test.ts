/**
 * R35-43（三十五轮）回归：重复章号确定性去重 + 告警。
 *
 * cache/foreshadow 侧均承认可产生两文件同章号的数据态。此前 RAG 无告警：buildIndex
 * 把两文件的块全挂同章号入库（后者文件指纹覆盖前者、chapterSpans 跨文件合并），
 * 召回偏移对精准读取（materials readChapterBodyByNumber 按章号取首个匹配文件）可错位。
 * 修复：每章号只保留路径字典序首个文件（与「保留首个」读取语义对齐的确定性近似），
 * 后者跳过 + log.warn 留痕；recallDetailed 指纹校验同口径去重（不去重则 Map 后者覆盖，
 * 校验读到另一文件、与已存指纹永远错配 → 该章命中被整体误杀）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recall } from '../../src/rag/index.js'
import { openRagDb, readAllChunks } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

function stubEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

describe('R35-43：重复章号——保路径字典序首个 + warn + recall 指纹校验同口径', () => {
  let bookRoot: string
  const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r35-dupch-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    // 同章号两文件：路径字典序 '1-乙卷.md' < '1-甲卷.md'（乙 U+4E59 < 甲 U+7532）→ 保留乙卷
    const metaYi: ChapterMeta = {
      章号: 1, 标题: '乙卷', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    writeChapter(join(bookRoot, '写作', '正文', '1-乙卷.md'), metaYi, '乙卷独有的正文段落内容，用于验证重复章号只保留路径首个文件参与建索引。')
    const metaJia: ChapterMeta = {
      章号: 1, 标题: '甲卷', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    writeChapter(join(bookRoot, '写作', '正文', '1-甲卷.md'), metaJia, '甲卷独有的正文段落内容，重复章号的后到文件不应参与索引产生错位偏移。')
    const meta2: ChapterMeta = {
      章号: 2, 标题: '第2章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    writeChapter(join(bookRoot, '写作', '正文', '2-第2章.md'), meta2, '第二章的正文段落内容，这是一个战斗场景，主角挥剑战斗。')
  })

  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('buildIndex：warn 留痕；只有保留文件（乙卷）的文本被 embed 入库', async () => {
    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    const embedded: string[] = []
    const recording = (e: string, m: string, k: string, texts: string[]): Promise<EmbedResult> => {
      embedded.push(...texts)
      return stubEmbed(e, m, k, texts)
    }
    try {
      const result = await buildIndex(bookRoot, config, 'key', recording)
      expect(result.ok).toBe(true)
      // 告警可定位：点名被跳过的文件
      expect(spy.mock.calls.some((c) => c[1]!.includes('重复章号'))).toBe(true)
      expect(spy.mock.calls.some((c) => c[1]!.includes('1-甲卷.md'))).toBe(true)
      // 只 embed 保留文件的块——甲卷文本零入库（其偏移不会与精准读取错位）
      expect(embedded.some((t) => t.includes('乙卷'))).toBe(true)
      expect(embedded.some((t) => t.includes('甲卷'))).toBe(false)
      // 章号 1 的入库偏移全部落在乙卷正文区间内
      const ybody = '乙卷独有的正文段落内容，用于验证重复章号只保留路径首个文件参与建索引。'
      const db = openRagDb(bookRoot)
      try {
        const ch1 = readAllChunks(db).filter((c) => c.章号 === 1)
        expect(ch1.length).toBeGreaterThan(0)
        expect(ch1.every((c) => c.start_offset >= 0 && c.end_offset <= ybody.length)).toBe(true)
      } finally {
        db.close()
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('recall：指纹校验读到保留文件（同口径去重）→ 章号 1 命中不被整体误杀', async () => {
    const built = await buildIndex(bookRoot, config, 'key', stubEmbed)
    expect(built.ok).toBe(true)

    // recall 侧若不去重，章号 1 的 Map 位被甲卷覆盖 → 指纹与乙卷存的永错配 → 0 命中
    const hits = await recall(bookRoot, config, 'key', '乙卷独有的正文段落', 5, stubEmbed)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.章号 === 1)).toBe(true)
    for (const h of hits.filter((h) => h.章号 === 1)) {
      expect(h.end_offset).toBeGreaterThan(h.start_offset)
    }
  })
})
