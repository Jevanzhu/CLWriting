/**
 * RAG 建索引 + 召回 —— 依据 M7 #37 spec 第 4/5 节。
 *
 * 分块 → 外部 embed → 存 .cache/rag.db（增量）→ 召回（query embed → 全表余弦 topK）。
 *
 * 复用：readChapterDir 遍历 写作/正文 全量（含未定稿草稿——召回服务写作连续性检索，
 * 最近未定稿章恰是高价值检索面；召回侧 chapterFingerprintFresh 惰性校验丢弃过期章，
 * buildIndex 增量自愈覆盖新指纹）；召回返回位置（章号+偏移），原文交精准读取。
 * 红线：账本永走精准读取不走 RAG；端点挂/未配 key → 召回空（降级回落，不崩）。
 */

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readChapterDir } from '../format/chapters.js'
import { readFile } from '../format/frontmatter.js'
import { parseChapterFileName } from '../format/words.js'
import { openRagDb, storeChunk, readAllChunks, readAllChapterFingerprints, getRagMeta, setRagMeta, deleteRagMeta, deleteChunksByChapter, getIndexedChapterNumbers, l2Norm, cosineSimilarity, isRagDbCorruptionError, deleteRagDbFiles, ragDbExists, type RagChunk } from './store.js'
import { embed, type EmbedOptions } from './embed.js'
import type { RagConfig } from './config.js'
import type { DatabaseSync } from 'node:sqlite'
import type { ChapterMeta } from '../format/types.js'
import { log } from '../log/index.js'
import { recordTaskUsage } from '../ai/calls.js'

/** O-3（第十三轮）：召回块数告警阈值——超出 store.ts readAllChunks 量化注释的已知
 *  可用区间（十万块）时 log.warn 留痕。
 *  T2 批：同时是硬截断上限——超区间全表余弦线性扫描延迟已超交互预期，截到上限
 *  并告警（截断取读出序前缀，非按相似度——排序发生在截断之后）。 */
export const RAG_CHUNK_WARN_THRESHOLD = 100_000

/** R62-4：embedding 用量记账——端点随响应下发 usage.prompt_tokens 时经 onUsage
 *  回调汇入本书 .cache/ai-calls.json 的 rag-embed 任务位（与生成链 recordTaskUsage
 *  同一落点/同一串行队列）。记账失败只留痕不阻断（镜像 runner recordUsageSafe
 *  口径：账目缺失可容忍，召回/索引不能因账本 IO 抖动降级）。 */
function recordEmbedUsage(bookRoot: string, promptTokens: number): void {
  try {
    recordTaskUsage(bookRoot, 'rag-embed', { inputTokens: promptTokens, outputTokens: 0 })
  } catch (e) {
    log.warn('rag', `embedding 用量记账失败（本轮 rag-embed 账目缺失）：${errStr(e)}`)
  }
}

/** build/recall 共用的 embed 调用选项：超时显式 resolve 自 RagConfig（R62-27），
 *  用量走 rag-embed 记账（R62-4）。 */
