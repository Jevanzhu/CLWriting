/**
 * review 三审端点(C.3 + M12 .2/1.3):docId 直读 → generateTool(submit_issues)×3 → 落信封。
 *
 * POST /api/books/:name/documents/:docId/review  body {}
 *   → 机检 → buildReviewPacket(临时 out_dir)→ 各 lens generateTool(submit_issues) 收 issues
 *   → collectReviewIssues 归一化 → 落分析信封(kind=review)
 *   → 返 {ok, lenses, collected}
 *
 * POST /api/books/:name/documents/:docId/review-verdict  body {approved}
 *   → 合并写信封 payload.verdict(不改 fm / 不走 finalize)→ 返 {ok, verdict}
 *
 * 打包/回收是内核确定性步骤,generateTool×3 是真审稿(AI);串行避并发。进度经主 session SSE 回流。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { readBooks } from '../../../install/books.js'
import { defineRoute } from './schema.js'
import { crossProcessHeldTaskGatesFor, REVIEW_BUSY_TEXT, type TaskGateInjected } from './task-gate.js' // 三审接跨进程任务闸；：忙闸/三审登记单源；：实例面经 ctx.gate（crossProcessHeldTaskGatesFor 留在模块级——启动清扫非路由面）
import { readJson, reply, replyError } from '../http.js'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { safeManifestPath, safeDocId } from '../../../fs/safe-path.js'
import {
  resolveBookOrReply,
  resolveDocEntry,
  resolveDocFile,
  readDraftTextGuarded,
  bookMovedFailure,
} from '../book-context.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import type { DriverHost } from '../driver-port.js' // driver 经组装根注入
import { runCheckForDocumentAsync, checkOutcomeStatus, forgetTreeIssuesCache } from './check.js'
import { buildReviewPacket, collectReviewIssues, COMBINED_ISSUES_FILE } from '../../../review/run.js'
import type { ReviewLensPacket } from '../../../review/run.js'
import type { ReviewTier } from '../../../review/contract.js'
import { writeAnalysisAsync, readAnalysis, sourceHashOf } from '../../../document/analysis.js'
import { encodeDocDirName } from '../../../document/version.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { reviewSpec } from '../../../ai/tasks/specs.js'
import type { ProviderRuntime } from '../../../ai/provider/store.js' // provider 运行时端口（组装根注入）
import { effectiveRemainingCalls } from '../../../ai/calls.js'

interface ReviewCtx extends TaskGateInjected {
  /** driver 宿主（会话面 + 能力面 + mock 选择结果）——组装根注入 */
  driver: DriverHost
  /** provider 运行时端口——组装根注入（档位解析 / 当前供应商查询） */
  providers: ProviderRuntime
  workDir: string | null
  userDataPath: string | null
}

/**
 * 三审运行中并发闸（键=`${bookName}/${docId}`，**按文档**）/ ：本书任一文档
 * 三审在跑（books.ts 删书/改名持闸用）。
 *
 * 登记表与两判定函数整表迁入 task-gate.ts（忙闸矩阵的 review 信号需要按书
 * 判定在途三审，而 review.ts → task-gate.ts 是既有单向依赖，登记留本文件会让矩阵反向依赖
 * 成环）。本文件经 task-gate 的 isReviewRunningForDoc / tryHoldReviewRun / releaseReviewRun
 * 使用，语义与键格式（NUL 分隔，前缀匹配防书名前缀误报）逐位不变。
 *
 * 两把闸的分工（理顺，置此备查）：
 * - 按文档闸（登记表，键 book+docId）：同文档重复点三审 → 409 REVIEW_RUNNING（文案点名文档）；
 *   review-verdict 完成写竞窗闸同用它（三审完成写整体覆盖 payload，运行中裁决会被静默清除）。
 * - 书级闸（任务闸 (book,'review')）：同书同时只跑一次三审——三审 ctrl 以 `review:<书名>`
 *   单 owner 槽登记（cc driver 同 owner 换新会 abort 旧 ctrl），两个文档并发三审会互相掐断，
 *   故书级互斥是**有意**的；它同时让删书/改名/他进程看得见在途三审。另一文档来犯时走
 *   busyReason 的 'review' 行文案（前那里写「本书有其他任务在跑」——按 (book,'review')
 *   取键只会与同书另一次三审冲突，文案与成因不符，现点名「已有三审在跑」）。
 */
