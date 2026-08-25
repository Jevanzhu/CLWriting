/**
 * R61-1（第六十一轮）回归：buildIndex 指纹不符自愈重索引。
 * 修复前：已索引章正文变更（回改草稿/修错字）→ buildIndex 硬错要求手工删
 * .cache/rag.db 全书重嵌，一次常规编辑即让构建永久报错。
 * 修复后：stale 章并入重索引集合走既有外科路径（事务内清旧块 + 重 embed +
 * 覆盖指纹），游标不回退，幂等（无变更轮零嵌入）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildIndex, recall } from '../../src/rag/index.js'
import { openRagDb, readAllChunks, getRagMeta } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

let bookRoot = ''

beforeEach(() => {
  bookRoot = join(tmpdir(), `rag-selfheal-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  // 25 章：top5 召回有充分顺位递补空间（5 章书 top5 必含全部章，「旧文不再命中」不可判）
  for (let n = 1; n <= 25; n++) {
    writeChapterAbs(n, `第${n}章独特正文段落，场景人物编号${String(n).padStart(3, '0')}号，各章内容互不相同。`)
  }
})

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

function writeChapterAbs(n: number, body: string): void {
  const meta: ChapterMeta = {
    章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
    _path: '', _wordCount: 100,
  }
  writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta, body)
}

/** 桩 embed：全文哈希 → 3 维确定性向量（同文同向量、异文异向量，不联网），带调用计数 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
let embeddedTexts: string[] = []
function hashEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  embeddedTexts.push(...texts)
  return Promise.resolve(
    texts.map((t) => {
      const h = fnv1a(t)
      return [(h % 97) + 1, ((h >>> 5) % 89) + 1, ((h >>> 10) % 83) + 1]
    }),
  )
}

const CONFIG = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

describe('R61-1: 指纹不符自愈重索引', () => {
  it('已索引章正文变更 → 自愈重索引该章（不硬错、不清库），其余章零重嵌，游标不回退', async () => {
    embeddedTexts = []
    const first = await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    expect(first.ok).toBe(true)
    const totalChunksFirst = first.chunkCount

    // 回改第 3 章（写作常态：修错字/续写）——修复前此处返回 ok:false 硬错
    writeChapterAbs(3, '第3章正文被完全重写，加入了全新的桥段与对白，旧向量不应再残留命中。')

    embeddedTexts = []
    const second = await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    expect(second.ok).toBe(true)
    expect(second.chapterCount).toBe(1) // 只重索引第 3 章
    expect(second.chunkCount).toBeGreaterThan(0)
    expect(second.chunkCount).toBeLessThan(totalChunksFirst) // 远小于全书
    expect(embeddedTexts.length).toBe(second.chunkCount) // 嵌入恰好覆盖重索引章的块

    // 游标不回退（仍指向最大章）
    const db = openRagDb(bookRoot)
    try {
      expect(getRagMeta(db, 'indexed_max_chapter')).toBe('25')
    } finally {
      db.close()
    }
  })

  it('旧正文不再命中、新正文 top1（旧偏移块残留可捕性）', async () => {
    await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    const oldBody = '第3章独特正文段落，场景人物编号003号，各章内容互不相同。'
    const newBody = '第3章正文被完全重写，加入了全新的桥段与对白，旧向量不应再残留命中。'
    writeChapterAbs(3, newBody)
    const rebuilt = await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    expect(rebuilt.ok).toBe(true)

    // 新文召回 top1 = 第 3 章
    const hitsNew = await recall(bookRoot, CONFIG, 'stub-key', newBody, 5, hashEmbed)
    expect(hitsNew[0]!.章号).toBe(3)
    // 旧文不再命中第 3 章（旧块已被 deleteChunksByChapter 清除，非仅覆盖）
    const hitsOld = await recall(bookRoot, CONFIG, 'stub-key', oldBody, 5, hashEmbed)
    expect(hitsOld.some((h) => h.章号 === 3)).toBe(false)
    expect(hitsOld).toHaveLength(5) // 其余章顺位补位
  })

  it('自愈后指纹已覆盖 → 无变更轮零嵌入零写入（幂等，不无限重索引）', async () => {
    await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    writeChapterAbs(2, '第2章改写后的正文，带一点不同的词汇分布用于改变指纹。')
    writeChapterAbs(4, '第4章也做了修订，两个 stale 章应同轮自愈。')
    const second = await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    expect(second.ok).toBe(true)
    expect(second.chapterCount).toBe(2)

    embeddedTexts = []
    const third = await buildIndex(bookRoot, CONFIG, 'stub-key', hashEmbed)
    expect(third.ok).toBe(true)
    expect(third.chunkCount).toBe(0)
    expect(third.chapterCount).toBe(0)
    expect(embeddedTexts).toHaveLength(0)

    // 库内块数 = 首轮口径（25 章各 1 块，替换不累积）
    const db = openRagDb(bookRoot)
    try {
      expect(readAllChunks(db).length).toBeGreaterThanOrEqual(25)
    } finally {
      db.close()
    }
  })
})
