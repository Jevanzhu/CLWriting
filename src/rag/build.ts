/**
 * RAG 建索引（缝 B）—— （⑤④产品拆分波2）自 rag/index.ts 纯移动
 * 拆出：ragIndexState 族 / buildIndex / commitIndexBatch / chapterHashKey /
 * hashChapterBody / readChapterFingerprint / dedupeChaptersByNumber /
 * chapterFingerprintFresh / RAG_RESET_MARKER_KEY / resetRagIndex / cleanupRagAfterMerge /
 * recordEmbedUsage / embedOptionsFor / errStr 原样随迁（零行为变化，历史注释原样随代码
 * 迁移）。分块工具在 rag/chunk.ts；召回残核（recall/recallDetailed/
 * estimateRagChunkCount）留 rag/index.ts，并逐名 re-export 本文件导出面（消费方
 * import 面零改动）；召回侧复用的内部件（embedOptionsFor / ragIndexStateOfOpenDb /
 * dedupeChaptersByNumber / chapterFingerprintFresh）唯一持有者即本文件，export 供
 * index.ts 消费。依赖方向：rag→ai（recordTaskUsage 记账）在 AI 层内合法，绝无
 * studio import（方向锁）。域总述头注（含互斥依赖登记）见
 * RAG 建索引（缝 B）——（⑤④产品拆分波2）自 rag/index.ts 纯移动
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readChapterDir } from '../format/chapters.js'
import { readFile } from '../format/frontmatter.js'
import { parseChapterFileName } from '../format/words.js'
import {
  openRagDb,
  closeRagDb,
  safeRollback,
  storeChunk,
  readAllChapterFingerprints,
  getRagMeta,
  setRagMeta,
  deleteRagMeta,
  deleteChunksByChapter,
  getIndexedChapterNumbers,
  isRagDbCorruptionError,
  deleteRagDbFiles,
  ragDbExists,
} from './store.js'
import { embed, type EmbedOptions } from './embed.js'
import type { RagConfig } from './config.js'
import type { DatabaseSync } from 'node:sqlite'
import type { ChapterMeta } from '../format/types.js'
import { log, errMsg } from '../log/index.js'
import { recordTaskUsage } from '../ai/calls.js'
import { chunkBody, type TextChunk } from './chunk.js'

/** embedding 用量记账——端点随响应下发 usage.prompt_tokens 时经 onUsage
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

/** build/recall 共用的 embed 调用选项：超时显式 resolve 自 RagConfig，
 * 用量走 rag-embed 记账。 */
export function embedOptionsFor(bookRoot: string, config: RagConfig): EmbedOptions {
  return {
    timeoutMs: config.embed_timeout_ms,
    onUsage: (pt) => recordEmbedUsage(bookRoot, pt),
  }
}

function chapterHashKey(chapterNumber: number): string {
  return `chapter_hash:${chapterNumber}`
}

/** 错误信息提取（事务回滚返回用）。 */
function errStr(e: unknown): string {
  return errMsg(e)
}

// 指纹只摘 body——分块与 embedding 的输入只有正文，frontmatter
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
 * 重复章号确定性归一——cache/foreshadow 侧均承认可产生两文件同
 * 章号的数据态。精准读取（materials readChapterBodyByNumber → walkMdFind）按章号取
 * 目录序首个匹配文件；索引侧若把两文件的块都挂同章号入库，后者文件的偏移切片会落在
 * 首个文件正文上（错位片段）。保留策略从「路径字典序最小」改为
 * 「入序首个」（调用方 chapters 来自 readChapterDir 的 walk 序，与 walkMdFind 同源）
 * ——两序不一致时字典序近似会让索引挂的文件与读取命中的文件不同，「防偏移错位」在
 * 告警窗外依旧发生；首个命中策略下两侧恒同文件。跳过项照旧交调用方告警留痕。
 */