function embedOptionsFor(bookRoot: string, config: RagConfig): EmbedOptions {
  return {
    timeoutMs: config.embed_timeout_ms,
    onUsage: (pt) => recordEmbedUsage(bookRoot, pt),
  }
}

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
    // A4（五十九轮）：offset 按 trim 后文本重定位——text 是 trim 后文本而 start/end 原先
    // 指向未 trim 区间，召回→精准读取契约两头不对齐（首尾空白计入 offset 精度损耗）
    const lead = seg.length - seg.trimStart().length
    const trail = seg.length - seg.trimEnd().length
    out.push({ text: seg.trim(), start: segStart + lead, end: segEnd - trail })
    return
  }
  for (const [s, e] of subdivideSegment(seg, MAX_CHUNK_CHARS)) {
    const piece = seg.slice(s, e)
    const text = piece.trim()
    if (text.length >= 20) {
      // A4（五十九轮）：子块同口径——start/end 收缩到 trim 后文本的实际区间
      const lead = piece.length - piece.trimStart().length
      const trail = piece.length - piece.trimEnd().length
      out.push({ text, start: segStart + s + lead, end: segStart + e - trail })
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

// R27-94（二十七轮）：指纹只摘 body——分块与 embedding 的输入只有正文，frontmatter
// （备注/状态等）改动不影响任何向量；原实现把 fmRaw 掺进哈希，「仅改 frontmatter」被
// 误判成内容变更触发整章重嵌（白烧 embedding 费用）。注意指纹语义变更：存量库的旧指纹
// 全部失配，升级后首轮 buildIndex 会全量重嵌一次（一次性成本，自愈续传路径承接）。
function hashChapterBody(body: string): string {
  return 'sha256:' + createHash('sha256').update(body).digest('hex')
}

function readChapterFingerprint(ch: ChapterMeta): string | null {
  if (!ch._path) return null
  const r = readFile(ch._path)
  if (!r.ok) return null
  return hashChapterBody(r.body)
}

/**
 * R35-43（三十五轮）：重复章号确定性归一——cache/foreshadow 侧均承认可产生两文件同
 * 章号的数据态。精准读取（materials readChapterBodyByNumber → walkMdFind）按章号取
 * 目录序首个匹配文件；索引侧若把两文件的块都挂同章号入库，后者文件的偏移切片会落在
 * 首个文件正文上（错位片段）。策略：每章号只保留路径字典序最小的文件（跨进程可复现，
 * 与「保留首个」读取语义对齐的确定性近似），其余跳过并交由调用方告警留痕。
 */
function dedupeChaptersByNumber(chapters: ChapterMeta[]): { chapters: ChapterMeta[]; dropped: ChapterMeta[] } {
  const kept = new Map<number, ChapterMeta>()
  const dropped: ChapterMeta[] = []
  for (const ch of chapters) {
    const prev = kept.get(ch.章号)
    if (!prev) {
      kept.set(ch.章号, ch)
    } else if ((ch._path ?? '') < (prev._path ?? '')) {
      kept.set(ch.章号, ch)
      dropped.push(prev)
    } else {
      dropped.push(ch)
    }
  }
  const keptSet = new Set(kept.values())
  return { chapters: chapters.filter((ch) => keptSet.has(ch)), dropped }
}

/**
 * A3（批 7）惰性指纹校验的单章口径（recall 候选子集用）。
 * 章 meta 缺失（正文文件不在了）→ false；指纹元数据缺失/不符 → false。
 * 不合格只剔除该章（老口径整批拒绝——倒序校验后语义为过滤闸，见 recall）。
 */
function chapterFingerprintFresh(
  ch: ChapterMeta | undefined,
  indexedFingerprints: Map<number, string>,
): boolean {
  if (!ch) return false
  const currentHash = readChapterFingerprint(ch)
  if (!currentHash) return false
  const indexedHash = indexedFingerprints.get(ch.章号)
  return indexedHash === currentHash
}

export interface BuildIndexResult {
  ok: boolean
  /** 本次新索引的块数。R40-51（四十轮）口径：= 本轮实际新嵌入并落库的块数——指纹
   *  比对命中而跳过的既有章/块不计（toIndex 只收新章与失配章）；增量与续传（部分
   *  成功后重跑）两轮计数之和即真实新嵌总数，UI 进度与实际嵌入数一致。 */
  chunkCount: number
  /** 覆盖的章数（同上口径：本轮实际提交指纹的章数，跳过章不计；零块章计章不计块） */
  chapterCount: number
  error?: string
}

/**
 * R26-16（二十六轮）：重建索引前置——清空本书 RAG 库（chunks 全部行 + rag_meta 全部键：
 * 模型/维度/游标/指纹一并清）。修复「请重建索引」死路：此前模型/维度失配后 buildIndex
 * 硬错、无程序化出路（只能手工删 .cache/rag.db）。取「清表不删文件」口径（优先级裁定）：
 * 保留 openRagDb 的建表/norm 迁移/WAL 语义，避开删库重建与并发开库的竞态窗口。
 * 幂等：空库再清一次无害；失败回滚可重试。由 rag/rebuild 端点在建索引任务闸内调用。
 * R40-50（四十轮）：清表后同事务落 reset 标记——「清表不删文件」口径下清空库与「从未
 * 建索引」（recall 对未建书 openRagDb 会落空建 db）凭内容不可区分；标记让 ragIndexState
 * 能给出 cleared（已清空可用）而非 unbuilt。标记对既有消费者惰性（无一方读该键），
 * buildIndex 内容落位后状态自然转 built，标记残留无害。
 */
export const RAG_RESET_MARKER_KEY = 'reset_at'

export function resetRagIndex(bookRoot: string): void {
  // R35-13（三十五轮）：文件级损坏（断电/磁盘故障/杀软半写后的非 SQLite 字节流，
  // SQLITE_NOTADB 等）清表救不了——本函数「清表不删文件」对文件级损坏无效，专为
  // 兜底失配而设的重建入口在损坏场景同死。派生缓存可弃可重建：确认损坏后删库
  //（连 -wal/-shm）全新建；busy/IO 等可重试错误原样上抛，绝不误删
  let db: DatabaseSync
  try {
    db = openRagDb(bookRoot)
  } catch (e) {
    if (!isRagDbCorruptionError(e)) throw e
    log.warn('rag', `RAG 索引库文件损坏（${errStr(e)}），删除后全新重建`)
    deleteRagDbFiles(bookRoot)
    db = openRagDb(bookRoot)
  }
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM chunks')
      db.exec('DELETE FROM rag_meta')
      setRagMeta(db, RAG_RESET_MARKER_KEY, new Date().toISOString())
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`清空 RAG 索引失败（已回滚，可重试）：${errStr(e)}`)
    }
  } finally {
    db.close()
  }
}

