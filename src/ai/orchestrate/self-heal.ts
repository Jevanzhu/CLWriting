/**
 * 全自动写章 · 红项自愈闭环编排器（重构版）。
 *
 * provider 直连 + tool_use 结构化产出，不再 spawn claude CLI。
 * 作者触发一次 → AI 写稿（tool_use）→ 机检 → 红则自动重写 → 全绿或触顶交作者。
 *
 * 架构要点：
 * - provider 从 providers.json 取当前供应商（userDataPath 注入）
 * - 进度经主 session emit 回流（/stream 转发前端）；text 逐字转发
 * - 每轮重写前发 self_heal_reset：整章重写产出的是完整替换稿
 * - AbortSignal 贯穿到 provider（interrupt 时 abort 请求）
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { rebuild } from '../../cache/rebuild.js'
import { readBookConfig } from '../../format/yaml.js'
import { evaluateRetry, redSetKey, buildStrategyReminder } from '../../process/retry.js'
import { getRedItems } from '../../check/types.js'
import { openSessionStore, bookHash } from '../../events/store.js'
import { ChainRecorder, checkReportEvent, retryAttemptEvent } from '../../events/chain-bridge.js'
import type { DriverEvent, Session, StudioDriver } from '../../driver/index.js'
// 以下纯逻辑函数（checkWithDb/buildDraftPrompt/saveDraft/buildRewritePrompt/draftFileName/readKind）
// 物理上位于 api/（与端点同文件），本身不依赖 HTTP 语境；待后续下沉治理。
import { readKind } from '../../format/kind.js'
import { checkWithDb, type CheckOutcome } from '../../check/run.js'
import { buildDraftPrompt, saveDraft } from '../../process/draft-pipeline.js'
import { generateLeadUpdateDraft } from '../../process/lead-update-draft.js'
import { buildRewritePrompt } from '../../process/rewrite-prompt.js'
import { tryMockTool } from '../mock-tool.js'
import { runSpec } from '../tasks/spec.js'
import { selfHealSpec } from '../tasks/specs.js'
import { checkAiCallBudget } from '../calls.js'
import { chapterToolName, assembleChapter } from '../contract/index.js'
import { collectRuleViolations } from '../rules/index.js'
import { recordRuleHits } from '../rule-hits.js'
import { recordAuthorSignal } from '../author-signal.js'
import { recordAiVersion } from '../../git/ai-track.js'


/** 重写通用指令（红项明细走 reviewIssues 槽位逐条编号；[必须]=硬性红项，[建议]=文风黄项） */
const REWRITE_INSTRUCTION = '按审稿意见逐条修复机检红项；[必须] 为硬性错误必须修，[建议] 为文风黄项不强制但建议采纳。保持正文连贯与既定情节走向。'

export interface SelfHealOpts {
  /** 进度 emit 目标：只 emit，不在其上生成 */
  driver: StudioDriver
  mainSession: Session
  /** APP 数据目录（读 providers.json 取当前供应商） */
  userDataPath: string
  cwd: string
  bookRoot: string
  /** 并发锁 key */
  bookName: string
  /** 起始章号（单章，向后兼容） */
  chapter: number
  /** 批量连写章号序列（P2-3）：有值且 >1 章时走批量循环，中途 escalate 停后续 */
  chapters?: number[]
  /** 最大重写次数（默认 3） */
  maxAttempts?: number
  /** 机检注入（单测替身） */
  check?: (draftPath: string) => CheckOutcome
  /** 落盘注入（单测替身） */
  save?: typeof saveDraft
  /** 生成函数注入（单测替身）；缺省用 provider + tool_use 生成。
   *  接收 userPrompt + kind，返回完整 markdown（front matter + 正文）。 */
  genFn?: (userPrompt: string, kind: 'long' | 'short', signal: AbortSignal, onText: (delta: string) => void) => Promise<string>
}

export type SelfHealOutcome =
  // B-P1-2：pass/escalate 补 chapter（章号），供 chat.ts formatHealResult 显示正确的"第N章"
  | { outcome: 'pass'; chapter: number; docId: string; path: string; attempts: number; yellows?: string[] }
  | { outcome: 'escalate'; chapter: number; reds: string[]; docId: string; path: string; attempts: number }
  | { outcome: 'aborted' }
  | { outcome: 'failed'; error: string }