export function dedupeChaptersByNumber(chapters: ChapterMeta[]): { chapters: ChapterMeta[]; dropped: ChapterMeta[] } {
  const kept = new Map<number, ChapterMeta>()
  const dropped: ChapterMeta[] = []
  for (const ch of chapters) {
    if (kept.has(ch.章号)) {
      dropped.push(ch)
    } else {
      kept.set(ch.章号, ch)
    }
  }
  const keptSet = new Set(kept.values())
  return { chapters: chapters.filter((ch) => keptSet.has(ch)), dropped }
}

/**
 * 惰性指纹校验的单章口径（recall 候选子集用）。
 * 章 meta 缺失（正文文件不在了）→ false；指纹元数据缺失/不符 → false。
 * 不合格只剔除该章（老口径整批拒绝——倒序校验后语义为过滤闸，见 recall）。
 */
export function chapterFingerprintFresh(
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
  /** 本次新索引的块数。口径：= 本轮实际新嵌入并落库的块数——指纹
   *  比对命中而跳过的既有章/块不计（toIndex 只收新章与失配章）；增量与续传（部分
   *  成功后重跑）两轮计数之和即真实新嵌总数，UI 进度与实际嵌入数一致。 */
  chunkCount: number
  /** 覆盖的章数（同上口径：本轮实际提交指纹的章数，跳过章不计；零块章计章不计块） */
  chapterCount: number
  error?: string
}

/**
 * 重建索引前置——清空本书 RAG 库（chunks 全部行 + rag_meta 全部键：
 * 模型/维度/游标/指纹一并清）。修复「请重建索引」死路：此前模型/维度失配后 buildIndex
 * 硬错、无程序化出路（只能手工删 .cache/rag.db）。取「清表不删文件」口径（优先级裁定）：
 * 保留 openRagDb 的建表/norm 迁移/WAL 语义，避开删库重建与并发开库的竞态窗口。
 * 幂等：空库再清一次无害；失败回滚可重试。由 rag/rebuild 端点在建索引任务闸内调用。
 * 清表后同事务落 reset 标记——「清表不删文件」口径下清空库与「从未
 * 建索引」（recall 对未建书 openRagDb 会落空建 db）凭内容不可区分；标记让 ragIndexState
 * 能给出 cleared（已清空可用）而非 unbuilt。标记对既有消费者惰性（无一方读该键），
 * buildIndex 内容落位后状态自然转 built，标记残留无害。
 */
export const RAG_RESET_MARKER_KEY = 'reset_at'

export function resetRagIndex(bookRoot: string): void {
  // 文件级损坏（断电/磁盘故障/杀软半写后的非 SQLite 字节流，
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
      // 同款加固——SQLite 部分错误（SQLITE_FULL/IOERR 等）
      // 已自动回亡事务，再 ROLLBACK 抛 "no transaction is active" 掩蔽原始写错误；
      // 吞 ROLLBACK 自身异常、原始错误上抛
      // 回滚句收编 store.ts safeRollback 单源。
      safeRollback(db)
      throw new Error(`清空 RAG 索引失败（已回滚，可重试）：${errStr(e)}`)
    }
  } finally {
    closeRagDb(db)
  }
}

// ── 阶段 24 章节结构操作：合并后 RAG 清理（best-effort，不阻断主流程）──────

/** 阶段 24：合并落定后的 RAG 清理——源章号 `deleteChunksByChapter` + `deleteRagMeta`
 * 成对（同款：章号从索引域整体摘除）+ 目标章 `deleteRagMeta`（指纹失效 →
 *  missingFingerprint，下轮 buildIndex 按合并后正文重嵌）。事务包裹（BEGIN IMMEDIATE
 *  … COMMIT，stale 清理 :393-426 同款先例）；任何失败 warn 回滚不抛——RAG 是投影非
 *  权威源，自愈兜底 = 下轮 buildIndex 的已删章残留清理 + stale 指纹重嵌。 */
