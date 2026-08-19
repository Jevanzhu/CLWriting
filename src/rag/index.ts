/**
 * RAG 建索引 + 召回 —— 依据 M7 #37 spec 第 4/5 节。
 *
 * 分块 → 外部 embed → 存 .cache/rag.db（增量）→ 召回（query embed → 全表余弦 topK）。
 *
 * 复用：readChapterDir 遍历定稿正文；召回返回位置（章号+偏移），原文交精准读取。
 * 红线：账本永走精准读取不走 RAG；端点挂/未配 key → 召回空（降级回落，不崩）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readChapterDir } from '../format/chapters.js'
import { readFile } from '../format/frontmatter.js'
import { openRagDb, storeChunk, readAllChunks, getRagMeta, setRagMeta, deleteRagMeta, deleteChunksByChapter, getIndexedChapterNumbers, cosineSimilarity, type RagChunk } from './store.js'
import { embed } from './embed.js'
import type { RagConfig } from './config.js'
import type { DatabaseSync } from 'node:sqlite'
import type { ChapterMeta } from '../format/types.js'

/** 一个分块（文本 + 在该章正文的偏移） */
export interface TextChunk {
  text: string
  start: number
  end: number
}

/**
 * 单块长度上限（字符，按 trim 后文本计）。
 * 量级对齐现有段落粒度（网文段落常见数十~数百字，正常段落永不触发），只拦
 * 病理超长段（整章无空行连续长文）：不设上限时单块可达数万字，一次撑爆
 * embedding 输入 token 限制、召回粒度也失去意义。取 1000：约 1k~1.5k token，
 * 对 8k token 级模型（如 text-embedding-3-small）留足余量。
 */
const MAX_CHUNK_CHARS = 1000

/** 句读切点：超长段行内再分时优先在句末断开（标点留在句尾） */
const SENTENCE_ENDERS = new Set(['。', '！', '？', '；', '…', '」', '』'])

/**
 * 按段落/双空行分块，记偏移（#37 第 4 节，粒度默认值待 beta 校准）。
 * 超过 MAX_CHUNK_CHARS 的段在现有切分逻辑内再细分（行边界 → 句读 → 硬切），
 * 子块偏移仍指原文，对外类型不变。
 */
export function chunkBody(body: string): TextChunk[] {
  const chunks: TextChunk[] = []
  // 按双空行（段落/场景）分割，保留偏移
  const re = /\n\s*\n+/g
  let lastEnd = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    pushSegmentChunks(body, lastEnd, m.index, chunks)
    lastEnd = re.lastIndex
  }
  // 末尾段
  pushSegmentChunks(body, lastEnd, body.length, chunks)
  return chunks
}

/** 一个段（双空行之间）入块：不超上限整段一块，超上限细分（子块同走 ≥20 过滤）。 */
function pushSegmentChunks(body: string, segStart: number, segEnd: number, out: TextChunk[]): void {
  const seg = body.slice(segStart, segEnd)
  if (seg.trim().length < 20) return
  if (seg.trim().length <= MAX_CHUNK_CHARS) {
    out.push({ text: seg.trim(), start: segStart, end: segEnd })
    return
  }
  for (const [s, e] of subdivideSegment(seg, MAX_CHUNK_CHARS)) {
    const text = seg.slice(s, e).trim()
    if (text.length >= 20) {
      out.push({ text, start: segStart + s, end: segStart + e })
    }
  }
}

/**
 * 超长段细分：贪心收集子段使每段 ≤ max 字符。切点优先级——换行/句读（取窗口内
 * 最后一个，标点留在句尾）→ 硬切（窗口内无任何边界时）。返回子段在段内的 [start, end)。
 */
