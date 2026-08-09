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
import { evaluateRetry } from '../../process/retry.js'
import { getRedItems } from '../../check/types.js'
import type { BookConfig } from '../../format/types.js'
import type { DriverEvent, Session, StudioDriver } from '../../driver/index.js'
// 以下纯逻辑函数（checkWithDb/buildDraftPrompt/saveDraft/buildRewritePrompt/draftFileName/readKind）
// 物理上位于 api/（与端点同文件），本身不依赖 HTTP 语境；待后续下沉治理。
import { readKind } from '../../format/kind.js'
import { checkWithDb, type CheckOutcome } from '../../check/run.js'
import { buildDraftPrompt, saveDraft } from '../../process/draft-pipeline.js'
import { buildRewritePrompt } from '../../process/rewrite-prompt.js'
import { tryMockTool } from '../mock-tool.js'
import { runSpec } from '../tasks/spec.js'
import { selfHealSpec } from '../tasks/specs.js'
import { checkAiCallBudget } from '../calls.js'
import { chapterToolName, assembleChapter } from '../contract/index.js'
import { collectRuleViolations } from '../rules/index.js'
import { recordRuleHits } from '../rule-hits.js'
import { splitFrontMatter } from '../../format/frontmatter.js'

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
  chapter: number
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
  | { outcome: 'pass'; chapter: number; docId: string; path: string; attempts: number; yellows: string[] }
  | { outcome: 'escalate'; chapter: number; reds: string[]; docId: string; path: string; attempts: number }
  | { outcome: 'aborted' }
  | { outcome: 'failed'; error: string }