const LENS_LABEL: Record<string, string> = {
  reader: '读者',
  editor: '编辑',
  continuity: '连续性',
  hook: '钩子',
  emotion_peak: '情绪反转',
  payoff: '回报',
}

/** 镜头 → 角色文件名(emotion_peak 镜头对应 emotion-review 角色文件,名不一致) */
export function lensToRole(lens: string): string {
  if (lens === 'emotion_peak') return 'emotion-review'
  return `${lens}-review`
}

export function registerReviewRoutes(ctx: ReviewCtx): void {
  // 启动期清扫上次进程退出残留的三审临时目录——退出撞三审时
  // finally 清理不执行，.cache/review-<docId> 随每次累积；启动时无人持锁，幂等安全。
  sweepStaleReviewDirs(ctx.workDir)

  // 三审直读（M12 .2，O-a）：docId → 正文 → 机检 → buildReviewPacket → generateTool×3 → 落信封
  defineRoute('books.documents.review', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/review',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      // 写手在途预检——三审端点自身此前不查编排互斥
      //（outline/analysis/onboard 等生成端点均已接 orchestrationBusyFor）：写稿中
      //（self-heal/chat/后台收尾）发起三审，分钟级窗口内草稿持续推进，draft_hash
      // 守卫到期必失配（审稿单不成立），generateTool×3 白烧一次费用；对齐 outline.ts
      // 接法，命中 409 BUSY（同口径）。
      // 忙闸单源 = busyReason('review')——编排四面（self-heal/chat/手动写稿/
      // 后台收尾），序与文案与前逐位一致。同书另一次三审不在本步（同 action 自冲突
      // 归下方按文档闸与书级闸，见矩阵 review 行注）。
      const busy = ctx.gate.busyReason(params['name']!, 'review')
      if (busy) return replyError(res, 409, 'BUSY', busy)
      const bookRoot = r.bookRoot
      const docId = params['docId'] ?? ''
      // -SEC-B：docId 拼 .cache/review-${docId} 后 rmSync recursive，显式校验防穿越
      if (!safeDocId(docId)) return replyError(res, 400, 'BAD_PATH', '文档 ID 非法')
      // docId→清单→安全路径→存在性解析链收编
      // resolveDocFile 单源（不读稿——本端点读稿走下方单读 + 守卫）；
      // BAD_PATH 文案 variant『文档路径非法』逐字保留
      const f = resolveDocFile(bookRoot, docId, { badPathText: '文档路径非法' })
      if (!f.ok) return replyError(res, f.status, f.code, f.message)
      // 并发闸——同文档三审进行中直接 409（不排队的长任务，排队只会双跑双记账）
      // 改经登记表访问器（表已迁 task-gate.ts，单向依赖不变）
      if (!ctx.gate.tryHoldReviewRun(params['name']!, docId)) {
        return replyError(res, 409, 'REVIEW_RUNNING', '该文档三审进行中，请稍候完成后再试')
      }
      // 三审此前仅内存 Set（进程内），未接 task-gate 跨进程闸——删书/改名/
      // 他进程（dev-api/Electron 拆分 server）对在跑三审不可见，闸内删除会在旧路径重建
      // 孤儿目录并白烧 API 费用。补跨进程任务闸（book:review）：持有期间 books.ts
      // busyGate/heldTaskGatesFor 一并拦截。
      // 占闸失败 = 同书已有三审在跑（本格成因单义——按 (book,'review')
      // 取键只可能与同书另一次三审冲突；跨进程持有者只在此路径可见），文案取
      // REVIEW_BUSY_TEXT 单源，不再写「本书有其他任务在跑」。
      const releaseGate = ctx.gate.acquire(params['name']!, 'review')
      if (!releaseGate) {
        ctx.gate.releaseReviewRun(params['name']!, docId)
        return replyError(res, 409, 'REVIEW_BUSY', REVIEW_BUSY_TEXT)
      }
      try {
        // 单次读取取 buffer——sourceHash/draftHash/机检 body 三源同拍。
        // 此前三处独立读文件（hash 一读、机检内二读、hash 三读），机检窗口内作者保存
        // 会让两个 hash 无任何单一文件状态与之对应（isStale 误报 / 守卫依赖
        // 读取顺序巧合）。机检经 draftText 吃同一快照（runCheckForDocument 头注）。
        // 读稿守卫——existsSync 后 µs 级竞态删除（回收站/并发删）
        // 让 ENOENT 裸穿 dispatch；对齐 review-verdict 的 「读不到正文」人话信封
        // 守卫读收编 readDraftTextGuarded 单源（buffer+
        // text 同一快照不变，人话文案归 DRAFT_UNREADABLE_TEXT 常量、字节同文）
        const g = readDraftTextGuarded(f.absPath)
        if (!g.ok) return replyError(res, g.status, g.code, g.message)
        const draftBuf: Buffer = g.buf
        const draftText = g.text

        // sourceHash 必须与进 prompt 的正文同源——分钟级三审期间作者保存会让
        // 任务后重读的 hash 对应新稿，而 payload 审的是旧稿，stale 判定恒 false（错配）。
        const sourceHash = sourceHashOf(draftText)

        // 机检（draftText 喂预读快照；byproducts.leadChanges 供账本核对）
        const outcome = await runCheckForDocumentAsync(bookRoot, f.absPath, ctx.userDataPath, { draftText })
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
        const { report, chapter, body } = outcome

        // 三审运行时喂值：readBookConfig 结果统一过 applyGlobalDefaults（书级未设回落
        // global.json → 硬编码；budget.calls_per_chapter 喂 remaining_calls，不能是 undefined）。
        // 注释固定口径：本层与 runCheckForDocument 内层是同一 book.yaml 的两次独立
        // 读取——内层损坏时 warn 留诊断并回落 DEFAULT_CONFIG，本层静默回落（.config 永远
        // 有值）；磁盘同文件两次结果一致，刻意不复用内层 config 避免三审层耦合机检内部实现。
        const config = applyGlobalDefaults(readBookConfig(join(bookRoot, 'book.yaml')).config, ctx.userDataPath)
        const hasWiring = existsSync(join(bookRoot, '布线'))
        const hasShort = config.kind === 'short'

        // draft_hash 接线——collectReviewIssues 的守卫（审阅期间草稿漂移
        // → 审稿单不成立）此前无生产调用方传 hash（实装死字段）。此处与的
        // sourceHash 同源同拍：字节级 sha256（与 collect 侧重读文件后 createHash 同口径），
        // 三审分钟级窗口内作者改稿即被捕获。：从单次读取的 buffer 派生（三读收口为一读）。
        const draftHash = createHash('sha256').update(draftBuf).digest('hex')

        // buildReviewPacket（O-a 直读：out_dir 用 .cache 临时目录不污染工作区；sourcePath 不绑草稿）
        // docId 段过 encodeDocDirName——legacy id 含 `:`（`legacy:<sha>`），
        // win 目录名非法，原样拼路径 mkdir 恒 ENOENT → legacy 书三审整体 500（e2e
        // short-full-flow 红根因）。编码口径与 version.ts/analysis.ts 单源一致；清扫
        // （sweepStaleReviewDirs 的 review-* 前缀匹配）与逐次预清理（rmSync reviewOutDir）
        // 对编码名照常工作，无需反解。
        const reviewOutDir = join(bookRoot, '.cache', `review-${encodeDocDirName(docId)}`)
        // high_risk 不再恒 false——机检红项即高风险章（正文有硬伤），
        // 触发 selectReviewTier 的「风险章禁止降级满审」闸（此前该分支是死参数，仅测试独享）。
        const built = buildReviewPacket({
          checkReport: report,
          body,
          chapter: chapter.章号,
          draft_path: f.absPath,
          draft_hash: draftHash,
          workDir: reviewOutDir,
          capabilities: { parallel_subagents: false, multiple_calls: true },
          // 三口径（次数/tokens/cost）取最紧折算剩余调用数（未设=次数上限，旧行为）
          remaining_calls: effectiveRemainingCalls(bookRoot, chapter.章号, config),
          high_risk: outcome.hasRed,
          hasWiring,
          hasShort,
        })
        if (!built.ok) {
          rmSync(reviewOutDir, { recursive: true, force: true })
          return replyError(res, 500, 'PACKET_FAIL', built.reason)
        }

        // generateTool×3（共享循环；逐角进度经主 session SSE 回流）
        try {
          const driver = ctx.driver.driver
          const mainSession = await ctx.driver.ensureSession(params['name']!, ctx.workDir!)
          // -①（c ）：接入中断通道——此前 generateTool×3
          // 未接 driver ctrl 注册面，/interrupt 对在途三审完全无效且 driver.isRunning 假空闲
          // （假成功）。接法照抄 stream.ts spawn/self-heal 的 register/unregister 形态：编排
          // 段新建 ctrl → driver.registerCtrl（owner='review:<书名>'，含书名使跨书并发互不
          // 误伤；同书重入已被 reviewRunning + 任务闸 409 挡住，同 owner 串行换新安全）→
          // settle（成功/失败/中断）统一注销。
          const ctrl = new AbortController()
          // （driver 契约必需化）：registerCtrl/emit 为必需成员（mock 显式
          // no-op 桩），可选性守卫删除，直调语义逐位不变。
          driver.registerCtrl(mainSession, ctrl, `review:${params['name']!}`)
          try {
            const emitProgress = (lens: string, phase: 'start' | 'done'): void => {
              driver.emit(mainSession, { type: 'review-progress', lens, label: LENS_LABEL[lens] ?? lens, phase })
            }
            const loopResult = await runLensSpawnLoop({
              userDataPath: ctx.userDataPath,
              bookRoot,
              packets: built.packet.packets,
              tier: built.packet.tier,
              body,
              chapter: chapter.章号,
              outDir: built.packet.out_dir,
              // 正文注入源登记（f.entry.path = 三审直读的文档相对路径）
              sourceFiles: [f.entry.path],
              onProgress: emitProgress,
              ctrl, // -①：中断通道透传逐 lens runSpec
            })
            if (!loopResult.ok) {
              // -①：中断收口——循环把 runSpec 的 ABORTED 坍缩进 error 文案，此处
              // 按 ctrl 信号如实映射 499 人话信封（对齐 outline/rewrite 既有先例）
              if (ctrl.signal.aborted) return replyError(res, 499, 'ABORTED', '已中断')
              return replyError(res, 500, 'LENS_FAIL', loopResult.error)
            }

            // collectReviewIssues → 归一化；落信封（kind=review；O-b 手写线落信封，不走 finalize/审稿.md）
            const collected = collectReviewIssues({ packet: built.packet })
            // 信封 model 记实际供应商/模型名（不再写死 'cc'）
            // mock 判定读注入的 driver.kind（不再读环境变量）；供应商/档位读注入端口
            const prov =
              ctx.driver.kind === 'mock'
                ? null
                : ctx.userDataPath
                  ? ctx.providers.currentProvider(ctx.userDataPath)
                  : null
            // （四轮处置批）：写临界段重验书注册——lens 循环分钟级让出窗内
            // 删书/改名可搬走 bookRoot，照写会在旧路径 mkdir recursive 重建孤儿分析目录
            //（时序与防线形态见 bookMovedFailure 头注；对齐 documents/config 家族接线）。
            const moved = bookMovedFailure(ctx.workDir, params['name'], bookRoot)
            if (moved) return replyError(res, 409, moved.code, moved.reason)
            // 写信封走异步孪生（锁等待不阻塞服务事件循环）
            await writeAnalysisAsync(bookRoot, docId, 'review', {
              generatedAt: new Date().toISOString(),
              model: prov ? `${prov.name}/${ctx.providers.resolveTier(ctx.userDataPath, 'assistant').model}` : 'mock',
              sourceHash, // 进 prompt 时的稿（见上）——与 payload 同源，不重读
              // 采集失败（ok:false）打 incomplete 标记——collected.normalized
              // 已由 run.ts 注入阻断级「三审未完成」issue（passed 恒 false），信封层再加显式
              // 标记供消费方免查深层结构即可识别「结论不成立」
              payload: { collected, lenses: loopResult.lenses, ...(collected.ok ? {} : { incomplete: true }) },
            })

            reply(res, 200, { ok: true, lenses: loopResult.lenses, collected })
          } finally {
            // -①：settle（成功/失败/中断）统一注销——isRunning 归 false（cc 口径）
            driver.unregisterCtrl(mainSession, ctrl)
          }
        } finally {
          // 三审临时目录用毕即清（防跨审稿累积膨胀）
          rmSync(reviewOutDir, { recursive: true, force: true })
        }
      } finally {
        // 并发闸释放（成功/失败/异常路径都解锁）；经登记表访问器
        ctx.gate.releaseReviewRun(params['name']!, docId)
        releaseGate() // task-gate 同 finally 释放（幂等）
      }
    },
  })

  // 裁决直读（M12 .3，docId 线，方案 A）：落 review 信封 payload.verdict（不改 fm / deriveStatus）。
  // 手写线不走 finalize；verdict 是作者基于三审意见的裁决，纯展示标记 + 信封存档。
  defineRoute('books.documents.review-verdict', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/review-verdict',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      const reqBody = await readJson(req)
      // （四轮处置批）：readJson 窗口后重验书注册——窗口内删书/改名时旧路径
      // resolveDocEntry 会以误导性 404「文档ID未登记」回信（书不在了而非文档不在），
      // 对齐家族 409 BOOK_MOVED 人话信封（时序见 bookMovedFailure 头注）。
      const moved = bookMovedFailure(ctx.workDir, params['name'], r.bookRoot)
      if (moved) return replyError(res, 409, moved.code, moved.reason)
      const approved = reqBody['approved'] === true

      const bookRoot = r.bookRoot
      const docId = params['docId'] ?? ''
      if (!safeDocId(docId)) return replyError(res, 400, 'BAD_PATH', '文档 ID 非法')
      const m = resolveDocEntry(bookRoot, docId)
      if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)

      // 三审完成写竞窗闸——三审完成写（上方 review 端点）的
      // payload 不含 verdict 且整体覆盖写盘，分钟级运行窗内作者的裁决会被随后的完成写
      // 静默清除（写前重读只防「verdict 丢三审结果」的另一半，防不了本向）。
      // 最小闸对齐同文件三审端点自身闸（同码同文案）：运行中 409 拒裁决不排队——
      // 排队只会把旧 verdict 在完成写之后覆写回去，时机不可预期。
      // 查按文档闸（表已迁 task-gate.ts，访问器同语义）
      if (ctx.gate.isReviewRunningForDoc(params['name']!, docId)) {
        return replyError(res, 409, 'REVIEW_RUNNING', '该文档三审进行中，请稍候完成后再试')
      }

      // 合并写：保留 collected/lenses（若已三审），覆盖 verdict
      // 读改写竞态防护——三审完成（同 docId 的 review run）恰在本端点
      // 首次 readAnalysis 之后、writeAnalysis 之前落盘新 collected/lenses 时，旧读的
      // payload 整体回写会把新三审结果静默写丢。口径：写前重读一次，以磁盘最新值为准
      // 做浅合并，verdict 字段用本次裁决覆盖（裁决是作者最后动作，唯一允许覆写的字段）。
      // 剩余窗口（重读→writeAnalysis 毫秒级）由 writeAnalysis 原子写兜底不产生半文件。
      const existing = readAnalysis(bookRoot, docId, 'review')
      const verdict = { approved, at: new Date().toISOString() }
      const absPath = safeManifestPath(bookRoot, m.path)
      if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径非法')
      // 读稿守卫惰性化——sourceHash 只在信封缺 hash 时才需要读稿兜底。
      // 此前无条件 readFileSync：信封已带 hash（三审已落盘）的正常路径也整读一遍正文，
      // 大稿纯 I/O 浪费；且文件并发消失（回收站/删除竞态）时即使 hash 已有也 500。
      // 现先取 latest?.sourceHash ?? existing?.sourceHash，仅空才进「读文件 + sourceHashOf」
      // 兜底分支，兜底内保留 人话 500。语义微变：文件消失但信封已有 hash 时不再
      // 500，verdict 照常落盘；sourceHash 恒有值的响应契约不变。
      // 写前重读——三审若在首读与落盘之间完成，这里拿到的是新 collected/lenses
      //（重读提到读稿兜底之前：先判 hash 是否需要兜底；两读与本写之间零 await 窗，
      // 同步序内语义不变）
      const latest = readAnalysis(bookRoot, docId, 'review') ?? existing
      let sourceHash = latest?.sourceHash ?? existing?.sourceHash
      if (sourceHash === undefined) {
        // 读稿守卫——文件并发消失（回收站/删除竞态）时给人话 500，此前裸 ENOENT 穿透 dispatch
        // 守卫读收编 readDraftTextGuarded 单源（人话文案
        // 归 DRAFT_UNREADABLE_TEXT 常量、字节同文）
        const g = readDraftTextGuarded(absPath)
        if (!g.ok) return replyError(res, g.status, g.code, g.message)
        sourceHash = sourceHashOf(g.text)
      }
      const latestPayload = (latest?.payload as { collected?: unknown; lenses?: string[] } | undefined) ?? {}
      const payload = { ...latestPayload, verdict }
      // 写信封走异步孪生（锁等待不阻塞服务事件循环）
      await writeAnalysisAsync(bookRoot, docId, 'review', {
        generatedAt: latest?.generatedAt ?? existing?.generatedAt ?? new Date().toISOString(),
        model: 'author',
        sourceHash,
        payload,
      })
      // 修正（收尾）：verdict 落盘即失效 /tree-issues 5s TTL 缓存——
      // ReviewPanel 的 UI 契约是「裁决写完立即 loadIssues 刷新红点」，纯 TTL 自愈对
      // 本端点不成立（无轮询兜底，写后首读恰命中缓存 → 驳回/通过的红点变化被吞到
      // 下一次任意触发，e2e tree-issues 实证红）。这是树红点唯一的写侧来源，单点
      // 挂 forget 不属于「给每个写端点平添接线」的过度设计（health.ts 先例的边界）。
      forgetTreeIssuesCache(bookRoot)
      reply(res, 200, { ok: true, verdict: payload.verdict })
    },
  })
}

