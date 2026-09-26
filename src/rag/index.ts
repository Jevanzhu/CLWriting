/**
 * RAG 建索引 + 召回 —— 依据 #37 spec 第 4/5 节。
 *
 * 分块 → 外部 embed → 存 .cache/rag.db（增量）→ 召回（query embed → 全表余弦 topK）。
 *
 * 复用：readChapterDir 遍历 写作/正文 全量（含未定稿草稿——召回服务写作连续性检索，
 * 最近未定稿章恰是高价值检索面；召回侧 chapterFingerprintFresh 惰性校验丢弃过期章，
 * buildIndex 增量自愈覆盖新指纹）；召回返回位置（章号+偏移），原文交精准读取。
 * 红线：账本永走精准读取不走 RAG；端点挂/未配 key → 召回空（降级回落，不崩）。
 *
 * 互斥依赖登记：本域（buildIndex/resetRagIndex 等）无自有跨进程
 * 互斥，依赖 rag/build・rag/rebuild 端点的任务闸（studio server api/rag.ts 的
 * acquireTaskGate(bookName,'rag-build')）兜住单实例并发；双进程并行 rebuild 与 build
 * 交错时靠 SQLite 写原子（BEGIN IMMEDIATE 单事务）+ 指纹幂等收敛（重复嵌入的块被
 * 唯一键覆盖、指纹以末写为准）——双份 embed 费用浪费为已知取舍。
 *
 * （⑤④产品拆分波2）拆分沿革：本文件纯移动拆分为三——
 *  - 缝 A 分块（TextChunk / MAX_CHUNK_CHARS / SENTENCE_ENDERS / chunkBody /
 *    pushSegmentChunks / subdivideSegment / isHighSurrogate）→ rag/chunk.ts（纯函数
 *    零依赖）；
 *  - 缝 B 建索引（ragIndexState 族 / buildIndex / commitIndexBatch / chapterHashKey /
 *    hashChapterBody / readChapterFingerprint / dedupeChaptersByNumber /
 *    chapterFingerprintFresh / RAG_RESET_MARKER_KEY / resetRagIndex /
 *    cleanupRagAfterMerge / recordEmbedUsage / embedOptionsFor / errStr）→ rag/build.ts；
 *  - 本文件留召回残核（RAG_CHUNK_WARN_THRESHOLD / estimateRagChunkCount / RecallHit /
 *    RecallResult / recallDetailed / recall），并逐名 re-export 拆出件（chunkBody /
 *    TextChunk / buildIndex / BuildIndexResult / resetRagIndex / RAG_RESET_MARKER_KEY /
 *    cleanupRagAfterMerge / ragIndexState）——消费方 import 面零改动。召回侧复用的
 *    build 侧内部件（embedOptionsFor / ragIndexStateOfOpenDb / dedupeChaptersByNumber /
 *    chapterFingerprintFresh）唯一持有者 = rag/build.ts，本文件 import 消费；本域
 *    无模块级可变单例状态（常量/纯函数域），模块缓存语义不变。
 */

import { join } from 'node:path'
import { readChapterDir } from '../format/chapters.js'
import {
  openRagDb,
  closeRagDb,
  getRagMeta,
  readAllChapterFingerprints,
  countChunksByChapter,
  streamChunkScores,
  ragDbExists,
  type ChunkScoreRow,
} from './store.js'
import { embed } from './embed.js'
import type { RagConfig } from './config.js'
import { log } from '../log/index.js'
import { embedOptionsFor, ragIndexStateOfOpenDb, dedupeChaptersByNumber, chapterFingerprintFresh } from './build.js'

// re-export 桥：拆出件的既有导出面逐名透传，消费方 import 面零改动。
export { chunkBody, type TextChunk } from './chunk.js'
export {
  buildIndex,
  resetRagIndex,
  cleanupRagAfterMerge,
  ragIndexState,
  RAG_RESET_MARKER_KEY,
  type BuildIndexResult,
} from './build.js'

/** 召回块数告警阈值——超出 store.ts readAllChunks 量化注释的已知
 *  可用区间（十万块）时 log.warn 留痕。
 * 同时是硬截断上限——超区间全表余弦线性扫描延迟已超交互预期，截到上限
 *  并告警（截断取读出序前缀，非按相似度——排序发生在截断之后）。 */
export const RAG_CHUNK_WARN_THRESHOLD = 100_000

/** 阶段 24：合并干跑的 RAG 清除预估——源章向量块数合计（只读；库不存在/读失败 → 0，
 *  ragDbExists 守卫避免为预估落空建库）。 */
export function estimateRagChunkCount(bookRoot: string, chapters: number[]): number {
  if (chapters.length === 0 || !ragDbExists(bookRoot)) return 0
  try {
    const db = openRagDb(bookRoot)
    try {
      let n = 0
      for (const c of chapters) n += countChunksByChapter(db, c)
      return n
    } finally {
      closeRagDb(db)
    }
  } catch {
    return 0
  }
}