function subdivideSegment(seg: string, max: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = []
  let pieceStart = 0
  while (pieceStart < seg.length) {
    // 剩余整段已 ≤ max → 直接收尾
    if (seg.length - pieceStart <= max) {
      pieces.push([pieceStart, seg.length])
      break
    }
    // 窗口 (pieceStart, pieceStart+max] 内找最大切点（前一字符是换行或句读）
    let boundary = -1
    for (let i = pieceStart + 1; i <= pieceStart + max; i++) {
      const prev = seg[i - 1]!
      if (prev === '\n' || SENTENCE_ENDERS.has(prev)) boundary = i
    }
    let cut = boundary > pieceStart ? boundary : pieceStart + max
    // 硬切防劈开代理对（emoji 等增补平面字符占 2 个 UTF-16 码元）
    if (isHighSurrogate(seg.charCodeAt(cut - 1))) cut--
    if (cut <= pieceStart) cut = pieceStart + 1 // 极小 max 兜底，防死循环
    pieces.push([pieceStart, cut])
    pieceStart = cut
  }
  return pieces
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function chapterHashKey(chapterNumber: number): string {
  return `chapter_hash:${chapterNumber}`
}

/** 错误信息提取（事务回滚返回用）。 */
function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function hashChapterContent(fmRaw: string, body: string): string {
  return 'sha256:' + createHash('sha256').update(fmRaw).update('\n---body---\n').update(body).digest('hex')
}

function readChapterFingerprint(ch: ChapterMeta): string | null {
  if (!ch._path) return null
  const r = readFile(ch._path)
  if (!r.ok) return null
  return hashChapterContent(r.fmRaw, r.body)
}

function validateIndexedChapterFingerprints(
  db: DatabaseSync,
  chapters: ChapterMeta[],
): string | null {
  for (const ch of chapters) {
    const currentHash = readChapterFingerprint(ch)
    if (!currentHash) continue
    const indexedHash = getRagMeta(db, chapterHashKey(ch.章号))
    if (!indexedHash) {
      return `RAG 索引缺少第 ${ch.章号} 章内容指纹，请删除 .cache/rag.db 后重建索引。`
    }
    if (indexedHash !== currentHash) {
      return `第 ${ch.章号} 章定稿正文已变更，RAG 索引可能过时，请删除 .cache/rag.db 后重建索引。`
    }
  }
  return null
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

  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) {
    return { ok: false, chunkCount: 0, chapterCount: 0, error: '没有定稿正文可索引。' }
  }
  const { chapters } = readChapterDir(bodyDir)
  if (chapters.length === 0) {
    return { ok: false, chunkCount: 0, chapterCount: 0, error: '没有定稿正文可索引。' }
  }

  const db = openRagDb(bookRoot)
  try {
    const indexedModel = getRagMeta(db, 'embedding_model')
    if (indexedModel && indexedModel !== config.model) {
      return {
        ok: false,
        chunkCount: 0,
        chapterCount: 0,
        error: `embedding 模型与现有索引不一致（现有：${indexedModel}，当前：${config.model}），请重建索引。`,
      }
    }

    // P1-28：清理已删除章的残留向量/指纹——增量游标只看章号上限，删中间章
    //（或整章内容被移走）会永久残留其向量参与召回。以 chunks 实际章号反推已索引集，
    // 与当前正文章号差集即残留 → 删向量 + 指纹（幂等；事务包裹防中断半删）。
    {
      const indexedChapterNums = getIndexedChapterNumbers(db)
      if (indexedChapterNums.length > 0) {
        const currentChapterNums = new Set(chapters.map((ch) => ch.章号))
        const stale = indexedChapterNums.filter((n) => !currentChapterNums.has(n))
        if (stale.length > 0) {
          db.exec('BEGIN IMMEDIATE')
          try {
            for (const n of stale) {
              deleteChunksByChapter(db, n)
              deleteRagMeta(db, chapterHashKey(n))
            }
            db.exec('COMMIT')
          } catch (e) {
            db.exec('ROLLBACK')
            return {
              ok: false,
              chunkCount: 0,
              chapterCount: 0,
              error: `清理已删除章索引失败（已回滚，可重跑）：${errStr(e)}`,
            }
          }
        }
      }
    }

    // 增量：读已索引到第几章，跳过已索引的
    const indexedChStr = getRagMeta(db, 'indexed_max_chapter')
    const indexedMax = indexedChStr ? Number(indexedChStr) : 0
    // RB-IF-P1-3：<=indexedMax 但无指纹的章（低章号补写/历史中断残留）不再要求删库
    // 重建——并入本轮重索引集合自愈闭环；指纹不符（正文已变更）仍报错不变
    const missingFingerprint = new Set<number>()
    for (const ch of chapters) {
      if (ch.章号 > indexedMax) continue
      const currentHash = readChapterFingerprint(ch)
      if (!currentHash) continue // 当前读不出 → 留给 toIndex 的读失败路径（下轮重试）
      const indexedHash = getRagMeta(db, chapterHashKey(ch.章号))
      if (!indexedHash) {
        missingFingerprint.add(ch.章号)
        continue
      }
      if (indexedHash !== currentHash) {
        return { ok: false, chunkCount: 0, chapterCount: 0, error: `第 ${ch.章号} 章定稿正文已变更，RAG 索引可能过时，请删除 .cache/rag.db 后重建索引。` }
      }
    }

    const toIndex = chapters
      .filter((ch) => ch.章号 > indexedMax || missingFingerprint.has(ch.章号))
      .sort((a, b) => a.章号 - b.章号)
    if (toIndex.length === 0) {
      return { ok: true, chunkCount: 0, chapterCount: 0 }
    }

    // 收集所有待 embed 的块（批量请求减往返）
    const allChunks: Array<{ 章号: number; chunk: TextChunk }> = []
    const chapterHashes = new Map<number, string>()
    // RB-IF-P1-3：读失败为瞬时性（文件占用）——游标不越过失败章：本轮只收集首个
    // 读失败章之前的章，失败章及其后留给下轮重试，保证可自愈不死锁（修复前
    // continue 跳过但游标照常推进到 toIndex 最大章号，该章永久无指纹）
    let readFailAt: number | null = null
    for (const ch of toIndex) {
      const r = ch._path ? readFile(ch._path) : null
      if (!r || !r.ok) {
        readFailAt = ch.章号
        break
      }
      chapterHashes.set(ch.章号, hashChapterContent(r.fmRaw, r.body))
      for (const chunk of chunkBody(r.body)) {
        allChunks.push({ 章号: ch.章号, chunk })
      }
    }

    if (allChunks.length === 0 && chapterHashes.size === 0) {
      // 一章都没读成 → 不动游标，报错下轮重试（恢复后自动补齐）
      return {
        ok: false,
        chunkCount: 0,
        chapterCount: 0,
        error:
          readFailAt !== null
            ? `第 ${readFailAt} 章正文读取失败（可能被占用），本轮未推进索引游标，请稍后重试。`
            : '没有可索引的章节内容。',
      }
    }
    // 本轮提交的章 = 已成功读取的章；游标 = max(旧游标, 本轮最大成功章)——重索引
    // 低章号时不回退（更高章仍已索引），读失败时不越过失败章
    const cursorTarget = Math.max(indexedMax, chapterHashes.size > 0 ? Math.max(...chapterHashes.keys()) : 0)

    const committed = await commitIndexBatch(db, config, allChunks, chapterHashes, cursorTarget, embedFn, apiKey)
    if (!committed.ok && readFailAt !== null) {
      return committed
    }
    if (readFailAt !== null) {
      // 部分成功：失败章之前的章已提交，游标停在失败章前，下轮重试补齐
      return {
        ok: false,
        chunkCount: committed.chunkCount,
        chapterCount: committed.chapterCount,
        error: `第 ${readFailAt} 章正文读取失败（可能被占用），已索引至第 ${cursorTarget} 章，下轮自动重试补齐。`,
      }
    }
    return committed
  } finally {
    db.close()
  }
}