/** 运行中的编排（book 级并发锁 + 中断句柄） */
interface RunState {
  ctrl: AbortController
  /** 本次运行 AI 消耗累计（done 事件上报，W-P2-7；genFn 单测替身无 usage 不入账） */
  usage: { calls: number; inputTokens: number; outputTokens: number }
}
const running = new Map<string, RunState>()

/** 本书是否正在全自动写章 */
export function isSelfHealRunning(bookName: string): boolean {
  return running.has(bookName)
}

/** 中断本书的全自动写章 */
export function abortSelfHeal(bookName: string): boolean {
  const st = running.get(bookName)
  if (!st) return false
  st.ctrl.abort()
  return true
}

/**
 * 跑完整自愈闭环。端点 fire-and-forget 调用（不 await），进度全程经主 session SSE 回流。
 */

/** X-P3a：fire-and-forget 的账本推进草稿失败留痕（此前静默，作者不知道草稿没生成） */
async function logLeadDraftFailure(
  p: Promise<{ ok: true; count: number } | { ok: false; code: string; error: string }>,
): Promise<void> {
  try {
    const r = await p
    if (!r.ok) console.error(`[self-heal] 账本推进草稿生成失败（${r.code}）：${r.error}`)
  } catch (e) {
    console.error('[self-heal] 账本推进草稿生成异常：', e instanceof Error ? e.message : String(e))
  }
}

export async function runSelfHeal(opts: SelfHealOpts): Promise<SelfHealOutcome> {
  const state: RunState = { ctrl: new AbortController(), usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }
  running.set(opts.bookName, state)
  let result: SelfHealOutcome
  try {
    result = await orchestrate(opts, state)
  } catch (e) {
    result = { outcome: 'failed', error: e instanceof Error ? e.message : String(e) }
  } finally {
    running.delete(opts.bookName)
  }
  emitResult(opts, result, state.usage)
  return result
}

/** P2：自愈链路事件录制（每书 workspace 会话；观测层失败静默 → null） */
function mkChain(opts: SelfHealOpts): ChainRecorder | null {
  try {
    const store = openSessionStore(opts.userDataPath, opts.bookRoot)
    if (!store) return null
    return new ChainRecorder(store, store.workspaceSession(bookHash(opts.bookRoot)))
  } catch {
    return null
  }
}

