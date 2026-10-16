/**
 * 机检端点（editor 组）
 *
 * POST /api/books/:name/documents/:docId/check
 *   docId → 正文文档 → runAllChecks → CheckReport 直返（即算即显，**不落信封**）。
 *
 * 机检执行逻辑内核在 src/check/run.ts，此处 re-export 兼容既有调用方（三审端点 review.ts、AI
 * 编排层 orchestrate 均从内核直接 import）。
 *
 * 本端点走 async 孪生 runCheckForDocumentAsync（rebuild 内核搬 worker + 账本全书性/章纲整扫段
 * 分段让出）——慢盘上机检不再整段冻结事件循环，其间 SSE 心跳与其它请求照跑；信封/报告面与同步版
 * 同款（等价性锚 = test/check/check-chain-async-parity.test.ts）。
 *
 * 无 AI 依赖、断网可用。流程同 cli/check.ts：rebuild 缓存（长篇）→ runAllChecks；账本两端闭合
 *（declaredLeadIds/actualLeadIds）草稿目录有细纲时取，正文目录缺省安全。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { createTtlProbeCache } from '../ttl-cache.js'
import { registerBookKeyedCache } from '../cache-registry.js' // 书键缓存登记表（登记制单源）
import { resolveBookOrReply, resolveDocFile, bookMovedFailure } from '../book-context.js'
import { readAnalysis } from '../../../document/analysis.js'
import { openSessionStoreAsync, bookHash, type SessionStore } from '../../../events/store.js'
import { QUOTE_OPEN, QUOTE_CLOSE } from '../../../check/quotes.js'
import { HANZI } from '../../../check/count.js' // 堆砌锚点汉字段单源（与 count.ts 口径一致）
import { hasRed, type CheckReport } from '../../../check/types.js'
import { checkFalsePositiveEvent } from '../../../events/chain-bridge.js'
import { log, errMsg } from '../../../log/index.js'
import { runCheckForDocumentAsync, collectTreeIssuesAsync, checkOutcomeStatus } from '../../../check/run.js'

// re-export（下沉兼容：既有 import 方零感知）
export {
  runCheckForDocument,
  runCheckForDocumentAsync,
  checkOutcomeStatus,
  type CheckOutcome,
} from '../../../check/run.js'

interface CheckCtx {
  workDir: string | null
  /** 全局托底：short.strict 等书级未设键回落 global.json（喂机检的生效值） */
  userDataPath: string | null
  /** 收尾：/tree-issues 缓存 TTL 覆盖档——组装根 RouteOverrides 注入
   * （undefined = 生产口径 5s 逐位不变） */
  treeIssuesTtlMs?: number | null
}

// ── /tree-issues 结果 5s TTL 缓存 ─────────────────────
// collectTreeIssues 每请求同步扫全书定稿正文聚合机检 red + verdict 驳回（大书秒级
// 阻塞事件循环），前端树轮询/反复刷新会反复重扫。缓存口径对齐 health.ts styleScanCache
//（书键 Map + FIFO 上限 + 纯 TTL）：写路径不挂即时失效——保存/定稿/verdict 落盘后
// 最迟 5s 自愈（health.ts 先例同款，避免给每个写端点平添 forget 接线的过度设计）；
// 书删除/改名的生命周期清理走 forgetTreeIssuesCache（forgetBookKeyedCaches 接线）。
/** 删书/改名失效挂点（books.ts forgetBookKeyedCaches 接线；TTL 5s 兜底自愈）。 */
export function forgetTreeIssuesCache(bookRoot: string): void {
  treeIssuesCache.forget(bookRoot)
}

// 登记制（模块顶层自登记）：删/改名后同名重建书不读陈树红点聚合（TTL 5s 兜底自愈）。
registerBookKeyedCache('tree-issues', forgetTreeIssuesCache)
/** 收尾：__treeIssuesCacheHasForTest / __setTreeIssuesTtlForTest 删除——
 * 缓存实例即观测面（生产对象，先例同 analysisOverviewCache）：has/TTL 覆盖档
 * （组装根 RouteOverrides 注入，随实例隔离）取代模块级钩子。 */