/** R40-50（四十轮）：RAG 索引库三态（+损坏）探测口径——
 *  - unbuilt：从未建索引（库文件不存在，或库可开但无任何索引内容且无 reset 标记；
 *    recall 对未建书 openRagDb 落空建 db 后同此态）
 *  - cleared：resetRagIndex 清表不删文件口径下的「已清空可用」态（reset 标记在位
 *    且无任何索引内容）
 *  - built：有索引内容（向量 / 章指纹 / 游标 / 模型任一在位——零块章建库只有指纹+
 *    游标，也算 built）
 *  - corrupt：库文件级损坏（openRagDb 抛 SQLITE_NOTADB 族；区别于 db 语义错误——
 *    后者原样上抛）。供 status/recall 链路把「未建 / 已清空可用 / 损坏」透出，
 *    未建书的空命中不再与损坏库混淆（排障面）。 */
export type RagIndexState = 'unbuilt' | 'cleared' | 'built' | 'corrupt'

/** 已开库的三态判定（recall 空库早退路径共享，免二次开库）。 */
function ragIndexStateOfOpenDb(db: DatabaseSync): Exclude<RagIndexState, 'corrupt'> {
  const hasContent =
    getRagMeta(db, 'embedding_model') !== null ||
    getRagMeta(db, 'indexed_max_chapter') !== null ||
    readAllChapterFingerprints(db).size > 0 ||
    getIndexedChapterNumbers(db).length > 0
  if (hasContent) return 'built'
  return getRagMeta(db, RAG_RESET_MARKER_KEY) !== null ? 'cleared' : 'unbuilt'
}