async function orchestrate(opts: SelfHealOpts, state: RunState): Promise<SelfHealOutcome> {
  const { bookRoot } = opts
  const maxAttempts = opts.maxAttempts ?? 3
  // P2：自愈链路事件录制（check/report + retry/attempt 挂 workspace 会话；观测层静默）
  const chain = mkChain(opts)
  const save = opts.save ?? saveDraft
  const kind = readKind(bookRoot)
  // P2-3：批量连写——opts.chapters 有值走批量循环；无则单章旧逻辑（逐字不变，防回归）
  const chapters = opts.chapters
  const isBatch = chapters !== undefined && chapters.length > 1

  // 前端：running=true + 清空旧正文
  emit(opts, { type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
  if (isBatch) {
    emit(opts, { type: 'self_heal_batch', total: chapters!.length })
    emit(opts, { type: 'self_heal_phase', phase: 'chapter_start', chapter: chapters![0], done: 0, total: chapters!.length })
  }

  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const hasWiring = existsSync(join(bookRoot, '布线'))
  if (hasWiring) {
    const rebuilt = rebuild(bookRoot, join(bookRoot, '.cache', 'index.db'))
    if (rebuilt.errors.length > 0) {
      return { outcome: 'failed', error: '源文件解析失败，先修这些文件再重试' }
    }
  }
  // 复用 db 连接：rebuild 后开一次，循环内 check 不重开（P2-BE-5）
  const db = hasWiring ? new DatabaseSync(join(bookRoot, '.cache', 'index.db')) : null
  const check = opts.check ?? ((p: string) => checkWithDb(bookRoot, p, db, config))

  // F2：单章/批量共享同一套 ctx（消除双路径重复）
  const ctx: ChapterCtx = { bookRoot, maxAttempts, save, kind, check, db, chain }

  // P2-3：批量连写——循环各章走同一套单章闭环，章间 emit chapter_done/start 进度。
  // 每章独立开算 budget；中途 escalate/预算超限 → 停后续章 + 报 batch_progress。
  if (isBatch) {
    try {
      return await orchestrateBatch(opts, state, ctx, chapters!)
    } finally {
      if (db) db.close()
      chain?.close()
    }
  }

  // F2：单章统一走 runChapter（与批量同源，消除双路径重复 + 语义统一：
  // 无稿可交（首稿预算超限/生成失败）→ failed；有稿可交 → escalate（保留稿））
  try {
    const run = await runChapter(opts, state, ctx, opts.chapter)
    if (run.outcome === 'aborted') return { outcome: 'aborted' }
    if (run.outcome === 'failed') return { outcome: 'failed', error: run.error }
    if (run.outcome === 'escalate') {
      return {
        outcome: 'escalate',
        chapter: opts.chapter, // B-P1-2：透传章号，formatHealResult 显示"第N章"
        reds: run.reds,
        docId: run.docId,
        path: run.path,
        attempts: run.attempts,
      }
    }
    return {
      outcome: 'pass',
      chapter: opts.chapter,
      docId: run.docId,
      path: run.path,
      attempts: run.attempts,
      ...(run.yellows ? { yellows: run.yellows } : {}),
    }
  } finally {
    if (db) db.close()
    chain?.close()
  }
}
/** 单章闭环共享上下文（F2：单章/批量同源，消除双路径重复） */
interface ChapterCtx {
  bookRoot: string
  maxAttempts: number
  save: typeof saveDraft
  kind: 'long' | 'short'
  check: (p: string) => CheckOutcome
  db: DatabaseSync | null
  chain: ChainRecorder | null
}

/**
 * 单章闭环一次运行的结果（落盘 + 记录已在 runChapter 内完成），或中断。
 * F2 语义统一：无稿可交（首稿预算超限/生成失败）→ failed；有稿可交 → escalate（保留稿）。
 */
type ChapterRun =
  | { chapter: number; outcome: 'pass'; yellows?: string[]; docId: string; path: string; attempts: number }
  | { chapter: number; outcome: 'escalate'; reds: string[]; docId: string; path: string; attempts: number }
  | { chapter: number; outcome: 'failed'; error: string; attempts: number }
  | { outcome: 'aborted' }

/**
 * P2-3：批量连写编排——循环各章跑 runChapter（单章闭环），
 * 章间 emit chapter_done（done/total）+ 下一章 chapter_start。
 * 任一章 escalate → 停后续章 + 发 self_heal_batch_progress（done=已完成章数, stoppedAt）。
 * 全绿 → 最后一章直接 return pass（不发多余 done 事件）。
 */
async function orchestrateBatch(
  opts: SelfHealOpts,
  state: RunState,
  ctx: ChapterCtx,
  chapters: number[],
): Promise<SelfHealOutcome> {
  const total = chapters.length
  for (let i = 0; i < total; i++) {
    const ch = chapters[i]!
    if (state.ctrl.signal.aborted) return { outcome: 'aborted' }

    const run = await runChapter(opts, state, ctx, ch)
    if (run.outcome === 'aborted') return { outcome: 'aborted' }
    // F2 语义统一：无稿（首稿预算超限/生成失败）→ failed 停后续章；有稿 escalate 同样停
    if (run.outcome === 'failed') {
      emit(opts, { type: 'self_heal_batch_progress', done: i, total, stoppedAt: ch })
      return { outcome: 'failed', error: run.error }
    }
    // 单章 escalate → 停后续章，报批量进度（done=已完成章数）
    if (run.outcome === 'escalate') {
      emit(opts, { type: 'self_heal_batch_progress', done: i, total, stoppedAt: ch })
      return {
        outcome: 'escalate',
        chapter: ch,
        reds: run.reds ?? [],
        docId: run.docId ?? '',
        path: run.path ?? '',
        attempts: run.attempts,
      }
    }
    // pass：最后一章直接 return（不发多余 done 事件）；中途章 emit 章间进度
    if (i === total - 1) {
      return {
        outcome: 'pass',
        chapter: ch,
        docId: run.docId ?? '',
        path: run.path ?? '',
        attempts: run.attempts,
        ...(run.yellows ? { yellows: run.yellows } : {}),
      }
    }
    emit(opts, { type: 'self_heal_phase', phase: 'chapter_done', chapter: ch, done: i + 1, total })
    emit(opts, { type: 'self_heal_phase', phase: 'chapter_start', chapter: chapters[i + 1]!, done: i + 1, total })
  }
  // 不可达（循环内必 return）；保险兜底
  return { outcome: 'failed', error: '批量连写未正常结束' }
}

/**
 * 单章闭环（首稿→机检→重写→全绿/触顶）。批量与单章共用。
 * 返回 pass/escalate 时，终稿已由 save + recordAuthorSignal/recordAiVersion 落盘记录。
 */
async function runChapter(
  opts: SelfHealOpts,
  state: RunState,
  ctx: ChapterCtx,
  chapter: number,
): Promise<ChapterRun> {
  const { bookRoot, maxAttempts, save, kind, check, chain } = ctx
  // ① 首稿（C-1：预算闸——超限不跑）
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const budget = checkAiCallBudget(bookRoot, chapter, config)
  if (!budget.ok) return { chapter, outcome: 'failed', error: budget.reason, attempts: 0 }
  emit(opts, { type: 'self_heal_phase', phase: 'drafting' })
  const first = await runGenerate(opts, state, kind, buildDraftPrompt(bookRoot, chapter, kind), chapter)
  if (first.status === 'aborted') return { outcome: 'aborted' }
  if (first.status !== 'ok') return { chapter, outcome: 'failed', error: first.error, attempts: 0 }
  let current = first.text
  const firstDraft = save(bookRoot, chapter, current, { snapshotOrigin: 'self-heal' })
  const draftPath = join(bookRoot, firstDraft.relPath)
  // X-P1-2/X-P2-6：批量模式与单章同口径——账本侧红补生成 + pass 后生成草稿
  const hasWiring = existsSync(join(bookRoot, '布线'))
  let leadDraftTried = false

  // ② 机检 → 红则重写 → 全绿或触顶
  let attempt = 0
  // A4：上一次机检的红项集合 key（与单章路径同口径）
  let prevRedKey: string | null = null
  for (;;) {
    if (state.ctrl.signal.aborted) return { outcome: 'aborted' }
    emit(opts, { type: 'self_heal_phase', phase: 'checking', attempt })
    const outcome = check(draftPath)
    // P2：机检报告事件化（红项结构化，自愈打回判据来源）
    chain?.add(
      checkReportEvent({
        chapter,
        reds: outcome.ok ? redMessages(outcome) : [`草稿格式不合规：${outcome.error}`],
      }),
    )

    let reds: string[]
    let redIssues: string[]
    let chapterNo = chapter

    if (outcome.ok) {
      chapterNo = outcome.chapter.章号
      // X-P1-2：账本侧红重写不可修——补生成账本推进草稿后复查一次（同单章路径）
      if (
        hasWiring &&
        !leadDraftTried &&
        getRedItems(outcome.report).some((r) => r.checkId === 'lead-declared-not-done')
      ) {
        leadDraftTried = true
        emit(opts, { type: 'self_heal_phase', phase: 'lead_update', attempt })
        const gen = await generateLeadUpdateDraft(bookRoot, chapterNo, opts.userDataPath)
        if (gen.ok && gen.count > 0) continue
      }
      const st = evaluateRetry(outcome.report, attempt, maxAttempts)
      // P2：打回评估事件化（重试链可重放；pass 不记）
      if (st.state !== 'pass') {
        chain?.add(retryAttemptEvent({ attempt, maxAttempts: st.state === 'retry' ? st.maxAttempts : maxAttempts, redIssues: st.redIssues }))
      }
      if (st.state === 'pass') {
        const final = save(bookRoot, chapter, current, { snapshotOrigin: 'self-heal' })
        recordAuthorSignal(bookRoot, final.docId, current, 'self-heal', opts.userDataPath ?? undefined)
        recordAiVersion(bookRoot, final.docId, current)
        // X-P2-6：批量连写 pass 后同样生成账本推进草稿（与单章口径对称；此前批量整链旁路）。
        // 上一章未定稿确认的草稿由 generateLeadUpdateDraft 内部按章归档，finalize 按章号回收。
        if (hasWiring && !leadDraftTried) void logLeadDraftFailure(generateLeadUpdateDraft(bookRoot, chapterNo, opts.userDataPath))
        const yellows = ruleYellows(current, bookRoot, chapterNo)
        return { chapter, outcome: 'pass', yellows, docId: final.docId, path: final.relPath, attempts: attempt }
      }
      if (st.state === 'escalate') {
        const final = save(bookRoot, chapter, current, { snapshotOrigin: 'self-heal' })
        recordAuthorSignal(bookRoot, final.docId, current, 'self-heal', opts.userDataPath ?? undefined)
        recordAiVersion(bookRoot, final.docId, current)
        return { chapter, outcome: 'escalate', reds: redMessages(outcome), docId: final.docId, path: final.relPath, attempts: attempt }
      }
      redIssues = st.redIssues
      reds = redMessages(outcome)
    } else {
      if (outcome.code !== 'NOT_CHAPTER') return { chapter, outcome: 'failed', error: outcome.error, attempts: attempt }
      reds = [`草稿格式不合规：${outcome.error}`]
      redIssues = reds
      if (attempt >= maxAttempts) {
        const final = save(bookRoot, chapter, current, { snapshotOrigin: 'self-heal' })
        recordAuthorSignal(bookRoot, final.docId, current, 'self-heal', opts.userDataPath ?? undefined)
        recordAiVersion(bookRoot, final.docId, current)
        return { chapter, outcome: 'escalate', reds, docId: final.docId, path: final.relPath, attempts: attempt }
      }
    }

    // ③ 退回重写（C-1：预算闸——超限则 escalate，保留当前稿）
    const budget2 = checkAiCallBudget(bookRoot, chapter, config)
    if (!budget2.ok) {
      const final = save(bookRoot, chapter, current, { snapshotOrigin: 'self-heal' })
      recordAuthorSignal(bookRoot, final.docId, current, 'self-heal', opts.userDataPath ?? undefined)
      recordAiVersion(bookRoot, final.docId, current)
      return { chapter, outcome: 'escalate', reds: [...reds, budget2.reason], docId: final.docId, path: final.relPath, attempts: attempt }
    }
    emit(opts, { type: 'self_heal_progress', attempt: attempt + 1, maxAttempts, remaining: reds })
    emit(opts, { type: 'self_heal_phase', phase: 'rewriting', attempt: attempt + 1 })
    emit(opts, { type: 'self_heal_reset' })

    const ruleViolations = collectRuleViolations(current, 'self-heal', bookRoot, chapterNo)
    recordRuleHits(bookRoot, ruleViolations, opts.userDataPath ?? undefined)
    const allIssues = [
      ...redIssues.map((s) => `[必须] ${s}`),
      ...ruleViolations.map((v) => `[建议] ${v.message}`),
    ]

    // A4：与上一次机检红项完全相同（第 2 次）→ 换策略提醒；不同则刷新基线
    const redKey = redSetKey(redIssues)
    const repeated = redKey !== '' && redKey === prevRedKey
    prevRedKey = redKey

    const prompt = buildRewritePrompt(
      'whole',
      current,
      '',
      REWRITE_INSTRUCTION,
      allIssues,
      chapterNo,
      kind,
      repeated ? buildStrategyReminder(redIssues) : undefined,
    )
    const again = await runGenerate(opts, state, kind, prompt, chapter)
    if (again.status === 'aborted') return { outcome: 'aborted' }
    if (again.status !== 'ok') {
      // F2：有稿可交——重写失败保留当前已落盘稿，escalate 附错误原因
      const final = save(bookRoot, chapter, current, { snapshotOrigin: 'self-heal' })
      recordAuthorSignal(bookRoot, final.docId, current, 'self-heal', opts.userDataPath ?? undefined)
      recordAiVersion(bookRoot, final.docId, current)
      return { chapter, outcome: 'escalate', reds: [again.error], docId: final.docId, path: final.relPath, attempts: attempt }
    }
    current = again.text
    save(bookRoot, chapter, current, { snapshotOrigin: 'self-heal' })
    attempt++
  }
}

type SpawnResult =
  | { status: 'ok'; text: string }
  | { status: 'aborted' }
  | { status: 'error'; error: string }

/**
 * 生成入口：优先用注入的 genFn（单测），否则用 provider + tool_use。
 * text 逐字转发主 session（前端实时见产出）。
 */
async function runGenerate(
  opts: SelfHealOpts,
  state: RunState,
  kind: 'long' | 'short',
  userPrompt: string,
  chapter = opts.chapter, // P2-3：批量时传当前章（单章缺省 = opts.chapter 不变）
): Promise<SpawnResult> {
  if (state.ctrl.signal.aborted) return { status: 'aborted' }

  // 注入的生成函数（单测替身）
  if (opts.genFn) {
    try {
      const text = await opts.genFn(userPrompt, kind, state.ctrl.signal, (delta) =>
        emit(opts, { type: 'text', text: delta }),
      )
      if (state.ctrl.signal.aborted) return { status: 'aborted' }
      if (!text.trim()) return { status: 'error', error: 'AI 产出为空' }
      return { status: 'ok', text }
    } catch (e) {
      if (state.ctrl.signal.aborted) return { status: 'aborted' }
      return { status: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  // mock 快路（审查 §六：六条 AI 路径唯独 self-heal 缺失 → 补齐，e2e 可覆盖全自动写章）。
  // emit 模拟增量（前端/测试能见推进），终稿走 assembleChapter（与真实同 decode）。
  const mock = tryMockTool(chapterToolName())
  if (mock) {
    state.usage.calls += 1
    state.usage.inputTokens += mock.usage.inputTokens
    state.usage.outputTokens += mock.usage.outputTokens
    const body = String((mock.input as { 正文?: string })['正文'] ?? '')
    if (body) {
      for (let i = 0; i < body.length; i += 12) {
        emit(opts, { type: 'text', text: body.slice(i, i + 12) })
      }
    }
    const assembled = assembleChapter(mock.input, chapter)
    if (assembled.ok) return { status: 'ok', text: assembled.content }
    return { status: 'error', error: 'AI 产出为空' }
  }

  // 真实 provider + tool_use —— 走 runSpec（统一编排：mock/provider/中断/错误文案）
  const out = await runSpec(selfHealSpec(kind), {
    userDataPath: opts.userDataPath,
    bookRoot: opts.bookRoot,
    chapter,
    userPrompt,
    ctrl: state.ctrl,
    onReset: () => emit(opts, { type: 'self_heal_reset' }),
    onText: (delta) => emit(opts, { type: 'text', text: delta }),
    // Bug C：provider 重试（429/5xx）时推 warning——前端可见「响应异常，重试中」，不再静默卡死
    onRetry: (attempt, error) =>
      emit(opts, {
        type: 'warning',
        message: `AI 响应异常（${error}），第 ${attempt + 1} 次重试中…`,
      }),
  })

  if (!out.ok) {
    if (out.code === 'ABORTED' || state.ctrl.signal.aborted) return { status: 'aborted' }
    return { status: 'error', error: out.error }
  }
  if (state.ctrl.signal.aborted) return { status: 'aborted' }

  // 真实消耗入账（W-P2-7：done 事件不再恒 0；runSpec 已带回 usage）
  state.usage.calls += 1
  if (out.data.usage) {
    state.usage.inputTokens += out.data.usage.inputTokens
    state.usage.outputTokens += out.data.usage.outputTokens
  }

  // C-2：记账已下沉到 runTask（chapter + task 块自动记，避免双记）

  // B-3：max_tokens 截断 → 警告（落盘保留，但让作者知道原因）
  const { input, text, stopReason } = out.data
  if (stopReason === 'max_tokens') {
    emit(opts, { type: 'warning', message: '产出达到长度上限被截断，建议调高单次输出上限' })
  }

  // tool_use 结构化产出 → 拼装 front matter + 正文
  const assembled = assembleChapter(input, chapter)
  if (assembled.ok) return { status: 'ok', text: assembled.content }

  // 降级：tool_use 未命中（AI 产出自由文本）→ 直接用 text
  if (text.trim()) return { status: 'ok', text: text.trim() }
  return { status: 'error', error: 'AI 产出为空' }
}

function redMessages(outcome: CheckOutcome & { ok: true }): string[] {
  return getRedItems(outcome.report).map((i) => i.message)
}

/** 终局黄项复查：对终稿跑规则 → 违规 message 列表（W1 收敛可见性；含 fm——plot 一致规则要比对章纲，正文型规则各自剥） */
function ruleYellows(content: string, bookRoot: string, chapter: number): string[] {
  return collectRuleViolations(content, 'self-heal', bookRoot, chapter).map((v) => v.message)
}

function emit(opts: SelfHealOpts, ev: DriverEvent): void {
  opts.driver.emit?.(opts.mainSession, ev)
}

function emitResult(opts: SelfHealOpts, result: SelfHealOutcome, usage: RunState['usage']): void {
  const ev: DriverEvent =
    result.outcome === 'pass'
      ? { type: 'self_heal_result', outcome: 'pass', yellows: result.yellows, docId: result.docId, path: result.path }
      : result.outcome === 'escalate'
        ? { type: 'self_heal_result', outcome: 'escalate', reds: result.reds, docId: result.docId, path: result.path }
        : result.outcome === 'aborted'
          ? { type: 'self_heal_result', outcome: 'aborted' }
          : { type: 'self_heal_result', outcome: 'failed', error: result.error }
  emit(opts, ev)
  emit(opts, {
    type: 'done',
    cost: 0,
    // W-P2-7：真实 outputTokens 累计（与 stream.ts 口径一致），不再恒 0
    usage: usage.outputTokens,
    reason: result.outcome === 'aborted' ? 'cancelled' : result.outcome === 'failed' ? 'error' : 'success',
  })
}