/** 运行中的编排（book 级并发锁 + 中断句柄） */
interface RunState {
  ctrl: AbortController
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
export async function runSelfHeal(opts: SelfHealOpts): Promise<SelfHealOutcome> {
  const state: RunState = { ctrl: new AbortController() }
  running.set(opts.bookName, state)
  let result: SelfHealOutcome
  try {
    result = await orchestrate(opts, state)
  } catch (e) {
    result = { outcome: 'failed', error: e instanceof Error ? e.message : String(e) }
  } finally {
    running.delete(opts.bookName)
  }
  emitResult(opts, result)
  return result
}

async function orchestrate(opts: SelfHealOpts, state: RunState): Promise<SelfHealOutcome> {
  const { bookRoot, chapter } = opts
  const maxAttempts = opts.maxAttempts ?? 3
  const save = opts.save ?? saveDraft
  const kind = readKind(bookRoot)

  // 前端：running=true + 清空旧正文
  emit(opts, { type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })

  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const hasWiring = existsSync(join(bookRoot, '布线'))
  if (hasWiring) {
    const rebuilt = rebuild(bookRoot, join(bookRoot, '.cache', 'index.db'))
    if (rebuilt.errors.length > 0) {
      return { outcome: 'failed', error: '源文件解析失败，先修这些文件再重试' }
    }
  }
  const check = opts.check ?? ((p: string) => checkWithFreshDb(bookRoot, p, config))

  // ① 首稿（C-1：预算闸——超限不跑）
  const budget = checkAiCallBudget(bookRoot, chapter, config)
  if (!budget.ok) return { outcome: 'failed', error: budget.reason }
  emit(opts, { type: 'self_heal_phase', phase: 'drafting' })
  const first = await runGenerate(opts, state, kind, buildDraftPrompt(bookRoot, chapter, kind))
  if (first.status !== 'ok') return spawnFailure(first)
  let current = first.text
  const firstDraft = save(bookRoot, chapter, current, { recordAi: false, snapshotOrigin: 'self-heal' })
  const draftPath = join(bookRoot, firstDraft.relPath)

  // ② 机检 → 红则重写 → 全绿或触顶
  let attempt = 0
  for (;;) {
    if (state.ctrl.signal.aborted) return { outcome: 'aborted' }
    emit(opts, { type: 'self_heal_phase', phase: 'checking', attempt })
    const outcome = check(draftPath)

    let reds: string[]
    let redIssues: string[] // K13：结构化红项数组（消除字符串往返）
    let chapterNo = chapter

    if (outcome.ok) {
      chapterNo = outcome.chapter.章号
      const st = evaluateRetry(outcome.report, attempt, maxAttempts)
      if (st.state === 'pass') {
        const final = save(bookRoot, chapter, current, { recordAi: true, snapshotOrigin: 'self-heal' })
        // W1 终局黄项复查：pass 前对终稿跑一次规则（剥离 fm 只查正文），
        // 只提示不 gate——黄项收敛与否让作者可见（「收窄」从 mock 变成系统验证）。
        const yellows = ruleYellows(current, bookRoot, chapterNo)
        // B-P1-2：透传章号（opts.chapter），formatHealResult 显示"第N章"而非 docId
        return { outcome: 'pass', chapter: opts.chapter, docId: final.docId, path: final.relPath, attempts: attempt, yellows }
      }
      if (st.state === 'escalate') {
        const final = save(bookRoot, chapter, current, { recordAi: true, snapshotOrigin: 'self-heal' })
        return {
          outcome: 'escalate',
          chapter: opts.chapter, // B-P1-2：透传章号
          reds: redMessages(outcome),
          docId: final.docId,
          path: final.relPath,
          attempts: attempt,
        }
      }
      redIssues = st.redIssues
      reds = redMessages(outcome)
    } else {
      // tool_use 契约下 fm 漂移不应出现；但保留降级处理
      if (outcome.code !== 'NOT_CHAPTER') return { outcome: 'failed', error: outcome.error }
      reds = [`草稿格式不合规：${outcome.error}`]
      redIssues = reds
      if (attempt >= maxAttempts) {
        const final = save(bookRoot, chapter, current, { recordAi: true, snapshotOrigin: 'self-heal' })
        return { outcome: 'escalate', chapter: opts.chapter, reds, docId: final.docId, path: final.relPath, attempts: attempt }
      }
    }

    // ③ 退回重写（C-1：预算闸——超限则 escalate，保留当前稿）
    const budget2 = checkAiCallBudget(bookRoot, chapter, config)
    if (!budget2.ok) {
      const final = save(bookRoot, chapter, current, { recordAi: true, snapshotOrigin: 'self-heal' })
      return { outcome: 'escalate', chapter: opts.chapter, reds: [...reds, budget2.reason], docId: final.docId, path: final.relPath, attempts: attempt }
    }
    emit(opts, { type: 'self_heal_progress', attempt: attempt + 1, maxAttempts, remaining: reds })
    emit(opts, { type: 'self_heal_phase', phase: 'rewriting', attempt: attempt + 1 })
    emit(opts, { type: 'self_heal_reset' })

    // B2：黄项修复指令（规则违规，提示不卡——不计入 evaluateRetry 全绿判定）
    const ruleViolations = collectRuleViolations(ruleBody(current), 'self-heal', bookRoot, chapterNo)
    // B3：规则命中统计（供工作台高频违规面板 + B4 前置注入）
    recordRuleHits(bookRoot, ruleViolations)
    // 红项 [必须] / 黄项 [建议]：AI 能区分硬性错误与文风建议（优先级不同取舍）
    const allIssues = [
      ...redIssues.map((s) => `[必须] ${s}`),
      ...ruleViolations.map((v) => `[建议] ${v.message}`),
    ]

    const prompt = buildRewritePrompt(
      'whole',
      current,
      '',
      REWRITE_INSTRUCTION,
      allIssues,
      chapterNo,
      kind,
    )
    const again = await runGenerate(opts, state, kind, prompt)
    if (again.status !== 'ok') return spawnFailure(again)
    current = again.text
    save(bookRoot, chapter, current, { recordAi: false, snapshotOrigin: 'self-heal' })
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
    const body = String((mock.input as { 正文?: string })['正文'] ?? '')
    if (body) {
      for (let i = 0; i < body.length; i += 12) {
        emit(opts, { type: 'text', text: body.slice(i, i + 12) })
      }
    }
    const assembled = assembleChapter(mock.input, opts.chapter)
    if (assembled.ok) return { status: 'ok', text: assembled.content }
    return { status: 'error', error: 'AI 产出为空' }
  }

  // 真实 provider + tool_use —— 走 runSpec（统一编排：mock/provider/中断/错误文案）
  const out = await runSpec(selfHealSpec(kind), {
    userDataPath: opts.userDataPath,
    bookRoot: opts.bookRoot,
    chapter: opts.chapter,
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

  // C-2：记账已下沉到 runTask（chapter + task 块自动记，避免双记）

  // B-3：max_tokens 截断 → 警告（落盘保留，但让作者知道原因）
  const { input, text, stopReason } = out.data
  if (stopReason === 'max_tokens') {
    emit(opts, { type: 'warning', message: '产出达到长度上限被截断，建议调高单次输出上限' })
  }

  // tool_use 结构化产出 → 拼装 front matter + 正文
  const assembled = assembleChapter(input, opts.chapter)
  if (assembled.ok) return { status: 'ok', text: assembled.content }

  // 降级：tool_use 未命中（AI 产出自由文本）→ 直接用 text
  if (text.trim()) return { status: 'ok', text: text.trim() }
  return { status: 'error', error: 'AI 产出为空' }
}

function spawnFailure(r: SpawnResult): SelfHealOutcome {
  if (r.status === 'aborted') return { outcome: 'aborted' }
  return { outcome: 'failed', error: r.status === 'error' ? r.error : '写稿失败' }
}

/** 每轮开关 db */
function checkWithFreshDb(
  bookRoot: string,
  draftPath: string,
  config: BookConfig,
): CheckOutcome {
  const hasWiring = existsSync(join(bookRoot, '布线'))
  const db = hasWiring ? new DatabaseSync(join(bookRoot, '.cache', 'index.db')) : null
  try {
    return checkWithDb(bookRoot, draftPath, db, config)
  } finally {
    if (db) db.close()
  }
}

function redMessages(outcome: CheckOutcome & { ok: true }): string[] {
  return getRedItems(outcome.report).map((i) => i.message)
}

/** 规则检验只查正文（剥离 front matter，避免 fm 短行污染文风指纹） */
function ruleBody(content: string): string {
  const split = splitFrontMatter(content)
  return split ? split.body : content
}

/** 终局黄项复查：对终稿正文跑规则 → 违规 message 列表（W1 收敛可见性） */
function ruleYellows(content: string, bookRoot: string, chapter: number): string[] {
  return collectRuleViolations(ruleBody(content), 'self-heal', bookRoot, chapter).map((v) => v.message)
}

function emit(opts: SelfHealOpts, ev: DriverEvent): void {
  opts.driver.emit?.(opts.mainSession, ev)
}

function emitResult(opts: SelfHealOpts, result: SelfHealOutcome): void {
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
    usage: 0,
    reason: result.outcome === 'aborted' ? 'cancelled' : result.outcome === 'failed' ? 'error' : 'success',
  })
}