const TREE_ISSUES_TTL = 5000
const TREE_ISSUES_CACHE_MAX = 32

/** 缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO +
 * 过期逐出本地壳删除；命中/失效时序/逐出序逐位不变——纯 TTL + FIFO 32；
 *  只缓存成功路径由「计算体抛错即不落缓存」承担（collectTreeIssuesAsync 抛错走
 *  dispatch 兜底 500，同原口径），见 ttl-cache.ts 头部收敛映射表）。 */
export const treeIssuesCache = createTtlProbeCache<string, Record<string, unknown>>({
  name: 'tree-issues',
  keyOf: (k) => k,
  max: TREE_ISSUES_CACHE_MAX,
  ttl: () => TREE_ISSUES_TTL,
})

// ── 误报标记消费面（标记端点写、机检返回前按标记剔除）──────────────────
/** 事件载荷形状（chain-bridge.checkFalsePositiveEvent）：{ checkId, chapter, excerpt, docId? }。
 *  事件库载荷是 JSON（手工/旧版本写入可能是脏形状）——类型不符整条跳过：
 *  宁可漏过滤（作者再标一次）也不按脏键错过滤。 */
function isFalsePositiveData(v: unknown): v is { checkId: string; chapter: number } {
  if (v === null || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return typeof d['checkId'] === 'string' && typeof d['chapter'] === 'number'
}

/**
 * 该书「已标记误报」的 checkId 集（限定本章）。
 *
 * 判据 = 同章同 checkId 的**最近一条**事件（标记端点是 append 累积、可重复标记；seq 升序
 * 读，逐条覆盖即末条胜）。载荷只有 checkId/chapter/excerpt（无正负位可翻转），故最近一条
 * 恒为「标记」——仍按末条胜读，是为了让判据落在事件序上，而不是依赖「同键事件必定同向」
 * 这条推论：将来载荷加状态位时不用改这里。
 *
 * 返回 null = 判据不可得（无 userDataPath / 事件库打不开 / 读事件抛错）：调用方
 * fail-open 照原样返回全部项，但必须留痕——静默降级成「无任何标记」会让过滤能力
 * 无声失效（作者标了误报却照旧报同一条，且无从排查）。
 */
async function readSuppressedCheckIds(
  userDataPath: string | null,
  bookRoot: string,
  chapter: number,
): Promise<Set<string> | null> {
  // 无数据目录（CLI/未注入 userData 的单测形态）：本就没有事件库可读——按不可得留痕
  if (!userDataPath) {
    log.warn('api', '未定位应用数据目录，本章机检结果未按误报标记过滤（标记事件库不可读）')
    return null
  }
  let store: SessionStore | null = null
  try {
    // 开库走异步孪生（首开锁等待不阻塞服务事件循环，同本文件标记端点口径）
    store = await openSessionStoreAsync(userDataPath, bookRoot)
    if (!store) {
      log.warn('api', '事件库不可用，本章机检结果未按误报标记过滤')
      return null
    }
    // 按 type 下推（SQL 过滤）——事件库存全书链路事件，全量读再过滤会白付解析；
    // 按书读（不限会话）与标记端落的 ws 会话兼容，也覆盖历史落在别处的事件。
    // 同键逐条覆盖（iterateEvents 是 seq 升序）= 末条胜；存 seq 只为让「最近一条」可审
    const latest = new Map<string, number>()
    for (const ev of store.iterateEvents(bookHash(bookRoot), undefined, 'check/false-positive')) {
      if (isFalsePositiveData(ev.data) && ev.data.chapter === chapter) latest.set(ev.data.checkId, ev.seq)
    }
    return new Set(latest.keys())
  } catch (e) {
    log.warn('api', `误报标记判据读取失败，本章机检结果未按误报标记过滤：${errMsg(e)}`)
    return null
  } finally {
    // 开库是引用计数单例——中途抛错不 close 则 refs 永不归零
    store?.close()
  }
}

/**
 * 按误报标记集剔除本章命中项。判据 = 该 checkId 被标记 + 项属本章：
 * - 项自带章号 → 章号相等才算本章（账本/成长线类全书性红项以 chapter 指向被指章，
 *   检查别的章时顺带带出的他章命中不因本章标记消失）；
 * - 项无章号 → 由本次被检正文/文档派生（禁词/意象/复读/文风等），即本章的命中。
 * section 与 items 都出新数组（报告对象在别处仍被引用，不改原引用）；剔空不删段
 * （段标题与「本检查项零命中」两态在视图上得区分）。返回剔除条数。
 */
function dropFlaggedItems(
  report: CheckReport,
  suppressed: ReadonlySet<string>,
  chapter: number,
): { report: CheckReport; count: number } {
  let count = 0
  const sections = report.sections.map((s) => {
    const items = s.items.filter((i) => {
      const drop = suppressed.has(i.checkId) && (i.chapter === undefined || i.chapter === chapter)
      if (drop) count++
      return !drop
    })
    return { ...s, items }
  })
  return { report: { ...report, sections }, count }
}

export function registerCheckRoutes(ctx: CheckCtx): void {
  defineRoute('books.documents.check', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/check',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return

      const bookRoot = r.bookRoot
      const docId = params['docId'] ?? ''
      // docId→清单→安全路径→存在性解析链收编
      // resolveDocFile 单源（不读稿——机检由 runCheckForDocument 自读，且机检对象含
      // 非章稿文档）；BAD_PATH variant『文档路径非法』逐字保留
      const f = resolveDocFile(bookRoot, docId, { badPathText: '文档路径非法' })
      if (!f.ok) return replyError(res, f.status, f.code, f.message)

      const outcome = await runCheckForDocumentAsync(bookRoot, f.absPath, ctx.userDataPath)
      if (!outcome.ok) {
        // 收编 replyError 单一出口——不再手拼 {ok:false,...} 混合信封
        return replyError(
          res,
          checkOutcomeStatus(outcome.code),
          outcome.code,
          outcome.error,
          outcome.details ? { details: outcome.details } : undefined,
        )
      }
      // 作者标过的误报项在返回前剔除；判据不可得（无会话/读失败）时 fail-open 全返
      const suppressed = await readSuppressedCheckIds(ctx.userDataPath, bookRoot, outcome.chapter.章号)
      const { report, count } = suppressed
        ? dropFlaggedItems(outcome.report, suppressed, outcome.chapter.章号)
        : { report: outcome.report, count: 0 }
      reply(res, 200, {
        ok: true,
        report,
        // hasRed 随剔除后的报告重算（response 自洽：作者标掉的红项不再点亮红标/红点冒泡）
        hasRed: hasRed(report),
        suppressedCount: count,
      })
    },
  })

  // ── 机检误报标记 ──────────────────────────────────────
  // POST /documents/:docId/check-false-positive  body { checkId }
  // excerpt 服务端从正文切（命中区间 ±50 字、上限 200）——不信客户端传任意长文本。
  // 落 check/false-positive 事件（workspace 会话）；同章同 checkId 重复标记幂等
  //（append 多条，无撤销事件；消费侧 dropFlaggedItems 按「本章该 checkId 出现过即过滤」
  // 读，等价于取最近一条——追加不会翻转标记态）。标记的现行消费面 = 机检端点返回前的
  // 剔除（见 readSuppressedCheckIds；语料回收链现走章快照自判，不读本事件）。
  defineRoute('books.documents.check-false-positive', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/check-false-positive',
    parse: (body) => {
      const raw = body as Record<string, unknown>
      const checkId = typeof raw['checkId'] === 'string' ? raw['checkId'].trim() : ''
      if (!checkId) throw new Error('checkId 必填')
      return { checkId }
    },
    handler: async ({ params, input }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      const bookRoot = r.bookRoot
      const docId = params['docId'] ?? ''
      // 同上收编 resolveDocFile——本端点 NOT_FOUND 文案
      // 为『文档不存在』（无路径后缀），经 opts.missingText 逐字保留
      const f = resolveDocFile(bookRoot, docId, { badPathText: '文档路径非法', missingText: '文档不存在' })
      if (!f.ok) return replyError(res, f.status, f.code, f.message)

      const checkId = input.checkId

      // 复跑机检定位命中区间（机检零 token 纯函数，复跑成本可忽略）
      const outcome = await runCheckForDocumentAsync(bookRoot, f.absPath, ctx.userDataPath)
      if (!outcome.ok) return replyError(res, checkOutcomeStatus(outcome.code), outcome.code, outcome.error)
      const items = outcome.report.sections.flatMap((s) => s.items).filter((i) => i.checkId === checkId)
      if (items.length === 0) {
        return replyError(
          res,
          409,
          'CONFLICT',
          `当前机检结果中没有 checkId=${checkId} 的命中（可能已修复，刷新机检后再标）`,
        )
      }

      const excerpt = cutExcerpt(
        outcome.body,
        items.map((i) => i.message),
      )
      if (ctx.userDataPath) {
        try {
          // 开库走异步孪生（首开锁等待不阻塞服务事件循环）
          const store = await openSessionStoreAsync(ctx.userDataPath, bookRoot)
          if (store) {
            // close 收进 finally——workspaceSession/appendEvents 抛错时旧实现
            // 跳过 close，引用计数单例的本次打开滞留到进程结束
            try {
              // nano：观测层孤儿事件防线——上方 await 开库（首开锁
              // 可等）是删书/改名 drain 可跨的让出窗，append 前按 bookMovedFailure 家族
              // 口径重验书注册（时序见 book-context.ts 头注），书已搬走即
              // 409 不再对旧捕获路径落 check/false-positive 孤儿事件（本事件现无读取方，
              // 落错书的语料将来也无从回收；family 先例 documents.ts words-diary /
              // knowledge.ts learn 写前重验同款）
              const moved = bookMovedFailure(ctx.workDir, params['name'], bookRoot)
              if (moved) return replyError(res, 409, moved.code, moved.reason)
              const sessionId = store.workspaceSession(bookHash(bookRoot))
              store.appendEvents(sessionId, [
                checkFalsePositiveEvent({ checkId, chapter: outcome.chapter.章号, excerpt, docId }),
              ])
            } finally {
              store.close()
            }
          }
        } catch {
          // 观测层：事件落库失败不阻断标记动作（toast 已反馈，语料损失可接受）
        }
      }
      reply(res, 200, { ok: true, checkId, chapter: outcome.chapter.章号, excerpt })
    },
  })

  // GET /tree-issues（T9b 树红点冒泡）：扫定稿正文聚合机检 red + verdict 驳回，
  // 返 { docId: { hasRed, verdictRejected } }（仅含有 issue 的 docId，余省略）。
  // rebuild 一次复用 db 循环 checkWithDb（避免每章 rebuild 的 O(N²)）；rebuild 失败降级空 issues（不阻塞树）。
  defineRoute('books.tree-issues', {
    method: 'GET',
    path: '/api/books/:name/tree-issues',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return

      const bookRoot = r.bookRoot
      // 命中短时缓存则跳过全书同步重扫（payload 为纯数据可复用）；
      // 过期条目顺手逐出由通用件承担。壳体收编
      // ttl-cache.ts 通用件（计算体闭包 ctx，经 get(key, compute) 逐调用传入）
      const payload = await treeIssuesCache.get(
        bookRoot,
        async (root): Promise<Record<string, unknown>> => {
          // 聚合逻辑已下沉内核：扫正文 + 机检 + verdict 驳回，返回只有 issue 的 docId
          // 改走 async 孪生——大书全书同步聚合此前单请求秒级冻结事件循环
          //（Electron 内嵌单进程服务 = 桌面整体卡死），现章循环每 25 章让出一次
          const { issues, rebuildFailed, leadsBookDegraded, chaptersDegraded, manifestDegraded } =
            await collectTreeIssuesAsync(
              root,
              (docId) => {
                const reviewEnv = readAnalysis(root, docId, 'review')
                const v = (reviewEnv?.payload as { verdict?: { approved: boolean } } | undefined)?.verdict
                return v ?? undefined
              },
              ctx.userDataPath,
            )
          // 四类降级条件收数组全量透出（单键 `warning` 会在多降级叠加时后写覆盖先写、
          // 其余静默丢失）。前端消费方 = tree.ts issueWarnings → 章节树降级提示行。
          const warnings: string[] = []
          // 账本全书性红项计算失败随响应降级说明（与 rebuildFailed 同口径——
          // 此前静默降级为「无红」，持续性失败期间漏红不可见）
          if (rebuildFailed) warnings.push('机检索引构建失败，仅显示审稿驳回红点')
          if (leadsBookDegraded) warnings.push('账本全书性红项本轮计算失败，账本红点可能缺失')
          // 单章机检失败（第三种降级形态，此前零提示）
          if (chaptersDegraded > 0) warnings.push(`${chaptersDegraded} 个章节本轮机检失败，对应红点可能缺失`)
          // 清单读失败透出（第四种降级形态——此前读失败静默空表，章-账本
          // 红点整轮失明不可见；与 rebuildFailed/leadsBookDegraded 同口径）
          if (manifestDegraded) warnings.push('文档清单读取失败，章-账本红点本轮可能缺失')
          return {
            ok: true,
            issues,
            ...(warnings.length > 0 ? { warnings } : {}),
          }
        },
        ctx.treeIssuesTtlMs ?? undefined,
      )
      reply(res, 200, payload)
    },
  })
}

