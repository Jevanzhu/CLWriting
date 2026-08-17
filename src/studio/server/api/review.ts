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
import { currentProvider } from '../../../ai/provider/index.js'
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { safeManifestPath, safeDocId } from '../../../fs/safe-path.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { getDriver, ensureSession } from '../../../driver/index.js'
import { readManifest } from '../../../document/manifest.js'
import { runCheckForDocument, checkOutcomeStatus } from './check.js'
import { buildReviewPacket, collectReviewIssues, COMBINED_ISSUES_FILE } from '../../../review/run.js'
import type { ReviewLensPacket } from '../../../review/run.js'
import type { ReviewTier } from '../../../review/contract.js'
import { writeAnalysis, readAnalysis, sourceHashOf } from '../../../document/analysis.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { reviewSpec } from '../../../ai/tasks/specs.js'
import { resolveTier } from '../../../ai/provider/index.js'

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
  // 三审直读（M12 B0.2，O-a）：docId → 正文 → 机检 → buildReviewPacket → generateTool×3 → 落信封
  route(
    'POST',
    '/api/books/:name/documents/:docId/review',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
      const bookRoot = join(ctx.workDir, entry.path)
      const docId = params['docId'] ?? ''
      // P1-SEC-B：docId 拼 .cache/review-${docId} 后 rmSync recursive，显式校验防穿越
      if (!safeDocId(docId)) return reply(res, 400, { code: 'BAD_PATH', error: '文档 ID 非法' })
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!m) return reply(res, 404, { code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })
      const absPath = safeManifestPath(bookRoot, m.path)
      if (!absPath) return reply(res, 400, { code: 'BAD_PATH', error: '文档路径非法' })
      if (!existsSync(absPath)) return reply(res, 404, { code: 'NOT_FOUND', error: `文档不存在：${m.path}` })
      // X-P1-4：并发闸——同文档三审进行中直接 409（不排队的长任务，排队只会双跑双记账）
      const runKey = `${params['name']}/${docId}`
      if (reviewRunning.has(runKey)) {
        return reply(res, 409, { code: 'REVIEW_RUNNING', error: '该文档三审进行中，请稍候完成后再试' })
      }
      reviewRunning.add(runKey)
      try {

        // CC-P1-2：sourceHash 必须与进 prompt 的正文同源——分钟级三审期间作者保存会让
        // 任务后重读的 hash 对应新稿，而 payload 审的是旧稿，stale 判定恒 false（错配）。
        const sourceHash = sourceHashOf(readFileSync(absPath, 'utf-8'))

        // 机检（runCheckForDocument 内部 readDraft → chapter + body；byproducts.leadChanges 供账本核对）
        const outcome = runCheckForDocument(bookRoot, absPath)
        if (!outcome.ok) {
          return reply(res, checkOutcomeStatus(outcome.code), {
            ok: false,
            code: outcome.code,
            error: outcome.error,
            ...(outcome.details ? { details: outcome.details } : {}),
          })
        }
        const { report, chapter, body } = outcome
  
        const config = readBookConfig(join(bookRoot, 'book.yaml')).config
        const hasWiring = existsSync(join(bookRoot, '布线'))
        const hasShort = config.kind === 'short'
  
        // buildReviewPacket（O-a 直读：out_dir 用 .cache 临时目录不污染工作区；sourcePath 不绑草稿）
        const reviewOutDir = join(bookRoot, '.cache', `review-${docId}`)
        // W-P2-12：high_risk 不再恒 false——机检红项即高风险章（正文有硬伤），
        // 触发 selectReviewTier 的「风险章禁止降级满审」闸（此前该分支是死参数，仅测试独享）。
        const built = buildReviewPacket({
          checkReport: report,
          body,
          chapter: chapter.章号,
          workDir: reviewOutDir,
          capabilities: { parallel_subagents: false, multiple_calls: true },
          remaining_calls: config.budget.calls_per_chapter,
          high_risk: outcome.hasRed,
          hasWiring,
          hasShort,
        })
        if (!built.ok) {
          rmSync(reviewOutDir, { recursive: true, force: true })
          return reply(res, 500, { code: 'PACKET_FAIL', error: built.reason })
        }
  
        // generateTool×3（共享循环；逐角进度经主 session SSE 回流）
        try {
          const driver = getDriver('cc')
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
            onProgress: emitProgress,
          })
          if (!loopResult.ok) return reply(res, 500, { code: 'LENS_FAIL', error: loopResult.error })
  
          // collectReviewIssues → 归一化；落信封（kind=review；O-b 手写线落信封，不走 finalize/审稿.md）
          const collected = collectReviewIssues({ packet: built.packet })
          // P2-7：信封 model 记实际供应商/模型名（不再写死 'cc'）
          const prov = process.env['CLWRITING_DRIVER'] === 'mock' ? null : (ctx.userDataPath ? currentProvider(ctx.userDataPath) : null)
          writeAnalysis(bookRoot, docId, 'review', {
            generatedAt: new Date().toISOString(),
            model: prov ? `${prov.name}/${resolveTier(ctx.userDataPath, 'assistant').model}` : 'mock',
            sourceHash, // CC-P1-2：进 prompt 时的稿（见上）——与 payload 同源，不重读
            payload: { collected, lenses: loopResult.lenses },
          })
  
          reply(res, 200, { ok: true, lenses: loopResult.lenses, collected })
        } finally {
          // 三审临时目录用毕即清（防跨审稿累积膨胀）
          rmSync(reviewOutDir, { recursive: true, force: true })
        }
      } finally {
        // X-P1-4：并发闸释放（成功/失败/异常路径都解锁）
        reviewRunning.delete(runKey)
      }
    },
  )

  // 裁决直读（M12 B1.3，docId 线，方案 A）：落 review 信封 payload.verdict（不改 fm / deriveStatus）。
  // 手写线不走 finalize；verdict 是作者基于三审意见的裁决，纯展示标记 + 信封存档。
  route(
    'POST',
    '/api/books/:name/documents/:docId/review-verdict',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
      const reqBody = await readJson(req)
      const approved = reqBody['approved'] === true

      const bookRoot = join(ctx.workDir, entry.path)
      const docId = params['docId'] ?? ''
      if (!safeDocId(docId)) return reply(res, 400, { code: 'BAD_PATH', error: '文档 ID 非法' })
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!m) return reply(res, 404, { code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })

      // 合并写：保留 collected/lenses（若已三审），覆盖 verdict
      const existing = readAnalysis(bookRoot, docId, 'review')
      const payload = (existing?.payload as { collected?: unknown; lenses?: string[]; verdict?: unknown } | undefined) ?? {}
      payload.verdict = { approved, at: new Date().toISOString() }
      const absPath = safeManifestPath(bookRoot, m.path)
      if (!absPath) return reply(res, 400, { code: 'BAD_PATH', error: '文档路径非法' })
      // dd-P3：读稿守卫——文件并发消失（回收站/删除竞态）时给人话 500，此前裸 ENOENT 穿透 dispatch
      let body = ''
      try {
        body = readFileSync(absPath, 'utf-8')
      } catch {
        return reply(res, 500, { code: 'IO', error: '读不到正文文件（可能已被移动或删除），请刷新后再试' })
      }
      writeAnalysis(bookRoot, docId, 'review', {
        generatedAt: existing?.generatedAt ?? new Date().toISOString(),
        model: 'author',
        sourceHash: existing?.sourceHash ?? sourceHashOf(body),
        payload,
      })
      reply(res, 200, { ok: true, verdict: payload.verdict })
    },
  )
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
    const out = await runSpec(reviewSpec(lens), { userDataPath: opts.userDataPath, bookRoot: opts.bookRoot, userPrompt: prompt })
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