export interface RecallHit {
  章号: number
  start_offset: number
  end_offset: number
  score: number
}

/**
 * 召回结果结构化出口——truncated 标记上抛。
 * 召回池超 10 万块（RAG_CHUNK_WARN_THRESHOLD）被硬截断时，旧口径仅 log.warn 留痕、
 * 前端/消费面无感。本结构把截断事实作为数据返回，供消费方在 prompt 组装等处留痕。
 * materials.ts 已切本结构化出口消费（ragTruncated/ragNote 透出），
 * 兼容包装 recall 仅服务存量测试面。
 */
export interface RecallResult {
  hits: RecallHit[]
  /** 召回池超上限被硬截断（读出序前缀保留、尾部丢弃，非按相似度裁剪） */
  truncated: boolean
  /** 截断前的全量块数（truncated=false 时 = 参与召回的块数；起截断态封顶为
   *  阈值+1——召回侧早停读 N+1 条即判 truncated，不再为计数全表读回） */
  totalBlocks: number
  /** 空库态附带的索引三态（unbuilt=从未建索引 / cleared=重建已清空），
   *  仅空库早退路径携带——有命中即已建（built），其余空结果出口（未配置/端点失败/模型
   *  失配等）不带本字段（语义属配置/网络面，非库状态面）。消费方可据此把「未建索引」
   *  与「建了但无命中」区分开。 */
  indexState?: 'unbuilt' | 'cleared'
}

