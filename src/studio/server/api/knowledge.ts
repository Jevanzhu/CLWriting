/**
 * 知识层端点（#8.3）：learn 文风收割闭环。
 *
 * - POST /api/books/:name/learn           → learnFromBook 产候选（规则打分，不涉大模型）
 * - POST /api/books/:name/learn-commit    body {samples, quotes} → commitSamples + commitQuotes 入库
 *
 * learn 候选制（品味归人）：产候选 → 作者勾选 → 入库，不自动入库。
 * 均直接调内核函数（不 spawn CLI，非交互）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { createTtlProbeCache } from '../ttl-cache.js'
import { bookMovedFailure, resolveBookOrReply } from '../book-context.js'
import { learnFromBook } from '../../../learn/index.js'
import { commitSamples, commitQuotes, defaultCommitYield, type CommitYield } from '../../../learn/commit.js'
import type { LearnResult, SampleCandidate, QuoteCandidate } from '../../../learn/index.js'
import { acquireTaskGate } from './task-gate.js' // RB-SV-P2-2：长任务并发闸
// R0911b-B-P3-2（2026-09-11 全量重评修复批）：token 死字段删除——写闸（index.ts isWrite
// safeTokenCompare）在路由分派前已拦一切 POST，R1010-P3 删 handler 内冗余复核后本 ctx
// 的 token 注入后零读取，随批删除
interface KnowledgeCtx {
  workDir: string | null
}

// ── R0911-B-P3-4（2026-09-11 全量重评 GLM-5.3 修复批）：非闸书级写端点的临界段书注册重验 ──
// learn-commit 无任务闸（books.ts 删书/改名的 busyGate 只查 spawn/三审/task-gate，看不见
// 在途 commit）——重验竞态时序与防线形态单源见 book-context.ts R0912-B-P3-2 头注
//（R0912-B-P3-2 起四处本地拷贝收敛，直接调用单源 bookMovedFailure）。同文件 /learn 有
// 'learn' 任务闸先于首个 await 占位，busyGate 可见，不在本竞态面内。

/** R0911-B-P3-4：让出点书注册重验失败的出口信号——经 commit 循环上抛（commit.ts 让出
 *  抛错 = 调用方中止信号），handler 统一映射 409 BOOK_MOVED；其余错误照原样上抛走
 *  dispatch 兜底（与修复前口径一致）。 */
class BookMovedSignal extends Error {}

/** R0911-B-P3-3：learn-commit 让出原语测试注入口（先例 __setLearnTtlForTest）——生产
 *  缺省真让出（setImmediate）；测试注入受控桩在让出点做确定性动作（计数/并发移书）。
 *  让出后的书注册重验在 handler 的包装层（不随桩替换），始终生效。 */
let learnCommitYieldPrimitive: CommitYield = defaultCommitYield
export function __setLearnCommitYieldForTest(fn: CommitYield | null): void {
  learnCommitYieldPrimitive = fn ?? defaultCommitYield
}

// ── R66-28（十四轮）：/learn 全书扫描的并发闸 + TTL 缓存 ──────────────────────
// learnFromBook 整读全书定稿正文（秒级 IO+CPU 段；R72-2 已 async 化，不再阻塞请求
// 线程，但同一把书并发闸仍必要）：重复点击 = 双跑双扫；health/files/documents 三处
// 同型已修，此处漏网。口径对齐 health.ts styleScanCache：5s TTL + 书键 Map FIFO 上限，
// 纯 TTL 无写路径失效挂点（learn 候选只读落盘 工作区/learn候选，书内容变化最迟 5s 可见）。
const LEARN_CACHE_TTL = 5000
const LEARN_CACHE_MAX = 32
/** R67-15（十五轮）：删书/改名失效挂点（同 health.ts forgetStyleScanCache 口径）。 */
export function forgetLearnCache(bookRoot: string): void {
  learnCache.forget(bookRoot)
}
/** R66-28：TTL 测试注入口（先例同 health.ts __setStyleScanTtlForTest）——真实 5s 墙钟
 *  依赖会让「失效重扫」用例慢机假红，测试注入短档消除。仅测试用。 */
let learnTtlMs: number | null = null
export function __setLearnTtlForTest(ms: number | null): void {
  learnTtlMs = ms
}

/** D1（复审-0914-优化修复批）：缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO +
 *  R47-18 过期逐出本地壳删除；命中/失效时序/逐出序逐位不变——纯 TTL + FIFO 32；
 *  「只缓存成功结果」收编 storeIf（R66-28 原口径：失败多为输入问题，重试应现算），
 *  见 ttl-cache.ts 头部收敛映射表）。 */
const learnCache = createTtlProbeCache<string, LearnResult>({
  name: 'learn',
  keyOf: (k) => k,
  max: LEARN_CACHE_MAX,
  ttl: () => learnTtlMs ?? LEARN_CACHE_TTL,
  computeAsync: (bookRoot) => learnFromBook(bookRoot),
  storeIf: (result) => result.ok,
})

/** 候选条目形状校验（防外部提交畸形数据经 as 断言绕过）——samples/quotes 共用：
 *  只复核两候选共同必需的 场景/正文/出处 三字符串字段（章号/打分等数值字段由
 *  commit 侧各自处理），类型参数由两个 filter 调用点分别收窄。 */
function isLearnCandidate<T>(v: unknown): v is T {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['场景'] === 'string' && typeof o['正文'] === 'string' && typeof o['出处'] === 'string'
}

