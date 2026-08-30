/**
 * A-9（二十九轮）：buildIndex 忽略解析错误致坏章向量被 stale 误删——回归。
 *
 * 修复前：单章 frontmatter 解析失败时该章从 chapters 缺失 → P1-28 清理把其有效向量+
 * 指纹当「已删除章残留」清掉；作者修好 fm 后 buildIndex 重嵌整章（重复计费）。
 * 修复后：解析失败章号（按文件名反推）排除出 stale 差集，旧向量保留（召回侧指纹闸
 * 对读不出的章判 stale，fail-closed），修好后指纹比对命中零重嵌。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex } from '../../src/rag/index.js'
import { openRagDb, getIndexedChapterNumbers, readAllChapterFingerprints } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'
import type { RagConfig } from '../../src/rag/config.js'

const CONFIG: RagConfig = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

/** 桩 embed：文本首字符 charCode 归一化成 3 维向量（确定性，不联网；同 index.test.ts） */
function stubEmbed(_endpoint: string, _model: string, _key: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const code = t.charCodeAt(0) || 1
      const norm = 1 / (code + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

function meta(n: number): ChapterMeta {
  return { 章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫', _path: '', _wordCount: 100 }
}

const BODY2 = '第2章的正文段落内容，这是一个战斗场景，主角挥剑战斗，战斗描写充分。'

describe('A-9：坏章不删向量、修复后不重嵌', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `r29-rag-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    writeChapter(join(bookRoot, '写作', '正文', '1-第1章.md'), meta(1), '第1章的正文段落内容，这是一个对话场景，对话充分展开。')
    writeChapter(join(bookRoot, '写作', '正文', '2-第2章.md'), meta(2), BODY2)
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  it('第 2 章 fm 解析失败 → 其向量与指纹保留；修好同正文 → 指纹命中零重嵌', async () => {
    // 首轮：全书 2 章入索引
    const r1 = await buildIndex(bookRoot, CONFIG, 'stub-key', stubEmbed)
    expect(r1.ok).toBe(true)
    expect(r1.chapterCount).toBe(2)

    // 第 2 章 fm 坏（章号格式不符 → readChapter 报错、章从 chapters 缺失）
    writeFileSync(
      join(bookRoot, '写作', '正文', '2-第2章.md'),
      '---\n章号: 五\n标题: 坏章\n---\n\n' + BODY2,
      'utf-8',
    )

    const r2 = await buildIndex(bookRoot, CONFIG, 'stub-key', stubEmbed)
    expect(r2.ok).toBe(true)

    // 修复点：坏章的向量 + 指纹未被 stale 清理误删
    const db = openRagDb(bookRoot)
    try {
      expect(getIndexedChapterNumbers(db)).toContain(2)
      expect(readAllChapterFingerprints(db).get(2)).toBeTruthy()
    } finally {
      db.close()
    }

    // 修好 fm（正文与建索引时完全一致）→ 指纹比对命中，零重嵌零计费
    // （修复前：向量已被清 → missingFingerprint 走重索引，chunkCount > 0）
    writeChapter(join(bookRoot, '写作', '正文', '2-第2章.md'), meta(2), BODY2)
    const r3 = await buildIndex(bookRoot, CONFIG, 'stub-key', stubEmbed)
    expect(r3.ok).toBe(true)
    expect(r3.chunkCount).toBe(0)
    expect(r3.chapterCount).toBe(0)
  })

  it('真删除章仍照常清理（坏章豁免不豁免删除语义）', async () => {
    await buildIndex(bookRoot, CONFIG, 'stub-key', stubEmbed)
    // 真删第 1 章（文件移除，非解析失败）
    rmSync(join(bookRoot, '写作', '正文', '1-第1章.md'))
    const r = await buildIndex(bookRoot, CONFIG, 'stub-key', stubEmbed)
    expect(r.ok).toBe(true)
    const db = openRagDb(bookRoot)
    try {
      expect(getIndexedChapterNumbers(db)).not.toContain(1)
      expect(getIndexedChapterNumbers(db)).toContain(2)
    } finally {
      db.close()
    }
  })
})
