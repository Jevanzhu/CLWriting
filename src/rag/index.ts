/**
 * RAG 建索引 + 召回 —— 依据 M7 #37 spec 第 4/5 节。
 *
 * 分块 → 外部 embed → 存 .rag.db（增量）→ 召回（query embed → 全表余弦 topK）。
 *
 * 复用：readChapterDir 遍历定稿正文；召回返回位置（章号+偏移），原文交精准读取。
 * 红线：账本永走精准读取不走 RAG；端点挂/未配 key → 召回空（降级回落，不崩）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readChapterDir } from '../format/chapters.js'
import { readFile } from '../format/frontmatter.js'
import { openRagDb, storeChunk, readAllChunks, getRagMeta, setRagMeta, cosineSimilarity } from './store.js'
import { embed } from './embed.js'
import type { RagConfig } from './config.js'

/** 一个分块（文本 + 在该章正文的偏移） */
export interface TextChunk {
  text: string
  start: number
  end: number
}

/** 按段落/双空行分块，记偏移（#37 第 4 节，粒度默认值待 beta 校准） */
export function chunkBody(body: string): TextChunk[] {
  const chunks: TextChunk[] = []
  // 按双空行（段落/场景）分割，保留偏移
  const re = /\n\s*\n+/g
  let lastEnd = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const seg = body.slice(lastEnd, m.index)
    if (seg.trim().length >= 20) {
      chunks.push({ text: seg.trim(), start: lastEnd, end: m.index })
    }
    lastEnd = re.lastIndex
  }
  // 末尾段
  const tail = body.slice(lastEnd)
  if (tail.trim().length >= 20) {
    chunks.push({ text: tail.trim(), start: lastEnd, end: body.length })
  }
  return chunks
}

export interface BuildIndexResult {
  ok: boolean
  /** 本次新索引的块数 */
  chunkCount: number
  /** 覆盖的章数 */
  chapterCount: number
  error?: string
}

/**
 * 建索引（增量：只 embed 未索引的新章）。
 *
 * @param bookRoot 书仓库
 * @param config RAG 配置（endpoint/model）
 * @param apiKey api_key（绝不进 git）
 * @param embedFn 可选：注入 embed 函数（测试用桩，默认调真实 embed）
 */
export async function buildIndex(
  bookRoot: string,
  config: RagConfig,
  apiKey: string,
  embedFn: typeof embed = embed,
): Promise<BuildIndexResult> {
  if (!config.enabled || !config.endpoint || !config.model) {
    return { ok: false, chunkCount: 0, chapterCount: 0, error: 'RAG 未完整配置（缺 endpoint/model）' }
  }

  const bodyDir = join(bookRoot, '定稿', '正文')
  if (!existsSync(bodyDir)) {
    return { ok: false, chunkCount: 0, chapterCount: 0, error: '没有定稿正文可索引。' }
  }
  const { chapters } = readChapterDir(bodyDir)
  if (chapters.length === 0) {
    return { ok: false, chunkCount: 0, chapterCount: 0, error: '没有定稿正文可索引。' }
  }

  const db = openRagDb(bookRoot)
  try {
    // 增量：读已索引到第几章，跳过已索引的
    const indexedChStr = getRagMeta(db, 'indexed_max_chapter')
    const indexedMax = indexedChStr ? Number(indexedChStr) : 0

    const toIndex = chapters.filter((ch) => ch.章号 > indexedMax).sort((a, b) => a.章号 - b.章号)
    if (toIndex.length === 0) {
      return { ok: true, chunkCount: 0, chapterCount: 0 }
    }

    // 收集所有待 embed 的块（批量请求减往返）
    const allChunks: Array<{ 章号: number; chunk: TextChunk }> = []
    for (const ch of toIndex) {
      const path = ch._path
      if (!path) continue
      const r = readFile(path)
      if (!r.ok) continue
      for (const chunk of chunkBody(r.body)) {
        allChunks.push({ 章号: ch.章号, chunk })
      }
    }

    if (allChunks.length === 0) {
      // 没有有效块，但章节已处理，更新游标
      const maxCh = toIndex[toIndex.length - 1]!.章号
      setRagMeta(db, 'indexed_max_chapter', String(maxCh))
      return { ok: true, chunkCount: 0, chapterCount: toIndex.length }
    }

    // 批量 embed
    const texts = allChunks.map((c) => c.chunk.text)
    const vectors = await embedFn(config.endpoint, config.model, apiKey, texts)
    if (vectors === null) {
      return { ok: false, chunkCount: 0, chapterCount: 0, error: 'embedding 端点调用失败（已降级，未阻断主路径）' }
    }

    // 存向量
    for (let i = 0; i < allChunks.length; i++) {
      const { 章号, chunk } = allChunks[i]!
      storeChunk(db, {
        章号,
        start_offset: chunk.start,
        end_offset: chunk.end,
        embedding: Float32Array.from(vectors[i]!),
        model: config.model,
      })
    }

    // 更新游标
    const maxCh = toIndex[toIndex.length - 1]!.章号
    setRagMeta(db, 'indexed_max_chapter', String(maxCh))
    setRagMeta(db, 'embedding_model', config.model)
    setRagMeta(db, 'embedding_dim', String(vectors[0]!.length))

    return { ok: true, chunkCount: allChunks.length, chapterCount: toIndex.length }
  } finally {
    db.close()
  }
}

export interface RecallHit {
  章号: number
  start_offset: number
  end_offset: number
  score: number
}

/**
 * 召回（query embed → 全表余弦 topK → 返回位置）。
 * 失败/降级返回空数组（#37 第 6.2 节，不崩）。
 *
 * @param embedFn 可选：注入 embed 函数（测试用桩）
 */
export async function recall(
  bookRoot: string,
  config: RagConfig,
  apiKey: string,
  query: string,
  topK = 5,
  embedFn: typeof embed = embed,
): Promise<RecallHit[]> {
  if (!config.enabled || !config.endpoint || !config.model) return []

  // query embed
  const qVec = await embedFn(config.endpoint, config.model, apiKey, [query])
  if (qVec === null || qVec.length === 0) return []
  const queryVec = Float32Array.from(qVec[0]!)

  const db = openRagDb(bookRoot)
  try {
    const chunks = readAllChunks(db)
    if (chunks.length === 0) return []

    const hits: RecallHit[] = chunks.map((c) => ({
      章号: c.章号,
      start_offset: c.start_offset,
      end_offset: c.end_offset,
      score: cosineSimilarity(queryVec, c.embedding),
    }))

    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  } finally {
    db.close()
  }
}
