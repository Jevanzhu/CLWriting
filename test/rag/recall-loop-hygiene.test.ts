/**
 * R35-41/R35-42（三十五轮）回归：recallDetailed 出口卫生。
 *
 * - R35-41：六处空结果出口此前共享同一可变 `empty` 对象——消费方 push/改字段即污染
 *   进程内后续空召回；修复后每出口返回新字面量。
 * - R35-42：候选深度耗尽此前用 break——断点后已验证 fresh 章的高分命中被一并丢弃，
 *   topK 可能填不满；改 continue（只停「校验新章」，未验证章照样不收，不放宽校验）。
 * 桩 embed 不联网；bookRoot 手建临时目录（与 test/rag/index.test.ts 同口径）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recallDetailed } from '../../src/rag/index.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

describe('R35-41：空结果出口返回新字面量（共享可变对象不污染后续召回）', () => {
  it('改动第一次空结果的 hits/truncated/totalBlocks → 后续空结果仍是干净零值', async () => {
    const r1 = await recallDetailed(join(tmpdir(), 'nonexistent-r3541'), { enabled: false }, 'k', '查询')
    expect(r1.hits).toEqual([])
    // 消费方改动返回对象（现实风险：调用方就地 push / 复用字段）
    r1.hits.push({ 章号: 99, start_offset: 0, end_offset: 1, score: 0 })
    r1.truncated = true
    r1.totalBlocks = 99

    const r2 = await recallDetailed(join(tmpdir(), 'nonexistent-r3541'), { enabled: false }, 'k', '查询')
    expect(r2).toEqual({ hits: [], truncated: false, totalBlocks: 0 })
  })
})

describe('R35-42：候选深度耗尽 continue——已验证 fresh 章的后续高分命中照常递补', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r35-deep-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    // 每章两段（各 ≥20 字成一块），段首 P 标记决定向量与相似度（score = 标记/100）：
    // 分数序 1.0(章1) 0.9(章2) 0.8(章3) | 0.7(章1) 0.6(章2) 0.5(章3)——章1/2 的第二块
    // 排在章3 首块之后，正是「断点在章3、后面还有已验证 fresh 高分命中」的构造
    const chapters: Array<[number, string[]]> = [
      [1, ['P100', 'P070']],
      [2, ['P090', 'P060']],
      [3, ['P080', 'P050']],
    ]
    for (const [n, marks] of chapters) {
      const meta: ChapterMeta = {
        章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: 100,
      }
      const body = marks.map((mk) => `${mk} ${mk.slice(1)}分相似段，这一段正文足够长以通过二十字的分块过滤门槛。`).join('\n\n')
      writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta, body)
    }
  })

  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  /** 查询向量 [1,0,0]；块向量按 P 标记取单位向量 [s, √(1-s²), 0]——余弦恰为 s */
  function scoredEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
    return Promise.resolve(
      texts.map((t) => {
        if (t === '查询') return [1, 0, 0]
        const m = /^P(\d+)/.exec(t)
        const s = m ? Number(m[1]) / 100 : 0.5
        return [s, Math.sqrt(Math.max(0, 1 - s * s)), 0]
      }),
    )
  }

  it('candidate_depth=2、topK=4：断点后章1/章2 的 fresh 命中递补，topK 填满且未验证章不收', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model', candidate_depth: 2 }
    const built = await buildIndex(bookRoot, config, 'key', scoredEmbed)
    expect(built.ok).toBe(true)

    const r = await recallDetailed(bookRoot, config, 'key', '查询', 4, scoredEmbed)
    // 修复前：第 3 个命中（章3 未验证、深度已满）触发 break → 只有 2 条
    expect(r.hits).toHaveLength(4) // topK 填满
    expect(r.hits.map((h) => h.章号)).toEqual([1, 2, 1, 2])
    const scores = r.hits.map((h) => h.score)
    expect(scores[0]).toBeCloseTo(1, 5)
    expect(scores[1]).toBeCloseTo(0.9, 5)
    expect(scores[2]).toBeCloseTo(0.7, 5)
    expect(scores[3]).toBeCloseTo(0.6, 5)
    // 未验证章（章3）一条不收——continue 只递补已验证 fresh 章，校验未放宽
    expect(r.hits.every((h) => h.章号 !== 3)).toBe(true)
  })
})