/** V-P2-3：块写入 + 游标/指纹同一事务——中断（崩溃/掉电）要么全入要么全无。
 *  此前无事务：块插一半崩，游标未更新 → 重跑整章重复 embed+INSERT（费用翻倍、
 *  召回重复）；配合 chunks 唯一键（schema.ts）双保险。空块批次只写游标/指纹。 */
async function commitIndexBatch(
  db: DatabaseSync,
  config: RagConfig,
  allChunks: Array<{ 章号: number; chunk: TextChunk }>,
  chapterHashes: Map<number, string>,
  cursorTarget: number,
  embedFn: typeof embed,
  apiKey: string,
): Promise<BuildIndexResult> {
  // 批量 embed——P1-9：分批防端点上限。修复前全量一次性单 POST：200 万字 ≈3.5 万块
  // 必超常见 embedding 端点的单请求上限（静默失败/截断）。分批按块数封顶
  //（100 块/批 ≈ 10 万字量级，对 8k~32k token 输入模型都留足余量），任一批失败即整体失败。
  const EMBED_BATCH_SIZE = 100
  const vectors: number[][] = []
  for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
    const batchTexts = allChunks.slice(i, i + EMBED_BATCH_SIZE).map((c) => c.chunk.text)
    const batchVec = await embedFn(config.endpoint!, config.model!, apiKey, batchTexts)
    if (batchVec === null) {
      return { ok: false, chunkCount: 0, chapterCount: 0, error: 'embedding 端点调用失败（已降级，未阻断主路径）' }
    }
    vectors.push(...batchVec)
  }
  const indexedDim = getRagMeta(db, 'embedding_dim')
  if (allChunks.length > 0) {
    const vectorDim = vectors[0]!.length
    if (indexedDim && Number(indexedDim) !== vectorDim) {
      return {
        ok: false,
        chunkCount: 0,
        chapterCount: 0,
        error: `embedding 维度与现有索引不一致（现有：${indexedDim}，当前：${vectorDim}），请重建索引。`,
      }
    }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // 存向量
    for (let i = 0; i < allChunks.length; i++) {
      const { 章号, chunk } = allChunks[i]!
      storeChunk(db, {
        章号,
        start_offset: chunk.start,
        end_offset: chunk.end,
        embedding: Float32Array.from(vectors[i]!),
        model: config.model!,
      })
    }

    // 更新游标
    setRagMeta(db, 'indexed_max_chapter', String(cursorTarget))
    if (allChunks.length > 0) {
      setRagMeta(db, 'embedding_model', config.model!)
      setRagMeta(db, 'embedding_dim', String(vectors[0]!.length))
    }
    for (const [chapterNumber, hash] of chapterHashes) {
      setRagMeta(db, chapterHashKey(chapterNumber), hash)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    return {
      ok: false,
      chunkCount: 0,
      chapterCount: 0,
      error: `索引写入失败（已回滚，可安全重跑）：${errStr(e)}`,
    }
  }

  return { ok: true, chunkCount: allChunks.length, chapterCount: chapterHashes.size }
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

  // P1-31：先取数后联网——db 数据（chunks/元信息/指纹校验）全部在 close 前完成，
  // embed 网络往返（≤30s）不再持有 db 句柄；空库直接返回不烧 API 调用（修复前
  // 先 embed 再查空：空库也白烧一次 embedding 费用）。
  const db = openRagDb(bookRoot)
  let chunks!: RagChunk[]
  let indexedDim: string | null = null
  try {
    const indexedModel = getRagMeta(db, 'embedding_model')
    if (indexedModel && indexedModel !== config.model) return []

    chunks = readAllChunks(db)
    if (chunks.length === 0) return [] // 空库：无向量可召回，先判空不烧 API

    indexedDim = getRagMeta(db, 'embedding_dim')

    const bodyDir = join(bookRoot, '写作', '正文')
    const { chapters } = readChapterDir(bodyDir)
    const chapterNumbers = new Set(chunks.map((c) => c.章号))
    const fingerprintIssue = validateIndexedChapterFingerprints(
      db,
      chapters.filter((ch) => chapterNumbers.has(ch.章号)),
    )
    if (fingerprintIssue) return []
  } finally {
    db.close()
  }

  // 网络段（无 db 句柄）
  const qVec = await embedFn(config.endpoint, config.model, apiKey, [query])
  if (qVec === null || qVec.length === 0) return []
  const queryVec = Float32Array.from(qVec[0]!)

  if (indexedDim && Number(indexedDim) !== queryVec.length) return []

  const hits: RecallHit[] = chunks
    .filter((c) => c.model === config.model && c.embedding.length === queryVec.length)
    .map((c) => ({
      章号: c.章号,
      start_offset: c.start_offset,
      end_offset: c.end_offset,
      score: cosineSimilarity(queryVec, c.embedding),
    }))

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}