export function cleanupRagAfterMerge(bookRoot: string, sourceChapterNos: number[], targetChapterNo: number): void {
  if (!ragDbExists(bookRoot)) return
  try {
    const db = openRagDb(bookRoot)
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const n of sourceChapterNos) {
          deleteChunksByChapter(db, n)
          deleteRagMeta(db, chapterHashKey(n))
        }
        deleteRagMeta(db, chapterHashKey(targetChapterNo))
        db.exec('COMMIT')
      } catch (e) {
        safeRollback(db)
        log.warn('rag', `合并后 RAG 清理失败（已回滚，下轮建索引自愈）：${errStr(e)}`)
      }
    } finally {
      closeRagDb(db)
    }
  } catch (e) {
    log.warn('rag', `合并后 RAG 清理开库失败（忽略，下轮建索引自愈）：${errStr(e)}`)
  }
}

/** RAG 索引库三态（+损坏）探测口径——
 *  - unbuilt：从未建索引（库文件不存在，或库可开但无任何索引内容且无 reset 标记；
 *    recall 对未建书 openRagDb 落空建 db 后同此态）
 *  - cleared：resetRagIndex 清表不删文件口径下的「已清空可用」态（reset 标记在位
 *    且无任何索引内容）
 *  - built：有索引内容（向量 / 章指纹 / 游标 / 模型任一在位——零块章建库只有指纹+
 *    游标，也算 built）
 *  - corrupt：库文件级损坏（openRagDb 抛 SQLITE_NOTADB 族；区别于 db 语义错误——
 *    后者原样上抛）。供 status/recall 链路把「未建 / 已清空可用 / 损坏」透出，
 *    未建书的空命中不再与损坏库混淆（排障面）。 */
type RagIndexState = 'unbuilt' | 'cleared' | 'built' | 'corrupt'

