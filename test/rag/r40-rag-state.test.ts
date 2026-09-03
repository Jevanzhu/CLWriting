/**
 * R40-50/51（四十轮）回归：RAG 索引三态可区分 + 续传计数口径。
 *
 * - R40-50：resetRagIndex 落 reset 标记后，「已清空可用」（cleared）与「从未建索引」
 *   （unbuilt）凭 ragIndexState 可区分；recall 空库早退附 indexState；有索引内容 =
 *   built。损坏态走开库异常（不在本组）。
 * - R40-51：buildIndex 部分成功续传的 chunkCount/chapterCount = 本事务实际新嵌落库数
 *   （此前恒报 0/0，进度与实际嵌入数偏差）。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, ragIndexState, recallDetailed, resetRagIndex } from '../../src/rag/index.js'
import { openRagDb, setRagMeta } from '../../src/rag/store.js'
import { type embed } from '../../src/rag/embed.js'
import type { RagConfig } from '../../src/rag/config.js'

const dirs: string[] = []
function tempBook(): string {
  const d = mkdtempSync(join(tmpdir(), 'clw-r40-rag-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CONFIG: RagConfig = { enabled: true, endpoint: 'http://embed.local', model: 'test-embed' }
// embed 线格式：embed(endpoint, model, apiKey, texts, options?) → number[][] | null；
// 向量按 texts 等长对齐（buildIndex 校验批条数一致）
const embedOk = (async (_e: string, _m: string, _k: string, texts: string[]) =>
  texts.map(() => [0.1, 0.2, 0.3, 0.4])) as typeof embed

function writeChapter(root: string, no: number, title: string): void {
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', `000${no}-${title}.md`),
    `---\n章号: ${no}\n标题: ${title}\n---\n\n${title}的正文段落，篇幅足够切出至少一个块。雪落北境，马蹄声碎。\n`,
    'utf-8',
  )
}

describe('R40-50: 索引三态', () => {
  it('从未建索引（无库文件）→ unbuilt', () => {
    expect(ragIndexState(tempBook())).toBe('unbuilt')
  })

  it('resetRagIndex 清表不删文件 → cleared（与 unbuilt 可区分）', () => {
    const root = tempBook()
    resetRagIndex(root)
    expect(ragIndexState(root)).toBe('cleared')
  })

  it('有索引内容（embedding_model 在位）→ built', () => {
    const root = tempBook()
    resetRagIndex(root)
    const db = openRagDb(root)
    setRagMeta(db, 'embedding_model', 'test-embed')
    db.close()
    expect(ragIndexState(root)).toBe('built')
  })

  it('recall 空库早退附 indexState（unbuilt / cleared）', async () => {
    const root = tempBook()
    const r1 = await recallDetailed(root, CONFIG, 'k', '雪夜', 5, embedOk)
    expect(r1.hits).toEqual([])
    expect(r1.indexState).toBe('unbuilt')
    resetRagIndex(root)
    const r2 = await recallDetailed(root, CONFIG, 'k', '雪夜', 5, embedOk)
    expect(r2.indexState).toBe('cleared')
  })
})

describe('R40-51: 续传计数 = 实际新嵌落库数', () => {
  it('前序章整章落库、含失败块的章不进进度 → chunkCount/chapterCount 报续传量', async () => {
    const root = tempBook()
    writeChapter(root, 1, '开篇')
    // EMBED_BATCH_SIZE=100（100 块/批，跨章连续切）：chunkBody 按段落分块，≥20 字符
    // 才成块、≤1000 字符整段一块——writeChapter 正文单段 = ch1 恰 1 块；ch2 每段 ~800
    // 字符（相邻短段会并块）= 120 块，第 120 块含失败标记。共 121 块两批：第 1 批全过、
    // 第 2 批失败 → 续传恰为 ch1 整章
    const para = (tag: string): string => `${tag}${'北境的雪落在瞭望塔上，斥候回报无异常。'.repeat(36)}`
    const paras = Array.from({ length: 119 }, (_, i) => para(`第${i + 1}段：`))
    paras.push(para('烽火燃断标记。'))
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(
      join(root, '写作', '正文', '0002-转折.md'),
      `---\n章号: 2\n标题: 转折\n---\n\n${paras.join('\n\n')}\n`,
      'utf-8',
    )
    const embedHalf = (async (_e: string, _m: string, _k: string, texts: string[]) => {
      if (texts.some((t) => t.includes('燃断标记'))) return null // 该批失败
      return texts.map(() => [0.1, 0.2, 0.3, 0.4])
    }) as typeof embed
    const r = await buildIndex(root, CONFIG, 'k', embedHalf)
    expect(r.ok).toBe(false)
    expect(r.chunkCount).toBe(1) // 此前恒 0——续传落库量不进进度
    expect(r.chapterCount).toBe(1)
    expect(r.error).toContain('续传')
  })

  it('全部成功 → 计数 = 新嵌全量（口径不回归）', async () => {
    const root = tempBook()
    writeChapter(root, 1, '开篇')
    const r = await buildIndex(root, CONFIG, 'k', embedOk)
    expect(r.ok).toBe(true)
    expect(r.chunkCount).toBeGreaterThan(0)
    expect(r.chapterCount).toBe(1)
  })
})