/** 独立开库的三态探测（status/probe 出口用；corrupt 收口为返回值而非抛错）。 */
export function ragIndexState(bookRoot: string): RagIndexState {
  if (!ragDbExists(bookRoot)) return 'unbuilt'
  let db: DatabaseSync
  try {
    db = openRagDb(bookRoot)
  } catch (e) {
    if (isRagDbCorruptionError(e)) return 'corrupt'
    throw e
  }
  try {
    return ragIndexStateOfOpenDb(db)
  } finally {
    db.close()
  }
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
  const { chapters: chaptersFromDir, errors } = readChapterDir(bodyDir)
  if (chaptersFromDir.length === 0) {
    return { ok: false, chunkCount: 0, chapterCount: 0, error: '没有定稿正文可索引。' }
  }
  // R35-43（三十五轮）：重复章号去重（保路径字典序首个）+ 告警——无告警时两文件
  // 同章号的块全入库，召回偏移对精准读取可错位
  const { chapters, dropped } = dedupeChaptersByNumber(chaptersFromDir)
  if (dropped.length > 0) {
    log.warn(
      'rag',
      `检测到重复章号（${dropped.map((ch) => `第 ${ch.章号} 章（${basename(ch._path ?? '')}）`).join('、')}）——每章号仅保留路径字典序首个文件参与索引，重复文件不建索引（其偏移会与精准读取错位），请修复章号后重跑`,
    )
  }
  // A-9（二十九轮）：frontmatter 解析失败章号集——文件名仍带章号（<章号>-<标题>.md），
  // 按 basename 反推；名字也不可解析的（无章号前缀）无从保护，退回原口径。
  const brokenChapterNums = new Set<number>()
  for (const err of errors) {
    const n = parseChapterFileName(basename(err.file))?.章号
    if (n !== undefined) brokenChapterNums.add(n)
  }
  if (brokenChapterNums.size > 0) {
    log.warn('rag', `${brokenChapterNums.size} 章正文 frontmatter 解析失败（章号：${[...brokenChapterNums].sort((a, b) => a - b).join('、')}）——本轮索引跳过且保留其既有向量，修复后自动恢复`)
  }

  const db = openRagDb(bookRoot)
  try {
    const indexedModel = getRagMeta(db, 'embedding_model')
    if (indexedModel && indexedModel !== config.model) {
      return {
        ok: false,
        chunkCount: 0,
        chapterCount: 0,
        // R26-16（二十六轮）：文案指向 rag/rebuild 重建端点——原「请重建索引」无程序化
        // 出路（前端按钮本轮未加，不虚构入口，如实写接口）
        error: `embedding 模型与现有索引不一致（现有：${indexedModel}，当前：${config.model}），请重建索引（POST /rag/rebuild）后重试。`,
      }
    }

    // P1-28：清理已删除章的残留向量/指纹——增量游标只看章号上限，删中间章
    //（或整章内容被移走）会永久残留其向量参与召回。已索引集 = chunks 实际章号 ∪
    // 指纹键章号（零块章——trim 后全部 <20 字不成块——只写 chapter_hash 游标无 chunks，
    // 单从 chunks 反推会漏其指纹残留，破坏「指纹集合 == 已索引章集合」），与当前正文
    // 章号差集即残留 → 删向量 + 指纹（幂等；事务包裹防中断半删）。
    {
      const indexedChapterNums = [
        ...new Set([...getIndexedChapterNumbers(db), ...readAllChapterFingerprints(db).keys()]),
      ]
      if (indexedChapterNums.length > 0) {
        const currentChapterNums = new Set(chapters.map((ch) => ch.章号))
        // A-9（二十九轮）：解析失败章排除出 stale 差集——fm 坏的章只是「本轮读不出」，
        // 不是「已删除」。不排除会把它的有效向量+指纹当残留清掉，作者修好 fm 后
        // buildIndex 重嵌整章（重复计费）。排除后旧向量保留（召回侧指纹闸对读不出的
        // 章判 stale 不出 hit，fail-closed），修好后指纹比对自然走增量/重索引自愈。
        const stale = indexedChapterNums.filter((n) => !currentChapterNums.has(n) && !brokenChapterNums.has(n))
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
    // 重建——并入本轮重索引集合自愈闭环。
    // R61-1（第六十一轮）：指纹不符（正文已变更）同款并入自愈——旧口径硬错要求手工删
    // .cache/rag.db 全书重嵌（200 万字 ≈3.5 万块费用），而「回改草稿/定稿后修错字」是
    // 写作常态操作，一次编辑即让 build 永久报错。重索引走既有外科路径（commitIndexBatch
    // 事务内 deleteChunksByChapter 清旧块 + 重 embed + 覆盖指纹，偏移漂移残留同 missing 场景）。
    const missingFingerprint = new Set<number>()
    const staleFingerprint = new Set<number>()
    // R31-37（三十一轮）成本口径备案：指纹核对需逐章全文读+SHA-256（200 万字书每轮
    // build ≈8MB 读，秒级）——readChapterDir 的 (mtimeNs,size) 缓存只覆盖 meta 不覆盖
    // 指纹；引入 mtime 快路径会开「同 mtime 改内容」的漏检窗，有意不设，成本口径见此。
    for (const ch of chapters) {
      if (ch.章号 > indexedMax) continue
      const currentHash = readChapterFingerprint(ch)
      if (!currentHash) continue // 当前读不出 → 留给 toIndex 的读失败路径（下轮重试）
      const indexedHash = getRagMeta(db, chapterHashKey(ch.章号))
      if (!indexedHash) {
        missingFingerprint.add(ch.章号)
        continue
      }
      if (indexedHash !== currentHash) staleFingerprint.add(ch.章号)
    }

    const toIndex = chapters
      .filter((ch) => ch.章号 > indexedMax || missingFingerprint.has(ch.章号) || staleFingerprint.has(ch.章号))
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
      chapterHashes.set(ch.章号, hashChapterBody(r.body))
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

    const committed = await commitIndexBatch(db, config, allChunks, chapterHashes, cursorTarget, embedFn, apiKey, embedOptionsFor(bookRoot, config))
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
  embedOptions: EmbedOptions = {},
): Promise<BuildIndexResult> {
  // 批量 embed——P1-9：分批防端点上限。修复前全量一次性单 POST：200 万字 ≈3.5 万块
  // 必超常见 embedding 端点的单请求上限（静默失败/截断）。分批按块数封顶
  //（100 块/批 ≈ 10 万字量级，对 8k~32k token 输入模型都留足余量）。任一批失败不再
  // 整体报废——R73-5（二十一轮 A-5）：已成功批按「整章」小事务续传落库（见下）。
  const EMBED_BATCH_SIZE = 100
  // 内存闸（2026-08-24 审计 A2）：批结果即转 Float32Array 驻留——原实现以 number[][]
  // 全量累积（8B/维，200 万字书 ≈ 430MB）到 COMMIT 才逐条 BLOB 化；即转后峰值减半
  //（≈215MB，与召回侧 readAllChunks 单份口径一致）。刻意不做「事务内逐批 embed 逐批
  // 写库」：BEGIN IMMEDIATE 跨 embed 网络往返会把同书 rag.db 写锁窗从 DB 写时长拉长
  // 到分钟级网络时长，阻塞并发 recall 读——锁窗与峰值二取其一，保锁窗（R73-5 的续传
  // 小事务同样只在批边界同步执行、不跨网络往返，锁窗纪律不变）。
  const vectors: Float32Array[] = []
  // R73-5：章 → 其块在 allChunks 中的下标区间 [start, end)（块按章序收集，章内连续）
  const chapterSpans = new Map<number, { start: number; end: number }>()
  for (let i = 0; i < allChunks.length; i++) {
    const ch = allChunks[i]!.章号
    const span = chapterSpans.get(ch)
    if (span) span.end = i + 1
    else chapterSpans.set(ch, { start: i, end: i + 1 })
  }
  // 首个失败批的起始块下标；-1 = 全部成功
  let failedAt = -1
  // R27-93（二十七轮）：维度基准——首批首行定基准，其后批/行全量比对
  let refDim: number | null = null
  for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
    const batchTexts = allChunks.slice(i, i + EMBED_BATCH_SIZE).map((c) => c.chunk.text)
    const batchVec = await embedFn(config.endpoint!, config.model!, apiKey, batchTexts, embedOptions)
    if (batchVec === null) {
      failedAt = i
      break
    }
    // R27-93（二十七轮）：批内维度/条数校验——端点异常（混服降维模型/截断行）返回的
    // 混维行此前静默入库成「死行」：余弦召回对其算出 NaN/垃圾相似度还占索引位，用户
    // 只觉召回变差无从排查。任一批条数与请求文本数不符、或任一行维度偏离基准 → 该批
    // 按 embed 失败同款收口（failedAt 续传路径：批前整章小事务提交，混维批零入库）。
    if (refDim === null) refDim = batchVec[0]?.length ?? null
    if (batchVec.length !== batchTexts.length || batchVec.some((v) => v.length !== refDim)) {
      log.warn('rag', `embedding 批响应条数/维度异常（期望 ${batchTexts.length} 行 × ${refDim ?? '?'} 维，实得 ${batchVec.length} 行）——该批起不入库，已成功部分续传`)
      failedAt = i
      break
    }
    // R34D-32（三十四轮）：Float32 溢出守卫——embed() 的 finite 校验在 double 层
    //（embed.ts 槽位校验），分量 >3.4e38 的**有限** double 经 Float32Array.from 收窄
    // 成 ±Infinity 静默入库成永久毒行（norm=∞、余弦对它恒 NaN，一行毒数据即可打乱
    // 整库 topK 排序且无告警；触发面为故障/恶意端点）。物化（double→Float32）之后
    // 判非有限，命中按维度异常同款收口（failedAt 续传：批前整章小事务提交，毒批零入库）
    const materialized = batchVec.map((v) => Float32Array.from(v))
    if (materialized.some((v) => v.some((x) => !Number.isFinite(x)))) {
      log.warn('rag', 'embedding 批响应含 Float32 溢出分量（double 有限但物化后非有限）——该批起不入库，已成功部分续传')
      failedAt = i
      break
    }
    for (const v of materialized) vectors.push(v)
  }
  if (failedAt >= 0) {
    // R73-5（二十一轮 A-5）：部分成功续传——此前任一批失败即整体失败、已成功批向量
    // 全弃，重跑整批重 embed 重复计费（200 万字书最贵可白白烧掉百万字级 embedding）。
    // 修复：把「已成功批覆盖到的整章」写入小事务提交——指纹即续传标记（重跑时指纹
    // 比对命中跳过），游标随提交章单调推进。半章（尾批截断的章）不提交不写指纹——
    // 部分索引会被指纹闸挡在召回外，但会污染「指纹集合==已索引章集合」不变量，且
    // 下轮重索引按章删旧块即可，无残留。零块章（trim 后全 <20 字）无向量，直接落指纹。
    const complete: Array<[number, { start: number; end: number } | null]> = []
    for (const [ch, span] of chapterSpans) {
      if (span.end <= failedAt) complete.push([ch, span])
    }
    for (const ch of chapterHashes.keys()) {
      if (!chapterSpans.has(ch)) complete.push([ch, null]) // 零块章
    }
    let salvaged = 0
    let salvagedChunks = 0
    // 维度守护：与既有索引维度不一致时不续传（该错要求重建索引，续传无意义）
    const vectorDim = vectors[0]?.length
    const indexedDim = getRagMeta(db, 'embedding_dim')
    if (complete.length > 0 && vectorDim && (!indexedDim || Number(indexedDim) === vectorDim)) {
      db.exec('BEGIN IMMEDIATE')
      try {
        let maxCommitted = 0
        for (const [ch, span] of complete) {
          // R26-15（二十六轮）：删旧块不分有块/零块章——零块章（正文改成全 <20 字短段）
          // 原口径只落指纹不删旧块：指纹刷新后旧向量被指纹闸判 fresh，召回永远返回指向
          // 旧正文的偏移。同事务先删后落指纹（本事务即续传小事务，分批不跨网络往返）。
          deleteChunksByChapter(db, ch)
          if (span) {
            for (let i = span.start; i < span.end; i++) {
              storeChunk(db, {
                章号: ch,
                start_offset: allChunks[i]!.chunk.start,
                end_offset: allChunks[i]!.chunk.end,
                embedding: vectors[i]!,
                model: config.model!,
              })
            }
          }
          setRagMeta(db, chapterHashKey(ch), chapterHashes.get(ch)!)
          maxCommitted = Math.max(maxCommitted, ch)
        }
        // 游标只推进到已提交章（不越过失败章）；不回退既有更高游标
        const prevCursor = Number(getRagMeta(db, 'indexed_max_chapter') ?? 0)
        if (maxCommitted > prevCursor) setRagMeta(db, 'indexed_max_chapter', String(maxCommitted))
        setRagMeta(db, 'embedding_model', config.model!)
        setRagMeta(db, 'embedding_dim', String(vectorDim))
        db.exec('COMMIT')
        salvaged = complete.length
        // R40-51（四十轮）：续传计数=本事务实际新嵌落库的块数（complete 章 span 覆盖的
        // 块；零块章计 0 块）——此前恒报 0/0，部分成功落库的章/块不进进度（UI 进度与
        // 实际嵌入数偏差）；重跑时已续传章经指纹比对跳过、不计入 toIndex，两轮计数
        // 之和=真实新嵌总数
        salvagedChunks = complete.reduce((n, [, span]) => n + (span ? span.end - span.start : 0), 0)
      } catch {
        db.exec('ROLLBACK') // 续传失败不致命：回到旧行为（整体重跑），错误文案不带续传字样
      }
    }
    return {
      ok: false,
      chunkCount: salvagedChunks,
      chapterCount: salvaged,
      error:
        salvaged > 0
          ? `embedding 端点调用失败（已降级，未阻断主路径）；前序已成功章节已续传落库（${salvaged} 章），重跑将从断点继续、不再整批重 embed`
          : 'embedding 端点调用失败（已降级，未阻断主路径）',
    }
  }
  const indexedDim = getRagMeta(db, 'embedding_dim')
  if (allChunks.length > 0) {
    const vectorDim = vectors[0]!.length
    if (indexedDim && Number(indexedDim) !== vectorDim) {
      return {
        ok: false,
        chunkCount: 0,
        chapterCount: 0,
        // R26-16（二十六轮）：同模型失配文案——指向 rag/rebuild 重建端点
        error: `embedding 维度与现有索引不一致（现有：${indexedDim}，当前：${vectorDim}），请重建索引（POST /rag/rebuild）后重试。`,
      }
    }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // 第五轮：重索引章先清旧块。storeChunk 的唯一键是（章号, 偏移, 模型）——正文变更后
    // 偏移平移，旧块按新偏移插不中旧行而残留；missingFingerprint 自愈场景（历史半截库：
    // chunks 在、指纹缺）正是「正文已变过的章」，残留旧偏移块会让召回返回指向现正文
    // 错误区间的 offset。
    // R26-15（二十六轮）：删旧块集合从「本轮有块的章」扩为「本轮全部待索引章」（chapterHashes
    // 的键，含零块章）——零块章（trim 后全部 <20 字不成块）此前不在 allChunks 反推的集合
    // 里：指纹在下方照常刷新、旧向量却原样残留，指纹闸判 fresh 后召回永远返回旧正文偏移。
    // 全新书章无旧块，删除是空操作（原口径语义保留）。
    for (const ch of chapterHashes.keys()) deleteChunksByChapter(db, ch)
    // 存向量
    for (let i = 0; i < allChunks.length; i++) {
      const { 章号, chunk } = allChunks[i]!
      storeChunk(db, {
        章号,
        start_offset: chunk.start,
        end_offset: chunk.end,
        embedding: vectors[i]!,
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
 * R73-12（二十一轮 A-12）：召回结果结构化出口——truncated 标记上抛。
 * 召回池超 10 万块（RAG_CHUNK_WARN_THRESHOLD）被硬截断时，旧口径仅 log.warn 留痕、
 * 前端/消费面无感。本结构把截断事实作为数据返回，供消费方在 prompt 组装等处留痕。
 * R36-16（三十六轮）：materials.ts 已切本结构化出口消费（ragTruncated/ragNote 透出），
 * 兼容包装 recall() 仅服务存量测试面。
 */
export interface RecallResult {
  hits: RecallHit[]
  /** 召回池超上限被硬截断（读出序前缀保留、尾部丢弃，非按相似度裁剪） */
  truncated: boolean
  /** 截断前的全量块数（truncated=false 时 = 参与召回的块数；R37-38 起截断态封顶为
   *  阈值+1——召回侧早停读 N+1 条即判 truncated，不再为计数全表读回） */
  totalBlocks: number
  /** R40-50（四十轮）：空库态附带的索引三态（unbuilt=从未建索引 / cleared=重建已清空），
   *  仅空库早退路径携带——有命中即已建（built），其余空结果出口（未配置/端点失败/模型
   *  失配等）不带本字段（语义属配置/网络面，非库状态面）。消费方可据此把「未建索引」
   *  与「建了但无命中」区分开。 */
  indexState?: 'unbuilt' | 'cleared'
}

/**
 * 召回（query embed → 全表点积排序 → 候选子集惰性指纹校验 → topK）。
 * 失败/降级返回空数组（#37 第 6.2 节，不崩）。
 *
 * A3（批 7，P4：K'=20 写死 + book.yaml rag.candidate_depth 可覆盖）：
 * - 预存范数：chunks.norm 建索引时算好，余弦退化为 dot(q,c)/(||q||·c.norm)，数学量减半；
 * - 倒序校验：先前每次召回对全书逐章读文件校验 SHA-256 指纹（700 章 = 700 次全文
 *   读，大概率慢过余弦本身）——改为先排序，只校验命中候选的章（≤ K'），过期章剔除、
 *   顺位递补至 topK；校验从「整批拒绝闸」变为「过滤闸」，召回质量不降（过期向量
 *   本就不该命中），新鲜数据的 top-5 与全量校验口径逐一等价。
 *
 * @param embedFn 可选：注入 embed 函数（测试用桩）
 */
export async function recallDetailed(
  bookRoot: string,
  config: RagConfig,
  apiKey: string,
  query: string,
  topK = 5,
  embedFn: typeof embed = embed,
  /** O-3：块数告警阈值（测试注入用，默认 RAG_CHUNK_WARN_THRESHOLD） */
  warnThreshold = RAG_CHUNK_WARN_THRESHOLD,
): Promise<RecallResult> {
  // R35-41（三十五轮）：空结果每出口返回新字面量——共享同一可变对象会被消费方
  // 改动污染（进程内后续空召回带着被塞进的脏 hits/truncated）
  const emptyResult = (): RecallResult => ({ hits: [], truncated: false, totalBlocks: 0 })
  if (!config.enabled || !config.endpoint || !config.model) return emptyResult()

  // 下界钳制（2026-08-21 低级项）：书里配 0/负数时首轮 `verdict.size >= 0` 恒 break，
  // 召回恒空静默降级为「无 RAG」且无告警——读侧已拒非法值，这里再兜一层防直调/测试路径
  const candidateDepth = Math.max(1, Math.floor(config.candidate_depth ?? 20))

  // P1-31：先取数后联网——db 数据（chunks/元信息/指纹元数据）全部在 close 前完成，
  // embed 网络往返（≤30s）不再持有 db 句柄；空库直接返回不烧 API 调用。
  const db = openRagDb(bookRoot)
  let chunks!: RagChunk[]
  // R73-12：截断事实随结构化出口上抛（旧口径仅 log.warn，前端无感）
  let truncated = false
  let totalBlocks = 0
  let indexedDim: string | null = null
  let indexedFingerprints!: Map<number, string>
  let chapterByNumber!: Map<number, ChapterMeta>
  try {
    const indexedModel = getRagMeta(db, 'embedding_model')
    if (indexedModel && indexedModel !== config.model) return emptyResult()

    // R37-38（三十七轮）：召回读侧早停——此前全表读回只为算 totalBlocks 再 slice，
    // 大库（数万行）白读。改传「告警阈值+1」：得 N+1 条 ⟺ 全量 > N（truncated 判定
    // 恒等）；不足 N+1 条 ⟺ 全量 = 读得数（未触界路径 totalBlocks 仍精确）。代价：
    // 截断态 totalBlocks 封顶为 N+1（不再精确全量）——消费面（materials.ts ragNote）
    // 只需「超上限」事实与量级，截断前缀语义不变（早停序 = 全读 slice 序，见
    // store.ts readAllChunks 的 rowid 序前提注释）。
    chunks = readAllChunks(db, warnThreshold + 1)
    if (chunks.length === 0) {
      // R40-50：空库早退附索引三态——「从未建索引」（unbuilt）与「重建清空后可用」
      //（cleared）可区分（此前两者同样静默空手，与损坏库（开库即抛）在消费方视角
      // 不可分辨，排障无从下手）；不烧 API 调用的早退语义不变
      return { hits: [], truncated: false, totalBlocks: 0, indexState: ragIndexStateOfOpenDb(db) === 'cleared' ? 'cleared' : 'unbuilt' }
    }
    // O-3（第十三轮）：块数超已知可用区间（十万块，见 store.ts readAllChunks 量化注释）
    // 时告警；T2 批起同时硬截断到上限——超区间线性扫描延迟已超交互预期，防单次召回
    // 无界膨胀（截断取读出序前缀 + warn 留痕，配额数值与告警阈值同一常量）
    totalBlocks = chunks.length
    if (chunks.length >= warnThreshold) {
      truncated = chunks.length > warnThreshold
      if (truncated) chunks = chunks.slice(0, warnThreshold)
      log.warn('rag', `召回块数超已知可用区间（${warnThreshold}）——线性扫描延迟可能超预期，建议评估 FTS/向量索引${truncated ? `；已硬截断至 ${warnThreshold} 块` : ''}`)
    }

    indexedDim = getRagMeta(db, 'embedding_dim')
    // A3：指纹元数据整表读内存（单 SELECT 零文件 IO），闭库后候选子集校验用
    indexedFingerprints = readAllChapterFingerprints(db)
    // 章号 → meta（readChapterDir 有 stat 级缓存，热路径零文件读；校验只读候选章文件）
    // R35-43：与 buildIndex 同口径去重（保路径字典序首个）——不去重时 Map 后者覆盖，
    // 指纹校验读到重复章号的另一文件，与已存指纹永远错配，该章命中被整体误杀
    const bodyDir = join(bookRoot, '写作', '正文')
    const chapterNumbers = new Set(chunks.map((c) => c.章号))
    chapterByNumber = new Map(
      dedupeChaptersByNumber(readChapterDir(bodyDir).chapters)
        .chapters.filter((ch) => chapterNumbers.has(ch.章号))
        .map((ch) => [ch.章号, ch] as const),
    )
  } finally {
    db.close()
  }

  // 网络段（无 db 句柄）
  const qVec = await embedFn(config.endpoint, config.model, apiKey, [query], embedOptionsFor(bookRoot, config))
  if (qVec === null || qVec.length === 0) return emptyResult()
  const queryVec = Float32Array.from(qVec[0]!)
  // R34D-32（三十四轮）：查询向量同走 double→Float32 收窄——溢出分量（有限 double
  // 物化后 ±Infinity）会把对全库的相似度算成 NaN、topK 排序整体失真（与入库侧
  // commitIndexBatch 同款洞的召回半边）；降级返回空（fail-closed，与端点失败口径一致）
  if (queryVec.some((x) => !Number.isFinite(x))) {
    log.warn('rag', 'embedding 查询向量含 Float32 溢出分量（double 有限但物化后非有限）——本轮召回降级为空')
    return emptyResult()
  }

  if (indexedDim && Number(indexedDim) !== queryVec.length) return emptyResult()

  const qNorm = l2Norm(queryVec)
  const hits: RecallHit[] = chunks
    .filter((c) => c.model === config.model && c.embedding.length === queryVec.length)
    .map((c) => {
      // R64-45（十二轮）：召回内联余弦合流到 store.ts 单源——预存范数（最终 L2 口径）
      // 经 precomputed 复用免重算；norm 异常缺失时现算兜底（不因迁移残缺弃块）
      const cNorm = c.norm !== null && c.norm > 0 ? c.norm : l2Norm(c.embedding)
      return {
        章号: c.章号,
        start_offset: c.start_offset,
        end_offset: c.end_offset,
        score: cosineSimilarity(queryVec, c.embedding, { normA: qNorm, normB: cNorm }),
      }
    })

  hits.sort((a, b) => b.score - a.score)

  // A3 倒序校验：按分数序逐章校验指纹，fresh 章 chunk 直接收，stale 章 chunk 剔除、
  // 顺位递补；已判章不重复校验（同章多块只读一次文件）。候选章数达 K' 仍未凑满
  // topK（重 staleness 场景）→ 未验证章不收（宁缺毋滥，不放宽校验）。
  // R35-42（三十五轮）：深度耗尽只停「校验新章」（continue 跳过未验证章）——原 break
  // 把断点后已验证 fresh 章的高分命中一并丢弃，topK 可能填不满
  const verdict = new Map<number, boolean>()
  const out: RecallHit[] = []
  for (const h of hits) {
    if (out.length >= topK) break
    let fresh = verdict.get(h.章号)
    if (fresh === undefined) {
      if (verdict.size >= candidateDepth) continue
      fresh = chapterFingerprintFresh(chapterByNumber.get(h.章号), indexedFingerprints)
      verdict.set(h.章号, fresh)
    }
    if (fresh) out.push(h)
  }
  return { hits: out, truncated, totalBlocks }
}

/** 兼容包装（R73-12）：签名与返回（RecallHit[]）保持不变。R37-40（三十七轮）头注
 *  如实化——此前例举「既有消费面（materials.ts 等）」已失实：materials.ts 已于
 *  R36-16 切 recallDetailed，现生产代码零调用方，本包装仅服务存量测试面
 *  （test/rag/*、test/studio/* 的旧断言）。丢弃 truncated/totalBlocks 属有意取舍，
 *  生产召回链路一律走 recallDetailed（截断信号不丢失）。 */
export async function recall(
  bookRoot: string,
  config: RagConfig,
  apiKey: string,
  query: string,
  topK = 5,
  embedFn: typeof embed = embed,
  warnThreshold = RAG_CHUNK_WARN_THRESHOLD,
): Promise<RecallHit[]> {
  const r = await recallDetailed(bookRoot, config, apiKey, query, topK, embedFn, warnThreshold)
  return r.hits
}