/**
 * 三审 generateTool×3 共享循环（M12 .2 提取）：docId 直读线使用。
 * 逐 packet：generateTool(submit_issues) → 收 issues → 写 issues 文件 → 进度回流。
 * 文件名契约与 collectReviewIssues 对齐：独立档 issues-<lens>.json；合审单档 issues-combined.json
 * （合审时 packet.lens 是锚视角名，按它写文件 collect 永远找不到）。
 * 串行避 GLM 并发；出错返 {ok:false,error}（调用方决定 reply）。
 * -①：ctrl 透传每次 runSpec——外部中断（/interrupt 经 driver abort）在任一
 * lens 在途时同步中止，循环不再继续下一 lens。
 */
async function runLensSpawnLoop(opts: {
  userDataPath: string | null
  bookRoot?: string
  packets: ReviewLensPacket[]
  tier: ReviewTier
  body: string
  chapter: number
  outDir: string
  /** 正文注入源（相对书根）——铁律①登记通道 */
  sourceFiles?: string[]
  onProgress?: (lens: string, phase: 'start' | 'done') => void
  /** -①：编排级中断 ctrl（/interrupt 经 driver 注册面对其 abort） */
  ctrl?: AbortController
}): Promise<{ ok: true; lenses: string[] } | { ok: false; error: string }> {
  const lenses: string[] = []
  mkdirSync(opts.outDir, { recursive: true })

  // 逐 lens：runSpec 统一编排（mock 快路/provider/中断/错误文案），mock 与真实同走 decode
  for (const sub of opts.packets) {
    const lens = sub.lens
    lenses.push(lens)
    opts.onProgress?.(lens, 'start')
    const prompt = buildLensPrompt(lens, sub, opts.body, opts.chapter)
    const out = await runSpec(reviewSpec(lens), {
      userDataPath: opts.userDataPath,
      bookRoot: opts.bookRoot,
      userPrompt: prompt,
      promptFiles: opts.sourceFiles,
      ctrl: opts.ctrl,
    })
    if (!out.ok) return { ok: false, error: `${lens}-review gen:${out.error}` }
    const { input, text } = out.data
    // tool_use 产出 → input.issues；降级用 text
    const issues = (input as { issues?: unknown[] })?.issues
    const issuesJson = issues ? JSON.stringify(issues) : text.trim()
    const issuesFile = opts.tier === 'combined' ? COMBINED_ISSUES_FILE : `issues-${lens}.json`
    atomicWriteFile(join(opts.outDir, issuesFile), issuesJson)
    opts.onProgress?.(lens, 'done')
  }
  return { ok: true, lenses }
}

