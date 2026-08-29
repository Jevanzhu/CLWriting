/**
 * review 三审端点(C.3 + M12 B0.2/1.3):docId 直读 → generateTool(submit_issues)×3 → 落信封。
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
import { currentProvider } from '../../../ai/provider/index.js'
import { existsSync, readFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { readBooks } from '../../../install/books.js'
import { defineRoute } from './schema.js'
import { acquireTaskGate, orchestrationBusyFor } from './task-gate.js' // R62-17：三审接跨进程任务闸（删书/改名/他进程可见）
import { readJson, reply, replyError } from '../http.js'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { safeManifestPath, safeDocId } from '../../../fs/safe-path.js'
import { resolveBook, resolveDocEntry } from '../book-context.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import { getDriver, ensureSession } from '../../../driver/index.js'
import { runCheckForDocument, checkOutcomeStatus, forgetTreeIssuesCache } from './check.js'
import { buildReviewPacket, collectReviewIssues, COMBINED_ISSUES_FILE } from '../../../review/run.js'
import type { ReviewLensPacket } from '../../../review/run.js'
import type { ReviewTier } from '../../../review/contract.js'
import { writeAnalysis, readAnalysis, sourceHashOf } from '../../../document/analysis.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { reviewSpec } from '../../../ai/tasks/specs.js'
import { resolveTier } from '../../../ai/provider/index.js'
import { effectiveRemainingCalls } from '../../../ai/calls.js'

interface ReviewCtx {
  workDir: string | null
  userDataPath: string | null
}

/**
 * X-P1-4：三审运行中并发闸（key=`${bookName}/${docId}`）。三审真实耗时分钟级，
 * 前端超时重试或双击会并发跑两份（费用双倍 + 并发写同一信封）——同 chat/auto-write 的
 * 409 闸口径，运行中直接拒绝。
 */
const reviewRunning = new Set<string>()

/** hh-P1：本书任一文档三审在跑（books.ts 删书/改名持闸用）——三审是分钟级长任务，
 * 闸内放行删书/改名会在旧路径重建孤儿目录并白烧 API 费用（与 spawn/task-gate 同模式）。 */
export function isReviewRunningForBook(bookName: string): boolean {
  // 二轮复审（低级）：NUL 分隔——书名/文档 ID 任一含 '/' 时 `${book}/${doc}` 的前缀
  // 匹配理论可误报；NUL 不可能出现在两侧实值里（书名净化 + docId 为生成哈希）
  const prefix = bookName + '\u0000'
  for (const k of reviewRunning) if (k.startsWith(prefix)) return true
  return false
}

/** 二轮复审（低级）：三审运行闸组键（NUL 分隔，与 isReviewRunningForBook 同判据） */
function reviewRunKey(bookName: string, docId: string): string {
  return `${bookName}\u0000${docId}`
}

/** 测试钩子（同 stream.ts __setSpawnRunning 先例）：不经真实三审直接置/清本书运行闸，
 * 供 books 删书/改名 409 接线测用。 */
