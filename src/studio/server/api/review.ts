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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { getDriver, ensureSession } from '../../../driver/index.js'
import { readManifest } from '../../../document/manifest.js'
import { runCheckForDocument, checkOutcomeStatus } from './check.js'
import { buildReviewPacket, collectReviewIssues } from '../../../review/run.js'
import { writeAnalysis, readAnalysis, sourceHashOf } from '../../../document/analysis.js'
import { createProvider, currentProvider } from '../../../ai/provider/index.js'
import { generateTool } from '../../../ai/gen.js'
import { submitIssues, ISSUES_TOOL_NAME } from '../../../ai/contract/index.js'
import { reviewSystem } from '../../../ai/prompts/index.js'
import { tryMockTool } from '../../../ai/mock-tool.js'

interface ReviewCtx {
  workDir: string | null
  userDataPath: string | null
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
  // 三审直读（M12 B0.2，O-a）：docId → 正文 → 机检 → buildReviewPacket → generateTool×3 → 落信封
  route(
    'POST',
    '/api/books/:name/documents/:docId/review',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
      const bookRoot = join(ctx.workDir, entry.path)
      const docId = params['docId'] ?? ''
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!m) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })
      const absPath = join(bookRoot, m.path)
      if (!existsSync(absPath)) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档不存在：${m.path}` })

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
      const kind: 'long' | 'short' = (config.kind ?? 'long') === 'short' ? 'short' : 'long'

      // buildReviewPacket（O-a 直读：out_dir 用 .cache 临时目录不污染工作区；sourcePath 不绑草稿）
      const built = buildReviewPacket({
        checkReport: report,
        body,
        chapter: chapter.章号,
        workDir: join(bookRoot, '.cache', `review-${docId}`),
        capabilities: { parallel_subagents: false, multiple_calls: true },
        remaining_calls: config.budget.calls_per_chapter,
        high_risk: false,
        kind,
      })
      if (!built.ok) return reply(res, 500, { ok: false, code: 'PACKET_FAIL', error: built.reason })

      // generateTool×3（共享循环；逐角进度经主 session SSE 回流）
      const driver = getDriver('cc')
      const mainSession = await ensureSession(params['name']!, ctx.workDir!)
      const emitProgress = (lens: string, phase: 'start' | 'done'): void => {
        if (driver.emit) driver.emit(mainSession, { type: 'review-progress', lens, label: LENS_LABEL[lens] ?? lens, phase })
      }
      const loopResult = await runLensSpawnLoop({
        userDataPath: ctx.userDataPath,
        packets: built.packet.packets,
        body,
        chapter: chapter.章号,
        kind,
        outDir: built.packet.out_dir,
        onProgress: emitProgress,
      })
      if (!loopResult.ok) return reply(res, 500, { ok: false, code: 'LENS_FAIL', error: loopResult.error })

      // collectReviewIssues → 归一化；落信封（kind=review；O-b 手写线落信封，不走 finalize/审稿.md）
      const collected = collectReviewIssues({ packet: built.packet })
      writeAnalysis(bookRoot, docId, 'review', {
        generatedAt: new Date().toISOString(),
        model: process.env['CLWRITING_DRIVER'] === 'mock' ? 'mock' : 'cc',
        sourceHash: sourceHashOf(readFileSync(absPath, 'utf-8')),
        payload: { collected, lenses: loopResult.lenses },
      })

      reply(res, 200, { ok: true, lenses: loopResult.lenses, collected })
    },
  )

  // 裁决直读（M12 B1.3，docId 线，方案 A）：落 review 信封 payload.verdict（不改 fm / deriveStatus）。
  // 手写线不走 finalize；verdict 是作者基于三审意见的裁决，纯展示标记 + 信封存档。
  route(
    'POST',
    '/api/books/:name/documents/:docId/review-verdict',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
      const reqBody = await readJson(req)
      const approved = reqBody['approved'] === true

      const bookRoot = join(ctx.workDir, entry.path)
      const docId = params['docId'] ?? ''
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!m) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })

      // 合并写：保留 collected/lenses（若已三审），覆盖 verdict
      const existing = readAnalysis(bookRoot, docId, 'review')
      const payload = (existing?.payload as { collected?: unknown; lenses?: string[]; verdict?: unknown } | undefined) ?? {}
      payload.verdict = { approved, at: new Date().toISOString() }
      const absPath = join(bookRoot, m.path)
      writeAnalysis(bookRoot, docId, 'review', {
        generatedAt: existing?.generatedAt ?? new Date().toISOString(),
        model: 'author',
        sourceHash: existing?.sourceHash ?? sourceHashOf(readFileSync(absPath, 'utf-8')),
        payload,
      })
      reply(res, 200, { ok: true, verdict: payload.verdict })
    },
  )
}

/**
 * 三审 generateTool×3 共享循环（M12 B0.2 提取）：草稿线 + docId 直读线共用。
 * 逐 lens：generateTool(submit_issues) → 收 issues → 写 issues-<lens>.json → 进度回流。
 * 串行避 GLM 并发；出错返 {ok:false,error}（调用方决定 reply）。
 */
async function runLensSpawnLoop(opts: {
  userDataPath: string | null
  packets: Array<{
    lens: string
    title?: string
    focus?: string[]
    ledger_checks?: Array<{ lead_id: string; chapter: number; verb: string; evidence: string }>
  }>
  body: string
  chapter: number
  kind: 'long' | 'short'
  outDir: string
  onProgress?: (lens: string, phase: 'start' | 'done') => void
}): Promise<{ ok: true; lenses: string[] } | { ok: false; error: string }> {
  const lenses: string[] = []
  mkdirSync(opts.outDir, { recursive: true })

  // mock 快路：直接返回 mock 数据，不创建 provider
  if (process.env['CLWRITING_DRIVER'] === 'mock') {
    for (const sub of opts.packets) {
      const lens = sub.lens
      lenses.push(lens)
      opts.onProgress?.(lens, 'start')
      const mock = tryMockTool(ISSUES_TOOL_NAME)
      const issues = (mock?.input as { issues?: unknown[] })?.issues ?? []
      writeFileSync(join(opts.outDir, `issues-${lens}.json`), JSON.stringify(issues), 'utf8')
      opts.onProgress?.(lens, 'done')
    }
    return { ok: true, lenses }
  }

  if (!opts.userDataPath) return { ok: false, error: '未定位到应用数据目录' }
  const conf = currentProvider(opts.userDataPath)
  if (!conf) return { ok: false, error: '未配置 AI 服务供应商。请在设置 → AI 中添加并启用。' }
  const provider = createProvider(conf)
  for (const sub of opts.packets) {
    const lens = sub.lens
    lenses.push(lens)
    opts.onProgress?.(lens, 'start')
    const prompt = buildLensPrompt(lens, sub, opts.body, opts.chapter, opts.kind)
    const ctrl = new AbortController()
    try {
      const { input, text } = await generateTool(
        provider,
        {
          systemPrompt: reviewSystem(lens),
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 4000,
          tools: [submitIssues()],
          toolChoice: 'tool',
          toolName: ISSUES_TOOL_NAME,
        },
        ctrl.signal,
      )
      // tool_use 产出 → input.issues；降级用 text
      const issues = (input as { issues?: unknown[] })?.issues
      const issuesJson = issues ? JSON.stringify(issues) : text.trim()
      writeFileSync(join(opts.outDir, `issues-${lens}.json`), issuesJson, 'utf8')
    } catch (e) {
      return { ok: false, error: `${lens}-review gen:${e instanceof Error ? e.message : String(e)}` }
    }
    opts.onProgress?.(lens, 'done')
  }
  return { ok: true, lenses }
}

/** 组单视角审稿 prompt:焦点 + 账本核对(continuity)+ 正文 + 输出契约 */
function buildLensPrompt(
  lens: string,
  sub: { title?: string; focus?: string[]; ledger_checks?: Array<{ lead_id: string; chapter: number; verb: string; evidence: string }> },
  draftBody: string,
  chapter: number,
  kind: 'long' | 'short',
): string {
  const unit = kind === 'short' ? '篇' : '章'
  const parts: string[] = [`## 任务\n你是第 ${chapter} ${unit}的${LENS_LABEL[lens] ?? lens}审稿员,按视角审正文,只报问题。`]
  if (sub.focus?.length) parts.push(`## 焦点\n${sub.focus.map((f) => `- ${f}`).join('\n')}`)
  if (lens === 'continuity') {
    const checks = sub.ledger_checks ?? []
    parts.push(
      checks.length
        ? `## 账本核对(逐条核对账实相符)\n${checks.map((c) => `- ${c.lead_id} 第${c.chapter}章 ${c.verb}:${c.evidence}`).join('\n')}`
        : `## 账本核对\n(本章无账本清单)`,
    )
  }
  parts.push(`## 正文\n${draftBody}`)
  parts.push(
    `## category 枚举参考\nhigh_point(爽点)/reader_pull(追读牵引)/pacing(节奏)/ooc(人物崩坏)/logic(逻辑)/consistency(一致性)/continuity(连续性)/setting(设定)/timeline(时间线)/strand(线索)/ledger(账本)/safety(安全红线)\n- severity:S1致命/S2严重/S3一般/S4建议\n- evidence 必须引用正文原句\n- 只报问题,不要正面确认`,
  )
  return parts.join('\n\n')
}