/** 命中词正则从引号常量派生（收编单源）——此前手写字符类，
 * quotes.ts 补字符时此处漏同步即漂移（本次 ‘’ 即实测漂移点）。 */
const EXCERPT_QUOTED_RE = new RegExp(`[${QUOTE_OPEN}]([^${QUOTE_CLOSE}]{1,40})[${QUOTE_CLOSE}]`, 'g')

/**
 * 从正文切命中区间 ±50 字摘录（上限 200）。
 * 导出供回归测试直接驱动（同 repairOrphanSessions 先例）。
 * 命中词取机检 message 里的引号片段（禁词/意象/复读项均带，字符集由
 * check/quotes.ts 单源派生），在正文里定位首个出现；定位不到（如字数类
 * 无具体词）回落正文开头——摘录仍可作为该章该检查的上下文语料。
 */
export function cutExcerpt(body: string, messages: string[]): string {
  const quoted: string[] = []
  for (const msg of messages) {
    for (const m of msg.matchAll(EXCERPT_QUOTED_RE)) {
      if (m[1]!) quoted.push(m[1]!)
    }
    // 堆砌类 message 形态：`眼睛×6`（词×次数）——锚点取 × 前的词
    // 收编第四处——汉字段由 count.ts HANZI 单源派生
    //（基本区 + 扩展 A），硬编码 \u4e00-\u9fff 会漏生僻字人名锚点
    for (const m of msg.matchAll(new RegExp(`([${HANZI}A-Za-z0-9·]{1,20})×\\d+`, 'g'))) {
      if (m[1]!) quoted.push(m[1]!)
    }
  }
  for (const kw of quoted) {
    const idx = body.indexOf(kw)
    if (idx >= 0) {
      const start = Math.max(0, idx - 50)
      const end = Math.min(body.length, idx + kw.length + 50)
      const excerpt = body.slice(start, end)
      return excerpt.length > 200 ? excerpt.slice(0, 200) : excerpt
    }
  }
  return body.slice(0, 200)
}