/** 重评2-P3-⑤a（2026-09-09 全量重评 GLM-5.3）：learn-commit 单数组条目数上限——
 *  samples/quotes 原仅受 readJson 1MB 总量约束，超长数组逐条 commitSamples/
 *  commitQuotes（逐条指纹/建条目落盘）可拖出秒级同步循环阻塞事件循环。上限取
 *  批量定稿 BATCH_FINALIZE_MAX_DOCS = 400 同值先例（documents.ts X-23）；超出回
 *  422 业务信封（先例 io.ts EXPORT_FAILED）。按过滤前原始数组长度判定（校验前早拒，
 *  不为畸形超长数组白付逐条过滤）。 */
const LEARN_COMMIT_MAX_ITEMS = 400

export function registerKnowledgeRoutes(ctx: KnowledgeCtx): void {
  // learn 产候选（调内核 learnFromBook，规则打分不涉大模型）
  defineRoute('books.learn', {
    method: 'POST',
    path: '/api/books/:name/learn',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
    // R1010-P3（2026-09-10 全量重评 GLM-5.3 修复批）：handler 内冗余 token 复核删除——
    // 写闸（index.ts isWrite safeTokenCompare）在路由分派前已拦一切 POST（learn-commit 同）
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
    // R66-28（十四轮）：全书扫描并发闸 + 缓存（重复点击双跑双扫）。R72-2（二十轮 A-1）：
    // learnFromBook async 化后 handler 随之 async——await 期间事件循环可响应其他请求，
    // 但同一本书的并发重入仍要闸住（双跑双扫+候选目录写竞争），release 在 finally。
    const release = acquireTaskGate(params['name']!, 'learn')
    if (!release) return replyError(res, 409, 'BUSY', '本书正在收割文风候选，请等待完成后再试')
    try {
      // R66-28（十四轮）：全书扫描并发闸 + 缓存（重复点击双跑双扫）。R72-2（二十轮 A-1）：
      // learnFromBook async 化后 handler 随之 async——await 期间事件循环可响应其他请求，
      // 但同一本书的并发重入仍要闸住（双跑双扫+候选目录写竞争），release 在 finally。
      // D1（复审-0914-优化修复批）：TTL 命中/R47-18 过期逐出/storeIf 只缓存成功由通用件
      // 承担（壳体收编 ttl-cache.ts）
      const result = await learnCache.get(r.bookRoot)
      if (!result.ok) return replyError(res, 400, 'BAD_INPUT', result.error ?? '学习产出候选失败')
      reply(res, 200, { samples: result.samples ?? [], quotes: result.quotes ?? [] })
    } finally {
      release()
    }
  },
  })

  // learn 入库（作者勾选后调内核 commitSamples/commitQuotes）
  defineRoute('books.learn-commit', {
    method: 'POST',
    path: '/api/books/:name/learn-commit',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
    // R1010-P3：冗余 token 复核删除（写闸在路由前已拦，learn 同注）
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
    const body = await readJson(req)
    // 重评2-P3-⑤a：逐项条目数上限（过滤前原始长度判定，超限早拒——不进逐条 commit）
    const rawSamples = Array.isArray(body['samples']) ? (body['samples'] as unknown[]) : []
    const rawQuotes = Array.isArray(body['quotes']) ? (body['quotes'] as unknown[]) : []
    if (rawSamples.length > LEARN_COMMIT_MAX_ITEMS || rawQuotes.length > LEARN_COMMIT_MAX_ITEMS) {
      return replyError(
        res,
        422,
        'TOO_MANY_ITEMS',
        `samples/quotes 单次最多各提交 ${LEARN_COMMIT_MAX_ITEMS} 条（本次 samples ${rawSamples.length} 条 / quotes ${rawQuotes.length} 条），请分批提交`,
      )
    }
    const samples = rawSamples.filter(isLearnCandidate<SampleCandidate>)
    const quotes = rawQuotes.filter(isLearnCandidate<QuoteCandidate>)
    const bookRoot = r.bookRoot
    // R0911-B-P3-4：await readJson 可跨删书/改名的 drain 时点（本端点无任务闸）——
    // commit 前重验书注册（时序见本文件 bookMovedFailure 头注），防对旧捕获路径落盘
    const moved = bookMovedFailure(ctx.workDir, params['name'], bookRoot)
    if (moved) return replyError(res, 409, moved.code, moved.reason)
    // R0911-B-P3-3（2026-09-11 全量重评 GLM-5.3 修复批）：批量落盘改走可让出 commit——
    // 上限 400 条/数组 × 逐条原子写双 fsync 在慢盘可拖出秒级同步段，全程无让出会冻结
    // SSE 心跳/其它请求；让出缺省每 100 条一次（commit.ts COMMIT_YIELD_EVERY）。
    // 让出点复合 B-P3-4 重验：周期让出是新的 await 窗，让出后书已搬走即抛信号中止
    // 剩余条目（已落条目不回滚，documents.ts 链单元同口径），409 提示重开书重提交。
    const commitYield = async (): Promise<void> => {
      await learnCommitYieldPrimitive()
      const movedNow = bookMovedFailure(ctx.workDir, params['name'], bookRoot)
      if (movedNow) throw new BookMovedSignal(movedNow.reason)
    }
    try {
      const sampleFiles = samples.length ? await commitSamples(bookRoot, samples, commitYield) : []
      const quoteFiles = quotes.length ? await commitQuotes(bookRoot, quotes, commitYield) : []
      reply(res, 200, { ok: true, sampleFiles, quoteFiles })
    } catch (e) {
      if (e instanceof BookMovedSignal) return replyError(res, 409, 'BOOK_MOVED', e.message)
      throw e
    }
  },
  })
}