export function __setReviewRunning(bookName: string, running: boolean): void {
  const key = reviewRunKey(bookName, '__test__')
  if (running) reviewRunning.add(key)
  else reviewRunning.delete(key)
}

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
  // R70-7（十八轮）：启动期清扫上次进程退出残留的三审临时目录——退出撞三审时
  // finally 清理不执行，.cache/review-<docId> 随每次累积；启动时无人持锁，幂等安全。
  sweepStaleReviewDirs(ctx.workDir)

  // 三审直读（M12 B0.2，O-a）：docId → 正文 → 机检 → buildReviewPacket → generateTool×3 → 落信封
  defineRoute('books.documents.review', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/review',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R74-20（七十四轮批 D）：写手在途预检——三审端点自身此前不查编排互斥
      //（outline/analysis/onboard 等生成端点均已接 orchestrationBusyFor）：写稿中
      //（self-heal/chat/后台收尾）发起三审，分钟级窗口内草稿持续推进，draft_hash
      // 守卫到期必失配（审稿单不成立），generateTool×3 白烧一次费用；对齐 outline.ts
      // 接法，命中 409 BUSY（R67-13 同口径）
      const busyOrch = orchestrationBusyFor(params['name']!)
      if (busyOrch) return replyError(res, 409, 'BUSY', busyOrch)
      const bookRoot = r.bookRoot
      const docId = params['docId'] ?? ''
      // P1-SEC-B：docId 拼 .cache/review-${docId} 后 rmSync recursive，显式校验防穿越
      if (!safeDocId(docId)) return replyError(res, 400, 'BAD_PATH', '文档 ID 非法')
      const m = resolveDocEntry(bookRoot, docId)
      if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)
      const absPath = safeManifestPath(bookRoot, m.path)
      if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径非法')
      if (!existsSync(absPath)) return replyError(res, 404, 'NOT_FOUND', `文档不存在：${m.path}`)
      // X-P1-4：并发闸——同文档三审进行中直接 409（不排队的长任务，排队只会双跑双记账）
      const runKey = reviewRunKey(params['name']!, docId)
      if (reviewRunning.has(runKey)) {
        return replyError(res, 409, 'REVIEW_RUNNING', '该文档三审进行中，请稍候完成后再试')
      }
      reviewRunning.add(runKey)
      // R62-17：三审此前仅内存 Set（进程内），未接 task-gate 跨进程闸——删书/改名/
      // 他进程（dev-api/Electron 拆分 server）对在跑三审不可见，闸内删除会在旧路径重建
      // 孤儿目录并白烧 API 费用。补跨进程任务闸（book:review）：占不上（本书有其他
      // 长任务在跑）→ 409；持有期间 books.ts busyGate/heldTaskGatesFor 一并拦截。
      const releaseGate = acquireTaskGate(params['name']!, 'review')
      if (!releaseGate) {
        reviewRunning.delete(runKey)
        return replyError(res, 409, 'REVIEW_BUSY', '本书有其他任务在跑，先等它完成后再发起三审')
      }
      try {

        // R63-7（十一轮）：单次读取取 buffer——sourceHash/draftHash/机检 body 三源同拍。
        // 此前三处独立读文件（hash 一读、机检内二读、hash 三读），机检窗口内作者保存
        // 会让两个 hash 无任何单一文件状态与之对应（isStale 误报 / R61-13 守卫依赖
        // 读取顺序巧合）。机检经 draftText 吃同一快照（runCheckForDocument 头注）。
        // R64-10（十二轮）：读稿守卫——existsSync 后 µs 级竞态删除（回收站/并发删）
        // 让 ENOENT 裸穿 dispatch；对齐 review-verdict 的 dd-P3「读不到正文」人话信封
        let draftBuf: Buffer
        try {
          draftBuf = readFileSync(absPath)
        } catch {
          return replyError(res, 500, 'IO', '读不到正文文件（可能已被移动或删除），请刷新后再试')
        }
        const draftText = draftBuf.toString('utf-8')

        // CC-P1-2：sourceHash 必须与进 prompt 的正文同源——分钟级三审期间作者保存会让
        // 任务后重读的 hash 对应新稿，而 payload 审的是旧稿，stale 判定恒 false（错配）。
        const sourceHash = sourceHashOf(draftText)

        // 机检（R63-7：draftText 喂预读快照；byproducts.leadChanges 供账本核对）
        const outcome = runCheckForDocument(bookRoot, absPath, ctx.userDataPath, { draftText })
        if (!outcome.ok) {
          // N-2（第十二轮）：收编 replyError 单一出口——不再手拼 {ok:false,...} 混合信封
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
        // R62-34 注释固定口径：本层与 runCheckForDocument 内层是同一 book.yaml 的两次独立
        // 读取——内层损坏时 warn 留诊断并回落 DEFAULT_CONFIG，本层静默回落（.config 永远
        // 有值）；磁盘同文件两次结果一致，刻意不复用内层 config 避免三审层耦合机检内部实现。
        const config = applyGlobalDefaults(
          readBookConfig(join(bookRoot, 'book.yaml')).config,
          ctx.userDataPath,
        )
        const hasWiring = existsSync(join(bookRoot, '布线'))
        const hasShort = config.kind === 'short'

        // R62-33：draft_hash 接线——collectReviewIssues 的 R61-13 守卫（审阅期间草稿漂移
        // → 审稿单不成立）此前无生产调用方传 hash（实装死字段）。此处与 CC-P1-2 的
        // sourceHash 同源同拍：字节级 sha256（与 collect 侧重读文件后 createHash 同口径），
        // 三审分钟级窗口内作者改稿即被捕获。R63-7：从单次读取的 buffer 派生（三读收口为一读）。
        const draftHash = createHash('sha256').update(draftBuf).digest('hex')
  
        // buildReviewPacket（O-a 直读：out_dir 用 .cache 临时目录不污染工作区；sourcePath 不绑草稿）
        const reviewOutDir = join(bookRoot, '.cache', `review-${docId}`)
        // W-P2-12：high_risk 不再恒 false——机检红项即高风险章（正文有硬伤），
        // 触发 selectReviewTier 的「风险章禁止降级满审」闸（此前该分支是死参数，仅测试独享）。
        const built = buildReviewPacket({
          checkReport: report,
          body,
          chapter: chapter.章号,
          draft_path: absPath,
          draft_hash: draftHash,
          workDir: reviewOutDir,
          capabilities: { parallel_subagents: false, multiple_calls: true },
          // D3（批 5）：三口径（次数/tokens/cost）取最紧折算剩余调用数（未设=次数上限，旧行为）
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
          const driver = getDriver()
          const mainSession = await ensureSession(params['name']!, ctx.workDir!)
          const emitProgress = (lens: string, phase: 'start' | 'done'): void => {
            if (driver.emit) driver.emit(mainSession, { type: 'review-progress', lens, label: LENS_LABEL[lens] ?? lens, phase })
          }
          const loopResult = await runLensSpawnLoop({
            userDataPath: ctx.userDataPath,
            bookRoot,
            packets: built.packet.packets,
            tier: built.packet.tier,
            body,
            chapter: chapter.章号,
            outDir: built.packet.out_dir,
            // Z-1（第五十八轮）：正文注入源登记（m.path = 三审直读的文档相对路径）
            sourceFiles: [m.path],
            onProgress: emitProgress,
          })
          if (!loopResult.ok) return replyError(res, 500, 'LENS_FAIL', loopResult.error)
  
          // collectReviewIssues → 归一化；落信封（kind=review；O-b 手写线落信封，不走 finalize/审稿.md）
          const collected = collectReviewIssues({ packet: built.packet })
          // P2-7：信封 model 记实际供应商/模型名（不再写死 'cc'）
          const prov = process.env['CLWRITING_DRIVER'] === 'mock' ? null : (ctx.userDataPath ? currentProvider(ctx.userDataPath) : null)
          writeAnalysis(bookRoot, docId, 'review', {
            generatedAt: new Date().toISOString(),
            model: prov ? `${prov.name}/${resolveTier(ctx.userDataPath, 'assistant').model}` : 'mock',
            sourceHash, // CC-P1-2：进 prompt 时的稿（见上）——与 payload 同源，不重读
            // R63-4（十一轮）：采集失败（ok:false）打 incomplete 标记——collected.normalized
            // 已由 run.ts 注入阻断级「三审未完成」issue（passed 恒 false），信封层再加显式
            // 标记供消费方免查深层结构即可识别「结论不成立」
            payload: { collected, lenses: loopResult.lenses, ...(collected.ok ? {} : { incomplete: true }) },
          })
  
          reply(res, 200, { ok: true, lenses: loopResult.lenses, collected })
        } finally {
          // 三审临时目录用毕即清（防跨审稿累积膨胀）
          rmSync(reviewOutDir, { recursive: true, force: true })
        }
      } finally {
        // X-P1-4：并发闸释放（成功/失败/异常路径都解锁）
        reviewRunning.delete(runKey)
        releaseGate() // R62-17：task-gate 同 finally 释放（幂等）
      }
    },
  })

  // 裁决直读（M12 B1.3，docId 线，方案 A）：落 review 信封 payload.verdict（不改 fm / deriveStatus）。
  // 手写线不走 finalize；verdict 是作者基于三审意见的裁决，纯展示标记 + 信封存档。
  defineRoute('books.documents.review-verdict', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/review-verdict',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const reqBody = await readJson(req)
      const approved = reqBody['approved'] === true

      const bookRoot = r.bookRoot
      const docId = params['docId'] ?? ''
      if (!safeDocId(docId)) return replyError(res, 400, 'BAD_PATH', '文档 ID 非法')
      const m = resolveDocEntry(bookRoot, docId)
      if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)

      // 合并写：保留 collected/lenses（若已三审），覆盖 verdict
      // R-16（第十六轮）：读改写竞态防护——三审完成（同 docId 的 review run）恰在本端点
      // 首次 readAnalysis 之后、writeAnalysis 之前落盘新 collected/lenses 时，旧读的
      // payload 整体回写会把新三审结果静默写丢。口径：写前重读一次，以磁盘最新值为准
      // 做浅合并，verdict 字段用本次裁决覆盖（裁决是作者最后动作，唯一允许覆写的字段）。
      // 剩余窗口（重读→writeAnalysis 毫秒级）由 writeAnalysis 原子写兜底不产生半文件。
      const existing = readAnalysis(bookRoot, docId, 'review')
      const verdict = { approved, at: new Date().toISOString() }
      const absPath = safeManifestPath(bookRoot, m.path)
      if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径非法')
      // dd-P3：读稿守卫——文件并发消失（回收站/删除竞态）时给人话 500，此前裸 ENOENT 穿透 dispatch
      let body = ''
      try {
        body = readFileSync(absPath, 'utf-8')
      } catch {
        return replyError(res, 500, 'IO', '读不到正文文件（可能已被移动或删除），请刷新后再试')
      }
      // R-16：写前重读——三审若在首读与读稿之间完成，这里拿到的是新 collected/lenses
      const latest = readAnalysis(bookRoot, docId, 'review') ?? existing
      const latestPayload = (latest?.payload as { collected?: unknown; lenses?: string[] } | undefined) ?? {}
      const payload = { ...latestPayload, verdict }
      writeAnalysis(bookRoot, docId, 'review', {
        generatedAt: latest?.generatedAt ?? existing?.generatedAt ?? new Date().toISOString(),
        model: 'author',
        sourceHash: latest?.sourceHash ?? existing?.sourceHash ?? sourceHashOf(body),
        payload,
      })
      // R75-D-P3b 修正（批 F 收尾）：verdict 落盘即失效 /tree-issues 5s TTL 缓存——
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
 * 三审 generateTool×3 共享循环（M12 B0.2 提取）：docId 直读线使用。
 * 逐 packet：generateTool(submit_issues) → 收 issues → 写 issues 文件 → 进度回流。
 * 文件名契约与 collectReviewIssues 对齐：独立档 issues-<lens>.json；合审单档 issues-combined.json
 * （W-P1-1：合审时 packet.lens 是锚视角名，按它写文件 collect 永远找不到）。
 * 串行避 GLM 并发；出错返 {ok:false,error}（调用方决定 reply）。
 */