/**
 * 召回（query embed → 全表点积排序 → 候选子集惰性指纹校验 → topK）。
 * 失败/降级返回空数组（#37 第 6.2 节，不崩）。
 *
 * （K'=20 写死 + book.yaml rag.candidate_depth 可覆盖）
 * - 预存范数：chunks.norm 建索引时算好，余弦退化为 dot(q,c)/(||q||·c.norm)，数学量减半；
 * - 倒序校验：先前每次召回对全书逐章读文件校验 SHA-256 指纹（700 章 = 700 次全文
 *   读，大概率慢过余弦本身）——改为先排序，只校验命中候选的章（≤ K'），过期章剔除、
 *   顺位递补至 topK；校验从「整批拒绝闸」变为「过滤闸」，召回质量不降（过期向量
 *   本就不该命中），新鲜数据的 top-5 与全量校验口径逐一等价。
 *
 * 可选 `opts.signal`——编排级中断透传（materials 备料
 * 传入编排 signal，向后兼容：旧调用方零变更）。检查点：函数入口 / embed 网络往返前后
 * / 流式打分循环（store.streamChunkScores），命中即抛「RAG 召回已中断」——与 embed
 * 失败同走 throw 形态（本函数既有错误形态：网络/库异常上抛，由调用方降级），中断不再
 * 白烧 embed 调用与全表扫描。
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
  /** 块数告警阈值（测试注入用，默认 RAG_CHUNK_WARN_THRESHOLD） */
  warnThreshold = RAG_CHUNK_WARN_THRESHOLD,
  /** 编排级中断信号（可选；预先 aborted → 快速中断不发起 embed） */
  opts?: { signal?: AbortSignal },
): Promise<RecallResult> {
  // 入口检查点——预先 aborted 直接中断态上抛，不开库不发起 embed
  if (opts?.signal?.aborted) throw new Error('RAG 召回已中断')
  // 空结果每出口返回新字面量——共享同一可变对象会被消费方
  // 改动污染（进程内后续空召回带着被塞进的脏 hits/truncated）
  const emptyResult = (): RecallResult => ({ hits: [], truncated: false, totalBlocks: 0 })
  if (!config.enabled || !config.endpoint || !config.model) return emptyResult()

  // 下界钳制（低级项）：书里配 0/负数时首轮 `verdict.size >= 0` 恒 break，
  // 召回恒空静默降级为「无 RAG」且无告警——读侧已拒非法值，这里再兜一层防直调/测试路径
  const candidateDepth = Math.max(1, Math.floor(config.candidate_depth ?? 20))

  // 先取数后联网——db 数据（chunks/元信息/指纹元数据）全部在 close 前完成，
  // embed 网络往返（≤30s）不再持有 db 句柄；空库直接返回不烧 API 调用。
  const db = openRagDb(bookRoot)
  // 截断事实随结构化出口上抛（旧口径仅 log.warn，前端无感）
  let truncated = false
  let totalBlocks = 0
  let indexedDim: string | null = null
  let indexedFingerprints!: Map<number, string>
  try {
    const indexedModel = getRagMeta(db, 'embedding_model')
    // 模型失配静默空召回补 warn——消费方此前无从
    // 区分「模型失配」与「无相关内容」，排障零线索（860 溢出 / :878 poisonRows 等
    // 降级出口均有留痕，本出口漏网）
    if (indexedModel && indexedModel !== config.model) {
      log.warn('rag', `RAG 索引模型失配（索引=${indexedModel} 配置=${config.model}）——本轮召回降级为空`)
      return emptyResult()
    }

    // 召回改流式打分——此前 readAllChunks 把全部块向量（1536 维
    // Float32Array ≈6KB/块）整池读回，全池跨下方 embed 网络往返窗（≤30s）驻留：3.5 万
    // 块（200 万字口径）≈215MB，硬截断上限 10 万块档 ≈590-615MB，2-3 路并发召回即
    // OOM/长 GC 风险（内存账：100K 阈值旧注只记延迟账）。改两段式：本段只做元
    // 数据预检（模型失配/空库早退不烧 API 调用），embed 后重开库流式逐行打分——
    // embedding BLOB 用完即弃，只留轻量命中元组（≈40B/块，10 万块档 ≈4MB）。
    // 打分语义与「全量读回 → filter(model/维度) → map 余弦 → 稳定 sort」逐位等价
    //（rowid 行序 + 元组按行序追加，并列分数的次序不变），见 store.ts streamChunkScores。
    const hasRow = db.prepare('SELECT EXISTS(SELECT 1 FROM chunks LIMIT 1) AS has').get() as { has: number }
    if (hasRow.has === 0) {
      // 空库早退附索引三态——「从未建索引」（unbuilt）与「重建清空后可用」
      //（cleared）可区分（此前两者同样静默空手，与损坏库（开库即抛）在消费方视角
      // 不可分辨，排障无从下手）；不烧 API 调用的早退语义不变
      return {
        hits: [],
        truncated: false,
        totalBlocks: 0,
        indexState: ragIndexStateOfOpenDb(db) === 'cleared' ? 'cleared' : 'unbuilt',
      }
    }
    indexedDim = getRagMeta(db, 'embedding_dim')
  } finally {
    closeRagDb(db)
  }

  // 网络段（无 db 句柄）
  // embed 前检查点（元数据预检段耗时后信号可能已置位）
  if (opts?.signal?.aborted) throw new Error('RAG 召回已中断')
  const qVec = await embedFn(config.endpoint, config.model, apiKey, [query], embedOptionsFor(bookRoot, config))
  // embed 返回后检查点——网络往返窗口内的中断不再进入全表扫描
  if (opts?.signal?.aborted) throw new Error('RAG 召回已中断')
  if (qVec === null || qVec.length === 0) return emptyResult()
  const queryVec = Float32Array.from(qVec[0]!)
  // 查询向量同走 double→Float32 收窄——溢出分量（有限 double
  // 物化后 ±Infinity）会把对全库的相似度算成 NaN、topK 排序整体失真（与入库侧
  // commitIndexBatch 同款洞的召回半边）；降级返回空（fail-closed，与端点失败口径一致）
  if (queryVec.some((x) => !Number.isFinite(x))) {
    log.warn('rag', 'embedding 查询向量含 Float32 溢出分量（double 有限但物化后非有限）——本轮召回降级为空')
    return emptyResult()
  }

  if (indexedDim && Number(indexedDim) !== queryVec.length) {
    // 维度失配静默空召回补 warn（同模型失配出口）
    log.warn('rag', `RAG 索引维度失配（索引=${indexedDim} 查询=${queryVec.length}）——本轮召回降级为空`)
    return emptyResult()
  }

  // 流式打分段：重开库逐行算余弦——段内无网络等待，句柄随段开关（
  // 纪律不变）。重开间隙索引被重建换模型的竞态 → 二次模型校验 fail-closed 回空。
  let rows: ChunkScoreRow[]
  {
    const db2 = openRagDb(bookRoot)
    try {
      const indexedModel2 = getRagMeta(db2, 'embedding_model')
      if (indexedModel2 && indexedModel2 !== config.model) {
        // 重开库二次模型校验（索引竞态重建）同补 warn
        log.warn('rag', `RAG 索引模型失配（二次校验：索引=${indexedModel2} 配置=${config.model}）——本轮召回降级为空`)
        return emptyResult()
      }
      // 读侧早Stop传「告警阈值+1」——得 N+1 条 ⟺ 全量 > N
      //（truncated 判定恒等）；不足 N+1 条 ⟺ 全量 = 读得数（totalBlocks 仍精确）。
      // 块数超已知可用区间（十万块，见 store.ts 量化注释）时告警 + 硬截断
      //（截断取读出序前缀 + warn 留痕，配额数值与告警阈值同一常量）
      // signal 透传进流式打分循环（行级检查点，见 store.ts streamChunkScores）
      const scanned = streamChunkScores(db2, queryVec, config.model, warnThreshold + 1, opts?.signal)
      if (scanned.poisonRows > 0) {
        log.warn(
          'rag',
          `RAG 库含 ${scanned.poisonRows} 行毒向量块（历史 Float32 溢出入库：norm 非有限或 norm=NULL 且向量含非有限分量）——已剔除不参与召回，建议重建索引（POST /rag/rebuild）清根`,
        )
      }
      totalBlocks = scanned.produced
      if (scanned.produced >= warnThreshold) {
        // 探针行（第 N+1 个产出，追加序最末）照旧例从命中集中剔除——旧实现
        // slice(0, warnThreshold) 作用在读回数组上，语义 = 截断后不参与排序
        // （评审）：produced 计数先于 model/维度过滤（store.ts），探针行
        // 可以是不匹配行而**未入 rows**——仅当最后产出行确为命中
        //（lastProducedWasMatch）才 pop；盲 pop 会错删第 N 个合法命中
        // 2-（GLM-5.3，RAG 域 -②）：truncated 判定
        // 对齐 pop 侧口径改「确实丢弃命中行才 true」——旧判定 produced >
        // warnThreshold 在「全表恰为 warnThreshold+1 行且探针行非命中」时误报
        // （探针未入 rows、零命中被丢，消费方却被告知还有块被截掉）。与 pop 同
        // 条件后：true ⟺ 本次确实从命中集中 pop 掉一行；超出扫描窗的未扫行
        // 不翻转信号（早停语义已由 warn 日志承载）。
        truncated = scanned.produced > warnThreshold && scanned.lastProducedWasMatch
        if (truncated) scanned.rows.pop()
        log.warn(
          'rag',
          `召回块数超已知可用区间（${warnThreshold}）——线性扫描延迟可能超预期，建议评估 FTS/向量索引${truncated ? `；已硬截断至 ${warnThreshold} 块` : ''}`,
        )
      }
      rows = scanned.rows
      // 指纹元数据整表读内存（单 SELECT 零文件 IO），闭库后候选子集校验用
      indexedFingerprints = readAllChapterFingerprints(db2)
    } finally {
      closeRagDb(db2)
    }
  }

  // 章号 → meta（readChapterDir 有 stat 级缓存，热路径零文件读；校验只读候选章文件）。
  // 与 buildIndex 同口径去重（保入序首个）——不去重时 Map 后者覆盖，
  // 指纹校验读到重复章号的另一文件，与已存指纹永远错配，该章命中被整体误杀。
  // 2-（GLM-5.3，RAG 域 -①）：原注「保路径字典序
  // 首个」系改造前旧文案——dedupeChaptersByNumber 本体与 buildIndex 侧
  // （上方两处）均已改「入序首个」，此处漏改；仅对齐注释，零行为改动。
  // 章号集合只按命中元组收窄（此前按全部读回块，流式下命中集 ⊆ 读回集，
  // 校验面等价——chapterByNumber 只被命中章消费）
  const bodyDir = join(bookRoot, '写作', '正文')
  const chapterNumbers = new Set(rows.map((r) => r.章号))
  const chapterByNumber = new Map(
    dedupeChaptersByNumber(readChapterDir(bodyDir).chapters)
      .chapters.filter((ch) => chapterNumbers.has(ch.章号))
      .map((ch) => [ch.章号, ch] as const),
  )

  const hits: RecallHit[] = rows.map((r) => ({
    章号: r.章号,
    start_offset: r.start_offset,
    end_offset: r.end_offset,
    score: r.score,
  }))

  hits.sort((a, b) => b.score - a.score)

  // 倒序校验：按分数序逐章校验指纹，fresh 章 chunk 直接收，stale 章 chunk 剔除、
  // 顺位递补；已判章不重复校验（同章多块只读一次文件）。候选章数达 K' 仍未凑满
  // topK（重 staleness 场景）→ 未验证章不收（宁缺毋滥，不放宽校验）。
  // 深度耗尽只停「校验新章」（continue 跳过未验证章）——原 break
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

/** 兼容包装：签名与返回（RecallHit[]）保持不变。头注
 *  如实化——此前例举「既有消费面（materials.ts 等）」已失实：materials.ts 已于
 * 切 recallDetailed，现生产代码零调用方，本包装仅服务存量测试面
 *  （test/rag/*、test/studio/* 的旧断言）。丢弃 truncated/totalBlocks 属有意取舍，
 *  生产召回链路一律走 recallDetailed（截断信号不丢失）。
 * @internal test-only：本应随生产零调用方删除，但存量测试消费面
 *  实测 10 文件 34 处调用（test/rag 8 + test/studio 1 + test/check 1）超本轮「>5 文件
 *  可降级」闸——登记维持：形状转换平凡（r.hits 透传，无维护风险），生产 import 面
 *  已零引用；后续批次改造存量断言为 recallDetailed 时随改造一并删除本包装。 */
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