/** 组单视角审稿 prompt:焦点 + 账本核对(continuity)/清单核对(payoff) + 正文 + 输出契约 */
export function buildLensPrompt(
  lens: string,
  sub: Pick<ReviewLensPacket, 'lens' | 'title' | 'focus' | 'ledger_checks' | 'list_checks'>,
  draftBody: string,
  chapter: number,
): string {
  // 短篇/长篇统一用「章」作为正文单位
  const parts: string[] = [`## 任务\n你是第 ${chapter} 章的${LENS_LABEL[lens] ?? lens}审稿员,按视角审正文,只报问题。`]
  if (sub.focus?.length) parts.push(`## 焦点\n${sub.focus.map((f) => `- ${f}`).join('\n')}`)
  if (lens === 'continuity') {
    const checks = sub.ledger_checks ?? []
    parts.push(
      checks.length
        ? `## 账本核对(逐条核对账实相符)\n${checks.map((c) => `- ${c.lead_id} 第${c.chapter}章 ${c.verb}:${c.evidence}`).join('\n')}`
        : `## 账本核对\n(本章无账本清单)`,
    )
  }
  // 短篇设定收尾审：清单.md 的反转线索 + 伏笔回收逐条核对（与 continuity 账本核对对称）
  if (lens === 'payoff') {
    const checks = sub.list_checks ?? []
    parts.push(
      checks.length
        ? `## 清单核对(逐条核对反转线索与伏笔回收)\n${checks
            .map(
              (c) =>
                `- ${c.type === 'reversal' ? '反转' : '伏笔'}｜${c.subject}｜${c.location || '未标注位置'}｜${c.detail}`,
            )
            .join('\n')}`
        : `## 清单核对\n(本篇无清单条目)`,
    )
  }
  parts.push(`## 正文\n${draftBody}`)
  parts.push(
    `## category 枚举参考（与回收白名单一致，短篇视角用后四维）\nhigh_point(爽点)/reader_pull(追读牵引)/pacing(节奏)/ooc(人物崩坏)/logic(逻辑)/consistency(一致性)/continuity(连续性)/setting(设定)/timeline(时间线)/strand(线索)/ledger(账本)/safety(安全红线)/hook(开篇钩子)/emotion_peak(情绪反转)/reversal(反转线索)/payoff(伏笔回收)\n- severity:S1致命/S2严重/S3一般/S4建议\n- evidence 必须引用正文原句\n- 只报问题,不要正面确认`,
  )
  return parts.join('\n\n')
}

/** 清扫全部书的 .cache/review-* 残留（服务启动时调用一次；失败不阻断）。
 * 导出供回归测（跨进程闸跳过语义直测）。 */
export function sweepStaleReviewDirs(workDir: string | null): void {
  if (!workDir) return
  try {
    for (const b of readBooks(workDir)) {
      // 他进程三审在途则跳过该书清扫——「启动时无人持锁」是
      // 单进程假设（原注），/ 开放双进程后不成立：B 进程启动清扫
      // 会删掉 A 进程在途三审的 out_dir（分钟级任务白烧费用、信封降级 incomplete）
      if (crossProcessHeldTaskGatesFor(b.name).includes('review')) continue
      const cacheDir = join(workDir, b.path, '.cache')
      if (!existsSync(cacheDir)) continue
      for (const d of readdirSync(cacheDir)) {
        if (d.startsWith('review-')) {
          try {
            rmSync(join(cacheDir, d), { recursive: true, force: true })
          } catch {
            /* 单目录清理失败忽略 */
          }
        }
      }
    }
  } catch {
    /* 清扫失败不阻断启动 */
  }
}