async function runLensSpawnLoop(opts: {
  userDataPath: string | null
  bookRoot?: string
  packets: ReviewLensPacket[]
  tier: ReviewTier
  body: string
  chapter: number
  outDir: string
  /** Z-1（第五十八轮）：正文注入源（相对书根）——铁律①登记通道 */
  sourceFiles?: string[]
  onProgress?: (lens: string, phase: 'start' | 'done') => void
}): Promise<{ ok: true; lenses: string[] } | { ok: false; error: string }> {
  const lenses: string[] = []
  mkdirSync(opts.outDir, { recursive: true })

  // 逐 lens：runSpec 统一编排（mock 快路/provider/中断/错误文案），mock 与真实同走 decode
  for (const sub of opts.packets) {
    const lens = sub.lens
    lenses.push(lens)
    opts.onProgress?.(lens, 'start')
    const prompt = buildLensPrompt(lens, sub, opts.body, opts.chapter)
    const out = await runSpec(reviewSpec(lens), { userDataPath: opts.userDataPath, bookRoot: opts.bookRoot, userPrompt: prompt, promptFiles: opts.sourceFiles })
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
  // 短篇设定收尾审：清单.md 的反转线索 + 伏笔回收逐条核对（与 continuity 账本核对对称，W-P1-2）
  if (lens === 'payoff') {
    const checks = sub.list_checks ?? []
    parts.push(
      checks.length
        ? `## 清单核对(逐条核对反转线索与伏笔回收)\n${checks
            .map((c) => `- ${c.type === 'reversal' ? '反转' : '伏笔'}｜${c.subject}｜${c.location || '未标注位置'}｜${c.detail}`)
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

/** R70-7：清扫全部书的 .cache/review-* 残留（服务启动时调用一次；失败不阻断）。 */
function sweepStaleReviewDirs(workDir: string | null): void {
  if (!workDir) return
  try {
    for (const b of readBooks(workDir)) {
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