/** 已开库的三态判定（recall 空库早退路径共享，免二次开库）。 */
export function ragIndexStateOfOpenDb(db: DatabaseSync): Exclude<RagIndexState, 'corrupt'> {
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
    closeRagDb(db)
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
    // 文案「定稿」→「正文」——本模块
    // 头注明示索引进全量正文（含未定稿草稿，召回服务写作连续性检索），空语料降级
    // 文案却宣称只认定稿，误导排查方向（作者会误以为先定稿才能建索引）
    return { ok: false, chunkCount: 0, chapterCount: 0, error: '没有正文可索引。' }
  }
  const { chapters: chaptersFromDir, errors } = readChapterDir(bodyDir)
  if (chaptersFromDir.length === 0) {
    return { ok: false, chunkCount: 0, chapterCount: 0, error: '没有正文可索引。' }
  }
  // 重复章号去重 + 告警——无告警时两文件同章号的块全入库，召回
  // 偏移对精准读取可错位。注释与告警文案对齐实现口径
  // （保留「入序首个」，walk 序与 walkMdFind 同源）——原「路径字典序首个」系改造前
  // 旧文案，误导排查方向。
  const { chapters, dropped } = dedupeChaptersByNumber(chaptersFromDir)
  if (dropped.length > 0) {
    log.warn(
      'rag',
      `检测到重复章号（${dropped.map((ch) => `第 ${ch.章号} 章（${basename(ch._path ?? '')}）`).join('、')}）——每章号仅保留目录序（walk 序）首个文件参与索引，重复文件不建索引（其偏移会与精准读取错位），请修复章号后重跑`,
    )
  }
  // frontmatter 解析失败章号集——文件名仍带章号（<章号>-<标题>.md），
  // 按 basename 反推；名字也不可解析的（无章号前缀）无从保护，退回原口径。
  const brokenChapterNums = new Set<number>()
  for (const err of errors) {
    const n = parseChapterFileName(basename(err.file))?.章号
    if (n !== undefined) brokenChapterNums.add(n)
  }
  if (brokenChapterNums.size > 0) {
    log.warn(
      'rag',
      `${brokenChapterNums.size} 章正文 frontmatter 解析失败（章号：${[...brokenChapterNums].sort((a, b) => a - b).join('、')}）——本轮索引跳过且保留其既有向量，修复后自动恢复`,
    )
  }

  // 增量路径对齐同文件 reset/
  // state 路径的损坏自愈——文件级损坏（SQLITE_NOTADB 族）此前裸抛英文 SQLite 错，
  // 建索引入口（作者自救的第一操作）同死；确认损坏后删库（连 -wal/-shm）全新建，
  // 全量重建由增量逻辑自然承接（空库无指纹/游标 → 全部章落入 toIndex）。busy/IO
  // 等可重试错误照旧上抛——绝无「误判损坏 → 白白整库重嵌」面（口径同 resetRagIndex）。
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
    const indexedModel = getRagMeta(db, 'embedding_model')
    if (indexedModel && indexedModel !== config.model) {
      return {
        ok: false,
        chunkCount: 0,
        chapterCount: 0,
        // 文案指向 rag/rebuild 重建端点——原「请重建索引」无程序化
        // 出路（前端按钮本轮未加，不虚构入口，如实写接口）
        error: `embedding 模型与现有索引不一致（现有：${indexedModel}，当前：${config.model}），请重建索引（POST /rag/rebuild）后重试。`,
      }
    }

    // 清理已删除章的残留向量/指纹——增量游标只看章号上限，删中间章
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
        // 解析失败章排除出 stale 差集——fm 坏的章只是「本轮读不出」，
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
            // 同款加固——SQLite 部分错误已自动回亡事务，再
            // 再 ROLLBACK 抛 "no transaction is active" 掩蔽原始写错误；吞 ROLLBACK
            // 自身异常、原始错误进返回文案
            // 回滚句收编 store.ts safeRollback 单源。
            safeRollback(db)
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
    // <=indexedMax 但无指纹的章（低章号补写/历史中断残留）不再要求删库
    // 重建——并入本轮重索引集合自愈闭环。
    // 指纹不符（正文已变更）同款并入自愈——旧口径硬错要求手工删
    // .cache/rag.db 全书重嵌（200 万字 ≈3.5 万块费用），而「回改草稿/定稿后修错字」是
    // 写作常态操作，一次编辑即让 build 永久报错。重索引走既有外科路径（commitIndexBatch
    // 事务内 deleteChunksByChapter 清旧块 + 重 embed + 覆盖指纹，偏移漂移残留同 missing 场景）。
    const missingFingerprint = new Set<number>()
    const staleFingerprint = new Set<number>()
    // 指纹循环顺手缓存已读 body——仅 missing/stale 命中章
    // 保留（未命中章读完即弃，不抬峰值内存），下方收集段复用：stale/missing 章此前在
    // 指纹循环与 toIndex 收集段各读一次全文，现至多读一次。指纹循环与收集段之间全同步
    // IO 无 await，缓存 body 与现读逐字节一致。指纹计算口径不变（readChapterFingerprint
    // 同式：readFile → hashChapterBody，查询侧 ：206 原函数保留不动）。
    // nano：顺手缓存指纹循环已算出的 body 哈希（staleHashes）——
    // 缓存 body 后收集段又对同一字节串 hashChapterBody 重算是白付；缓存命中章收集
    // 段直接复用，仅现读章（新章/指纹循环读失败章）现算。
    const staleBodies = new Map<number, string>()
    const staleHashes = new Map<number, string>()
    // 成本口径备案：指纹核对需逐章全文读+SHA-256（200 万字书每轮
    // build ≈8MB 读，秒级）——readChapterDir 的 (mtimeNs,size) 缓存只覆盖 meta 不覆盖
    // 指纹；引入 mtime 快路径会开「同 mtime 改内容」的漏检窗，有意不设，成本口径见此。
    // 后口径如实化：每章至多读一次全文（含 toIndex 收集段），全轮 ≈ 一遍全书；
    // 前 stale/missing 章另有收集段第二次全文读（读量随脏章数上浮）。
    for (const ch of chapters) {
      if (ch.章号 > indexedMax) continue
      if (!ch._path) continue // readChapterFingerprint 同式：无路径按读不出处理
      const r = readFile(ch._path)
      if (!r.ok) continue // 当前读不出 → 留给 toIndex 的读失败路径（下轮重试）
      const currentHash = hashChapterBody(r.body)
      const indexedHash = getRagMeta(db, chapterHashKey(ch.章号))
      if (!indexedHash) {
        missingFingerprint.add(ch.章号)
        staleBodies.set(ch.章号, r.body)
        staleHashes.set(ch.章号, currentHash) // nano：哈希随 body 顺手缓存
        continue
      }
      if (indexedHash !== currentHash) {
        staleFingerprint.add(ch.章号)
        staleBodies.set(ch.章号, r.body)
        staleHashes.set(ch.章号, currentHash) // nano：哈希随 body 顺手缓存
      }
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
    // 读失败为瞬时性（文件占用）——游标不越过失败章：本轮只收集首个
    // 读失败章之前的章，失败章及其后留给下轮重试，保证可自愈不死锁（修复前
    // continue 跳过但游标照常推进到 toIndex 最大章号，该章永久无指纹）
    let readFailAt: number | null = null
    for (const ch of toIndex) {
      // stale/missing 命中章复用指纹循环已读 body（不再第二次全文读盘）；
      // 其余（新章 >indexedMax / 指纹循环读失败章）照旧现读
      const cached = staleBodies.get(ch.章号)
      const r = cached !== undefined ? { ok: true as const, body: cached } : ch._path ? readFile(ch._path) : null
      if (!r || !r.ok) {
        readFailAt = ch.章号
        break
      }
      // nano：缓存命中章复用指纹循环已算哈希（同一字节串不再 SHA-256 重算）；
      // `??` 分支只落在现读章（新章/指纹循环读失败章——彼时未入 staleHashes）
      const cachedHash = staleHashes.get(ch.章号)
      chapterHashes.set(ch.章号, cachedHash ?? hashChapterBody(r.body))
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

    const committed = await commitIndexBatch(
      db,
      config,
      allChunks,
      chapterHashes,
      cursorTarget,
      embedFn,
      apiKey,
      embedOptionsFor(bookRoot, config),
    )
    if (!committed.ok && readFailAt !== null) {
      // 读失败与 embed 失败叠加时并列两成因——此前直接透传
      // embed 失败信封，「第 N 章正文读取失败」被丢弃（作者只见 embed 报错，修好端点
      // 重跑又撞读失败，第二成因无从预期）。只拼文案：ok/章块计数沿用 committed
      // （含续传口径），自愈游标纪律不变——游标仍不越失败章（commitIndexBatch 失败
      // 路径已按已提交章收口，本分支不动游标）。
      return {
        ...committed,
        error: `第 ${readFailAt} 章正文读取失败（可能被占用）；同轮另有索引失败：${committed.error}`,
      }
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
    closeRagDb(db)
  }
}

/** 块写入 + 游标/指纹同一事务——中断（崩溃/掉电）要么全入要么全无。
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
  // 批量 embed——分批防端点上限。修复前全量一次性单 POST：200 万字 ≈3.5 万块
  // 必超常见 embedding 端点的单请求上限（静默失败/截断）。分批按块数封顶
  //（100 块/ ≈ 10 万字量级，对 8k~32k token 输入模型都留足余量）。任一批失败不再
  // 整体报废——已成功批按「整章」小事务续传落库（见下）。
  const EMBED_BATCH_SIZE = 100
  // 既有索引维度进 embed 循环前先读——维度无法预知（同一模型
  // 名在不同端点/供应商可出不同维度），只能在首批返回后比对；旧口径在全部批次烧完后
  // 才检（下方收尾处），同模型名不同维的端点会把全书重嵌白烧完才报错。首批后即检：
  // 已烧成本封顶一个批次；失配收口沿用口径（硬错 + 指向 rebuild 端点显式
  // 重建，不自动清索引——网关维度抖动场景下自动清空会毁掉既有有效索引）。
  const existingIndexedDim = getRagMeta(db, 'embedding_dim')
  // 内存闸（审计）：批结果即转 Float32Array 驻留——原实现以 number[][]
  // 全量累积（8B/维，200 万字书 ≈ 430MB）到 COMMIT 才逐条 BLOB 化；即转后峰值减半
  //（≈215MB，与召回侧 readAllChunks 单份口径一致）。刻意不做「事务内逐批 embed 逐批
  // 写库」：BEGIN IMMEDIATE 跨 embed 网络往返会把同书 rag.db 写锁窗从 DB 写时长拉长
  // 到分钟级网络时长，阻塞并发 recall 读——锁窗与峰值二取其一，保锁窗（的续传
  // 小事务同样只在批边界同步执行、不跨网络往返，锁窗纪律不变）。
  const vectors: Float32Array[] = []
  // 章 → 其块在 allChunks 中的下标区间 [start, end)（块按章序收集，章内连续）
  const chapterSpans = new Map<number, { start: number; end: number }>()
  for (let i = 0; i < allChunks.length; i++) {
    const ch = allChunks[i]!.章号
    const span = chapterSpans.get(ch)
    if (span) span.end = i + 1
    else chapterSpans.set(ch, { start: i, end: i + 1 })
  }
  // 首个失败批的起始块下标；-1 = 全部成功
  let failedAt = -1
  // 维度基准——首批首行定基准，其后批/行全量比对
  let refDim: number | null = null
  for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
    const batchTexts = allChunks.slice(i, i + EMBED_BATCH_SIZE).map((c) => c.chunk.text)
    const batchVec = await embedFn(config.endpoint!, config.model!, apiKey, batchTexts, embedOptions)
    if (batchVec === null) {
      failedAt = i
      break
    }
    // 批内维度/条数校验——端点异常（混服降维模型/截断行）返回的
    // 混维行此前静默入库成「死行」：余弦召回对其算出 NaN/垃圾相似度还占索引位，用户
    // 只觉召回变差无从排查。任一批条数与请求文本数不符、或任一行维度偏离基准 → 该批
    // 按 embed 失败同款收口（failedAt 续传路径：批前整章小事务提交，混维批零入库）。
    if (refDim === null) refDim = batchVec[0]?.length ?? null
    // 首批后即检既有索引维度——批内校验（混维/条数）
    // 之后执行，批形异常仍归批失败路径；批形合法而维度对不上既有索引 → 当场硬错，
    // 不再继续烧后续批次（信封与既有收尾检查同一文案，消费方零感知差异）。
    if (existingIndexedDim && refDim !== null && Number(existingIndexedDim) !== refDim) {
      return {
        ok: false,
        chunkCount: 0,
        chapterCount: 0,
        error: `embedding 维度与现有索引不一致（现有：${existingIndexedDim}，当前：${refDim}），请重建索引（POST /rag/rebuild）后重试。`,
      }
    }
    if (batchVec.length !== batchTexts.length || batchVec.some((v) => v.length !== refDim)) {
      log.warn(
        'rag',
        `embedding 批响应条数/维度异常（期望 ${batchTexts.length} 行 × ${refDim ?? '?'} 维，实得 ${batchVec.length} 行）——该批起不入库，已成功部分续传`,
      )
      failedAt = i
      break
    }
    // Float32 溢出守卫——embed() 的 finite 校验在 double 层
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
    // 批次文本早释放——batchTexts/materialized 落 vectors 后置空
    // 对应 allChunks 槽位的 text（后文事务只读 章号/start/end，.text 零消费），全书
    // 块文本不再跨分钟级 embed 网络窗驻留（200 万字 ≈数十 MB 无谓半份；向量半份系
    // 闸的锁窗取舍保留，见上注）。
    const batchEnd = Math.min(i + EMBED_BATCH_SIZE, allChunks.length)
    for (let j = i; j < batchEnd; j++) allChunks[j]!.chunk.text = ''
  }
  if (failedAt >= 0) {
    // 部分成功续传——此前任一批失败即整体失败、已成功批向量
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
    // 维度守护：与既有索引维度不一致时不续传（该错要求重建索引，续传无意义）——
    // （§四/§六批2）：守护只约束「有向量待落库」
    // （span 非 null）的章。首批即失败（failedAt=0、vectors 空、vectorDim undefined）时
    // 原守卫 `complete.length > 0 && vectorDim && ...` 把仅含零块章的 complete 整体跳过
    // ——零块章指纹（无向量写入、无维度依赖）持续缺失到端点恢复。修复：零块章无条件
    // 可提交；vectors 空的事务不写 embedding_model/embedding_dim（与全成功路径
    // 「allChunks.length===0 不写模型/维度」同口径——零向量面无维度事实可登记，下轮
    // 有块章落库时自然补上；rebuild 清表对两类键一并清，无残留面）。章级不变量不变：
    // 每个提交章的删旧块/写块/指纹仍在同一小事务内。
    const vectorDim = vectors[0]?.length
    const indexedDim = getRagMeta(db, 'embedding_dim')
    const dimOk = vectorDim !== undefined && (!indexedDim || Number(indexedDim) === vectorDim)
    const toCommit = complete.filter(([, span]) => span === null || dimOk)
    if (toCommit.length > 0) {
      db.exec('BEGIN IMMEDIATE')
      try {
        let maxCommitted = 0
        for (const [ch, span] of toCommit) {
          // 删旧块不分有块/零块章——零块章（正文改成全 <20 字短段）
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
        if (dimOk) {
          setRagMeta(db, 'embedding_model', config.model!)
          setRagMeta(db, 'embedding_dim', String(vectorDim))
        }
        db.exec('COMMIT')
        salvaged = toCommit.length
        // 续传计数=本事务实际新嵌落库的块数（complete 章 span 覆盖的
        // 块；零块章计 0 块）——此前恒报 0/0，部分成功落库的章/块不进进度（UI 进度与
        // 实际嵌入数偏差）；重跑时已续传章经指纹比对跳过、不计入 toIndex，两轮计数
        // 之和=真实新嵌总数
        salvagedChunks = toCommit.reduce((n, [, span]) => n + (span ? span.end - span.start : 0), 0)
      } catch {
        // 续传失败不致命：回到旧行为（整体重跑），错误文案不带续传字样。
        // 同款加固——吞 ROLLBACK 自身异常（部分错误已
        // 自动回亡事务，再 ROLLBACK 抛 "no transaction is active"），保持「整体重跑」
        // 降级语义不因回滚句柄抖动旁生枝节
        // 回滚句收编 store.ts safeRollback 单源。
        safeRollback(db)
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
        // 同模型失配文案——指向 rag/rebuild 重建端点
        error: `embedding 维度与现有索引不一致（现有：${indexedDim}，当前：${vectorDim}），请重建索引（POST /rag/rebuild）后重试。`,
      }
    }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // 重索引章先清旧块。storeChunk 的唯一键是（章号, 偏移, 模型）——正文变更后
    // 偏移平移，旧块按新偏移插不中旧行而残留；missingFingerprint 自愈场景（历史半截库：
    // chunks 在、指纹缺）正是「正文已变过的章」，残留旧偏移块会让召回返回指向现正文
    // 错误区间的 offset。
    // 删旧块集合从「本轮有块的章」扩为「本轮全部待索引章」（chapterHashes
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
    // 同款加固——SQLite 部分错误已自动回亡事务，再
    // ROLLBACK 抛 "no transaction is active" 掩蔽原始写错误；吞 ROLLBACK 自身异常、
    // 自身异常、原始错误进返回文案
    // 回滚句收编 store.ts safeRollback 单源。
    safeRollback(db)
    return {
      ok: false,
      chunkCount: 0,
      chapterCount: 0,
      error: `索引写入失败（已回滚，可安全重跑）：${errStr(e)}`,
    }
  }

  return { ok: true, chunkCount: allChunks.length, chapterCount: chapterHashes.size }
}
