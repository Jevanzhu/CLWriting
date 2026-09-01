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
import { join, relative, sep } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { rebuild } from '../../cache/rebuild.js'
import { readBookConfig } from '../../format/yaml.js'
import { applyGlobalDefaults } from '../../format/global-defaults.js'
import type { BookConfig } from '../../format/types.js'
import { evaluateRetry, redSetKey, buildStrategyReminder } from '../../process/retry.js'
import { prepareMaterials } from '../../process/materials.js'
import { readOutlineLeads } from '../../check/outline-leads.js'
import { atomicWriteFile } from '../../fs/atomic.js'
import { getRedItems } from '../../check/types.js'
import { openSessionStore, openSessionStoreAsync, bookHash } from '../../events/store.js'
import { ChainRecorder, checkReportEvent, retryAttemptEvent, goalChangeEvent, todoWriteEvent } from '../../events/chain-bridge.js'
import { registerBackgroundTask } from './background.js'
import type { GoalOperation, GoalState, Todo } from '../../events/types.js'
import type { DriverEvent, Session, StudioDriver } from '../../driver/index.js'
// 以下纯逻辑函数（checkWithDb/buildDraftPrompt/saveDraft/buildRewritePrompt/draftFileName/readKind）
// 物理上位于 api/（与端点同文件），本身不依赖 HTTP 语境；待后续下沉治理。
import { readKind } from '../../format/kind.js'
import { checkWithDb, type CheckOutcome } from '../../check/run.js'
import { buildDraftPrompt, saveDraft } from '../../process/draft-pipeline.js'
import { generateLeadUpdateDraft } from '../../process/lead-update-draft.js'
import { buildRewritePrompt } from '../../process/rewrite-prompt.js'
import { assembleChapter } from '../contract/index.js'
import { runSpec } from '../tasks/spec.js'
import { selfHealSpec } from '../tasks/specs.js'
import { checkAiCallBudget } from '../calls.js'
import { resolveModelPricing, computeCallCost } from '../pricing.js'
import { collectRuleViolations } from '../rules/index.js'
import { recordRuleHits } from '../rule-hits.js'
import { recordAuthorSignal } from '../author-signal.js'
import { recordAiVersion } from '../../git/ai-track.js'
import { writeBatchPause, clearBatchPause } from '../../state/batch-pause.js'
import { log } from '../../log/index.js'


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
  /** R76-12（二十四轮 A 域）：chat 对话嵌套写章标记（write_chapter 工具驱动）——登记进
   *  RunState 供 isChatEmbeddedSelfHealRunning 查询；chat 入口闸据此放行 steer 入队
   *  （独立写稿仍 409），不改变写稿链路自身行为。 */
  embedded?: boolean
  /** 最大重写次数（默认 3） */
  maxAttempts?: number
  /** 机检注入（单测替身） */
  check?: (draftPath: string) => CheckOutcome
  /** 落盘注入（单测替身） */
  save?: typeof saveDraft
  /** 生成函数注入（单测替身）；缺省用 provider + tool_use 生成。
   *  接收 userPrompt + kind，返回完整 markdown（front matter + 正文）。 */
  genFn?: (userPrompt: string, kind: 'long' | 'short', signal: AbortSignal, onText: (delta: string) => void) => Promise<string>
  /**
   * Z-P2-5：ctrl 登记 driver（/interrupt 的 driver.interrupt() 与 isRunning() 据此对生成期生效）。
   * 仅 /auto-write 端点传；chat 内嵌写章（write_chapter 工具）不传——彼时 chat 自身 ctrl
   * 已在同一 session 在册，再登记会触发 cc registerCtrl 的 P2-6 语义（换新先 abort 旧）
   * 误伤外层对话，且经 chat.ts 的 abort 桥接反过来把本次写章一并中断。
   */
  register?: (ctrl: AbortController) => void
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
  /** R76-12：chat 对话嵌套写章标记（SelfHealOpts.embedded 透传） */
  embedded?: boolean
  /** 本次运行 AI 消耗累计（done 事件上报，W-P2-7；genFn 单测替身无 usage 不入账）。
   *  cost 按次现算累计（写稿模型四档分计，未配价不入账）——与 stream.ts /spawn 同口径。
   *  低级项（第六轮）：删掉无人读取的 calls/inputTokens 累计（emitResult 只读
   *  cost/outputTokens，单次明细已在事件库 llm/call 行）
   *  R73-10：estimated——任一 attempt 为估计入账（R73-1）时置位，done 事件透出
   *  usageEstimated（前端可区分实测/估计口径） */
  usage: { outputTokens: number; cost: number; estimated?: boolean }
}
const running = new Map<string, RunState>()

/** 本书是否正在全自动写章 */
export function isSelfHealRunning(bookName: string): boolean {
  return running.has(bookName)
}

/** R76-12（二十四轮 A 域）：在途自愈是否为 chat 对话嵌套写章（write_chapter 工具驱动）
 *  ——chat 入口闸（stream.ts）据此区分独立写稿（409 拒新对话）与对话嵌套写稿（放行
 *  交 sendChatMessage 入队 steer，当前轮结束自动续链）。 */
export function isChatEmbeddedSelfHealRunning(bookName: string): boolean {
  return running.get(bookName)?.embedded === true
}

/** R67-13 回归注入（先例同 api/review.ts __setReviewRunning）——orchestrationBusyFor
 *  互斥矩阵测试需制造「self-heal 在途」态，真实跑完整闭环过重。生产零调用。 */
export function __setSelfHealRunningForTest(bookName: string, on: boolean): void {
  if (on) running.set(bookName, { ctrl: new AbortController(), usage: { outputTokens: 0, cost: 0 } })
  else running.delete(bookName)
}

/** #7：在途 runSelfHeal 的收尾 Promise（改名/删书/退出等待用；含 emitResult 后的完整收尾） */
const settling = new Map<string, Promise<unknown>>()

/** #7：等本书在途自愈收尾（无在途立即返回）。与 chat.ts waitChatSettled 同款——
 * abort 是异步信号，straggler 的链路事件 flush 在关库/搬路径后恢复会丢/抛。
 * M-3：循环等到表项清空（防表项被替换后等待方拿旧 resolve 提前返回——与 chat 侧同构） */
export async function waitSelfHealSettled(bookName: string): Promise<void> {
  for (;;) {
    const p = settling.get(bookName)
    if (!p) return
    await p.catch(() => undefined)
  }
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
    if (!r.ok) log.error('self-heal', `账本推进草稿生成失败（${r.code}）：${r.error}`)
  } catch (e) {
    log.error('self-heal', `账本推进草稿生成异常：${e instanceof Error ? e.message : String(e)}`)
  }
}

export function runSelfHeal(opts: SelfHealOpts): Promise<SelfHealOutcome> {
  // #7：收尾 Promise 登记（外层包装不改内部语义；含 emitResult 完整收尾后才 resolve）
  const p = runSelfHealInner(opts)
  settling.set(opts.bookName, p)
  const cleanup = (): void => {
    if (settling.get(opts.bookName) === p) settling.delete(opts.bookName)
  }
  p.then(cleanup, cleanup)
  return p
}

async function runSelfHealInner(opts: SelfHealOpts): Promise<SelfHealOutcome> {
  const state: RunState = { ctrl: new AbortController(), usage: { outputTokens: 0, cost: 0 }, ...(opts.embedded ? { embedded: true } : {}) }
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

/** P2：自愈链路事件录制（每书 workspace 会话；观测层失败静默 → null）
 *  R34D-19（三十四轮）：转 async——开库走 openSessionStoreAsync（首开锁等待不阻塞
 *  服务事件循环），建链半途抛错先关库再降级口径不变。 */
async function mkChain(opts: SelfHealOpts): Promise<ChainRecorder | null> {
  let store: ReturnType<typeof openSessionStore> = null
  try {
    store = await openSessionStoreAsync(opts.userDataPath, opts.bookRoot)
    if (!store) return null
    return new ChainRecorder(store, store.workspaceSession(bookHash(opts.bookRoot)))
  } catch {
    // 二轮复审（低级）：同 runner.ts mkChain——建链半途抛错先关库再降级，防引用滞留
    store?.close()
    return null
  }
}

async function orchestrate(opts: SelfHealOpts, state: RunState): Promise<SelfHealOutcome> {
  const { bookRoot } = opts
  const maxAttempts = opts.maxAttempts ?? 3
  // P2：自愈链路事件录制（check/report + retry/attempt 挂 workspace 会话；观测层静默）
  const chain = await mkChain(opts)
  const save = opts.save ?? saveDraft
  const kind = readKind(bookRoot)
  // P2-3：批量连写——opts.chapters 有值走批量循环；无则单章旧逻辑（逐字不变，防回归）
  const chapters = opts.chapters
  // dd-P2：length>0 即批量——单元素 [N] 此前被静默忽略改跑 opts.chapter，与注释语义矛盾
  const isBatch = chapters !== undefined && chapters.length > 0
  // dd-P2：db 声明提前 + 单一 finally 收口——此前「源文件解析失败」早返回与
  // DatabaseSync 打开失败抛错都绕过两个内层 finally，chain（openSessionStore
  // 引用计数）与 db 句柄在长驻 studio 服务里永久泄漏、重试持续累加
  let db: InstanceType<typeof DatabaseSync> | null = null
  try {
    // 前端：running=true + 清空旧正文
    emit(opts, { type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
    if (isBatch) {
      emit(opts, { type: 'self_heal_batch', total: chapters!.length })
      emit(opts, { type: 'self_heal_phase', phase: 'chapter_start', chapter: chapters![0], done: 0, total: chapters!.length })
    }

    // P3-6：book.yaml 只解析一次——批量连写每章共用（此前 runChapter 每章各读一次，
    // 写 8 章重复解析 8 次同一文件）。
    // 全局托底：orchestrate 内自读 config 喂 budget 检查——统一过 applyGlobalDefaults
    // （书级未设 calls_per_chapter 等回落 global.json → 硬编码，喂 checkAiCallBudget 的
    // 是有效值而非 undefined）
    const config = applyGlobalDefaults(readBookConfig(join(bookRoot, 'book.yaml')).config, opts.userDataPath)
    const hasWiring = existsSync(join(bookRoot, '布线'))
    if (hasWiring) {
      const rebuilt = rebuild(bookRoot, join(bookRoot, '.cache', 'index.db'))
      if (rebuilt.errors.length > 0) {
        return { outcome: 'failed', error: '源文件解析失败，先修这些文件再重试' }
      }
    }
    // 复用 db 连接：rebuild 后开一次，循环内 check 不重开（P2-BE-5）。
    // busy_timeout 与 rebuild/机检端点同款——自愈与树红点聚合可并发，等锁而非 SQLITE_BUSY
    db = hasWiring ? new DatabaseSync(join(bookRoot, '.cache', 'index.db')) : null
    if (db) db.exec('PRAGMA busy_timeout = 5000')
    const check = opts.check ?? ((p: string) => checkWithDb(bookRoot, p, db, config))

    // F2：单章/批量共享同一套 ctx（消除双路径重复）
    const ctx: ChapterCtx = { bookRoot, maxAttempts, save, kind, check, db, chain, config }

    // P2-3：批量连写——循环各章走同一套单章闭环，章间 emit chapter_done/start 进度。
    // 每章独立开算 budget；中途 escalate/预算超限 → 停后续章 + 报 batch_progress。
    if (isBatch) {
      return await orchestrateBatch(opts, state, ctx, chapters!)
    }

    // F2：单章统一走 runChapter（与批量同源，消除双路径重复 + 语义统一：
    // 无稿可交（首稿预算超限/生成失败）→ failed；有稿可交 → escalate（保留稿））
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
  /** P3-6：book.yaml 解析一次，循环共用（预算闸/check 同源） */
  config: BookConfig
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
  // M6 #34 连写暂停元状态（驱动侧接线）：开批即清旧暂停记录（重开=作者已处置上次的停），
  // 此后任何未跑完的停法（aborted/failed/escalate）重新落暂停——进书近况（state.ts
  // readBatchPause → StatusRecap.batchPause）据此提示「连写暂停在第 N 章（原因）」。
  // 观测性元数据：落盘失败静默降级，不挡写稿主线（与备料 best-effort 同口径）。
  // R33D-1（三十三轮）：writeBatchPause/clearBatchPause 异步化（锁等待 Async 孪生）——
  // recordPause 保持 fire-and-forget 语义（void + catch 吞 rejection）；开批清暂停 await。
  const recordPause = (atChapter: number, reason: string, detail: string): void => {
    void writeBatchPause(opts.bookRoot, { atChapter, reason, detail }).catch(() => {
      // 暂停记录失败不影响连写结果与回报
    })
  }
  try {
    await clearBatchPause(opts.bookRoot)
  } catch {
    // 同上
  }
  for (let i = 0; i < total; i++) {
    const ch = chapters[i]!
    if (state.ctrl.signal.aborted) {
      recordPause(ch, 'aborted', '用户中止连写')
      return { outcome: 'aborted' }
    }

    const run = await runChapter(opts, state, ctx, ch)
    if (run.outcome === 'aborted') {
      recordPause(ch, 'aborted', '用户中止连写')
      return { outcome: 'aborted' }
    }
    // F2 语义统一：无稿（首稿预算超限/生成失败）→ failed 停后续章；有稿 escalate 同样停
    if (run.outcome === 'failed') {
      emit(opts, { type: 'self_heal_batch_progress', done: i, total, stoppedAt: ch })
      recordPause(ch, 'failed', run.error)
      return { outcome: 'failed', error: run.error }
    }
    // 单章 escalate → 停后续章，报批量进度（done=已完成章数）
    if (run.outcome === 'escalate') {
      emit(opts, { type: 'self_heal_batch_progress', done: i, total, stoppedAt: ch })
      recordPause(ch, 'escalate', (run.reds ?? []).join('；'))
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
 * GG-F1① 备料接线：self-heal 首稿前调 prepareMaterials 写 工作区/本章写作材料.md。
 * - ctx.db 为空（无布线书，.cache/index.db 不存在）→ 近况/账本段无数据源，维持接线前行为；
 * - best-effort：备料抛错不挡写稿（buildDraftPrompt 读不到新文件 = prompt 少「备料」段）。
 * config 用 ctx 合并值（已过 applyGlobalDefaults，P3-6 解析一次）；leadIds 按本章细纲声明。
 * C1（批 2）：返回本次 prompt 引用的材料文件（材料文件 + 注入的章摘要）。
 * Q-5（第十五轮）：调用方与 buildDraftPrompt 的注入源清单（细纲/章纲/设定层/样章）
 * 合并去重后经 runSpec promptFiles → llm/call promptMeta.files 登记——此前只登记备料
 * 两类，「可见⟺已记录」在设定/样章段断裂。
 */
async function prepareChapterMaterials(
  opts: SelfHealOpts,
  ctx: ChapterCtx,
  chapter: number,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!ctx.db) return []
  // R-4（第十六轮）：promptFiles 只登记备料成功后真实注入的文件——此前无条件含
  // 工作区/本章写作材料.md，备料失败时（buildDraftPrompt 读不到材料 = prompt 无备料段）
  // 登记却还在 = 溯源虚报。铁律：模型可见 ⟺ 已记录。
  let promptFiles: string[] = []
  try {
    const r = await prepareMaterials(ctx.db, ctx.config, {
      bookRoot: ctx.bookRoot,
      workDir: opts.cwd,
      userDataPath: opts.userDataPath,
      chapterLeadIds: readOutlineLeads(ctx.bookRoot, chapter),
      // kk-P1-2：备料场景与 draft 链同源（readChapterScenes 三级回退）——
      // 此前不传 → 备料恒按「战斗」选样章，与本章实际场景脱节
      chapter,
      // R76-5（二十四轮 A 域）：编排级中断透传——备料补漏的近章/卷摘要在途 LLM 调用
      // 此前不受中断传播（Z-P1-1 修了 rewrite/lead_update 独漏此面），批量连写点中断
      // 时分钟级白烧 token、running 迟迟不释放。
      ...(signal ? { signal } : {}),
    })
    atomicWriteFile(join(ctx.bookRoot, '工作区', '本章写作材料.md'), r.text, { fsync: true })
    promptFiles = ['工作区/本章写作材料.md', ...r.injectedSummaryFiles]
  } catch {
    // 备料失败静默降级——写稿主线不被备料拖死（RAG 召回失败已在 materials 内部降级留痕）。
    // R-4（第十六轮）：清掉旧章残留材料（best-effort）——此前静默沿用旧材料文件，
    // buildDraftPrompt 会把上一章的材料注入本章 prompt（模型可见却无本次出处）。
    // 读不到材料文件 = prompt 无备料段，是设计内降级。
    try {
      rmSync(join(ctx.bookRoot, '工作区', '本章写作材料.md'), { force: true })
    } catch {
      // 清理失败（如权限/磁盘）忽略——降级路径不反向阻断写稿主线
    }
  }
  return promptFiles
}

/** 单章闭环的可变循环态（终稿文本/账本草稿尝试位/红项基线/轮次均跨轮演化） */
interface HealLoop {
  chapter: number
  /** 首稿落盘路径（机检入口） */
  draftPath: string
  /** 当前终稿文本（重写成功后覆盖；persistFinal 调用时取当次值） */
  current: string
  /** X-P1-2：账本侧红补生成是否已试过（只试一次） */
  leadDraftTried: boolean
  /** A4：上一次机检红项集合 key（相同两次 → 换策略提醒） */
  prevRedKey: string | null
  attempt: number
  hasWiring: boolean
}

/** 终态出口共享闭包组（终稿三连 + todo/goal 事件）——persistFinal 语义不动（ii 批口径）；
 *  R32-5（三十二轮）：persistFinal 随 saveDraft 异步化改 async（保存锁等待异步孪生） */
interface ChapterTerminal {
  persistFinal(): Promise<{ docId: string; relPath: string }>
  writeTodos(draft: Todo['state'], check: Todo['state'], fix: Todo['state']): void
  writeGoal(op: GoalOperation, st: GoalState, extra?: { blockedReason?: string; rounds?: number }): void
}

/** F5 todo/goal + ii 批终稿三连的闭包工厂（chapter/goalId/goalNow 随单章闭包内固定） */
function mkTerminal(opts: SelfHealOpts, ctx: ChapterCtx, loop: HealLoop): ChapterTerminal {
  const { chapter } = loop
  const goalId = 'self-heal:ch' + chapter
  const goalNow = Date.now()
  const writeTodos = (draft: Todo['state'], check: Todo['state'], fix: Todo['state']): void => {
    ctx.chain?.add(todoWriteEvent({
      todos: [
        { text: '写第' + chapter + '章首稿', state: draft },
        { text: '机检第' + chapter + '章', state: check },
        { text: '修复第' + chapter + '章红项', state: fix },
      ],
    }))
  }
  const writeGoal = (op: GoalOperation, state: GoalState, extra?: { blockedReason?: string; rounds?: number }): void => {
    ctx.chain?.add(goalChangeEvent({
      operation: op,
      goal: {
        id: goalId,
        title: '修复第' + chapter + '章红项',
        state,
        roundsStarted: extra?.rounds ?? 0,
        ...(ctx.maxAttempts !== undefined ? { maxGoalRounds: ctx.maxAttempts } : {}),
        ...(extra?.blockedReason ? { blockedReason: extra.blockedReason } : {}),
        createdAt: goalNow,
        updatedAt: Date.now(),
      },
    }))
  }
  const persistFinal = async () => {
    const final = await ctx.save(ctx.bookRoot, chapter, loop.current, { snapshotOrigin: 'self-heal' })
    await recordAuthorSignal(ctx.bookRoot, final.docId, loop.current, 'self-heal', opts.userDataPath ?? undefined)
    recordAiVersion(ctx.bookRoot, final.docId, loop.current)
    return final
  }
  return { persistFinal, writeTodos, writeGoal }
}

/** ① 首稿相位：预算闸 → 备料 → 生成 → 落盘（status 非 ok 时 chapter 闭环即失败/中止） */
async function draftFirstChapter(
  opts: SelfHealOpts,
  state: RunState,
  ctx: ChapterCtx,
  chapter: number,
): Promise<
  | { status: 'ok'; text: string; draftPath: string }
  | { status: 'aborted' }
  | { status: 'error'; error: string }
> {
  // C-1：预算闸——超限不跑；config 由 orchestrate 解析一次传入（P3-6）
  // 预算闸时序（第十六轮复审附带项，口径登记不修）：备料阶段（下方 prepareChapterMaterials）
  // 内的近章摘要补漏 AI 调用发生在本次闸检查之后——其计入本章 calls_per_chapter
  // （自愈路径 budgetChapter），下一次闸检查即收敛，不构成预算逃逸。
  const budget = checkAiCallBudget(ctx.bookRoot, chapter, ctx.config)
  if (!budget.ok) return { status: 'error', error: budget.reason }
  // GG-F1①（ii 清偿批接线）：首稿前备料——prepareMaterials 组装（近况/本章账本推进/
  // 文风条目+样章/近章结尾/前章正文结尾；RAG 按配置召回、未配/失败自动降级）原子写
  // 工作区/本章写作材料.md，buildDraftPrompt 的「备料」段自此有生产写入方。
  // C1（批 2）：备料返回 prompt 引用材料（材料文件 + 章摘要）→ promptFiles 登记
  const materialFiles = await prepareChapterMaterials(opts, ctx, chapter, state.ctrl.signal)
  emit(opts, { type: 'self_heal_phase', phase: 'drafting' })
  // Q-5（第十五轮）：draft prompt 自带注入源清单（细纲/章纲/设定层/样章）——与备料
  // 清单合并去重（注入序）进 promptMeta.files，铁律①文件级溯源闭合
  const draft = buildDraftPrompt(ctx.bookRoot, chapter, ctx.kind, ctx.config)
  const promptFiles = [...new Set([...materialFiles, ...draft.files])]
  const first = await runGenerate(opts, state, ctx.kind, draft.prompt, chapter, promptFiles)
  if (first.status === 'aborted') return { status: 'aborted' }
  if (first.status !== 'ok') return { status: 'error', error: first.error }
  // R26-5（二十六轮）：save 抛错收编（磁盘满/EACCES 等）——原样上抛会穿出 runChapter/
  // orchestrateBatch，批量侧不落暂停记录（recordPause 只认返回值形态）。转 error 出口
  // 后由调用方按既有 failed 链收口（此刻 goal 尚未写 active，无悬挂面）。
  let firstDraft: { relPath: string }
  try {
    firstDraft = await ctx.save(ctx.bookRoot, chapter, first.text, { snapshotOrigin: 'self-heal' })
  } catch (e) {
    return { status: 'error', error: `首稿落盘失败：${e instanceof Error ? e.message : String(e)}` }
  }
  return { status: 'ok', text: first.text, draftPath: join(ctx.bookRoot, firstDraft.relPath) }
}

/** X-P1-2 账本复查相位：账本侧红（lead-declared-not-done）不可修——补生成账本推进草稿后
 *  复查一次。返回 true = 已补且有效，轮循环 continue 重查；只试一次（leadDraftTried）。 */
async function maybeLeadRedraft(
  opts: SelfHealOpts,
  state: RunState,
  ctx: ChapterCtx,
  loop: HealLoop,
  outcome: CheckOutcome & { ok: true },
  chapterNo: number,
): Promise<boolean> {
  if (!loop.hasWiring || loop.leadDraftTried) return false
  if (!getRedItems(outcome.report).some((r) => r.checkId === 'lead-declared-not-done')) return false
  loop.leadDraftTried = true
  emit(opts, { type: 'self_heal_phase', phase: 'lead_update', attempt: loop.attempt })
  // Z-P1-1：编排级 signal 透传——中断自愈时账本草稿生成同步中止（不跑到总超时）
  const gen = await generateLeadUpdateDraft(ctx.bookRoot, chapterNo, opts.userDataPath, state.ctrl.signal)
  return gen.ok && gen.count > 0
}

/** P2：打回评估事件化（重试链可重放；pass 不记） */
function recordRetryAttempt(
  chain: ChainRecorder | null,
  st: ReturnType<typeof evaluateRetry>,
  maxAttempts: number,
  attempt: number,
): void {
  if (st.state !== 'pass') {
    chain?.add(retryAttemptEvent({ attempt, maxAttempts: st.state === 'retry' ? st.maxAttempts : maxAttempts, redIssues: st.redIssues }))
  }
}

/** ③ 重写调用相位：预算闸② → 进度/reset → 违规收集 → 换策略判定 → 重写生成 → 落盘。
 *  ok 时 loop.current 已更新、attempt 已自增（轮循环回 ② 重查）。 */
async function rewriteOnce(
  opts: SelfHealOpts,
  state: RunState,
  ctx: ChapterCtx,
  loop: HealLoop,
  reds: string[],
  redIssues: string[],
  chapterNo: number,
): Promise<
  | { status: 'ok' }
  | { status: 'aborted' }
  | { status: 'error'; error: string }
  | { status: 'budget'; reason: string }
> {
  // C-1：预算闸——超限则 escalate，保留当前稿
  const budget2 = checkAiCallBudget(ctx.bookRoot, loop.chapter, ctx.config)
  if (!budget2.ok) return { status: 'budget', reason: budget2.reason }
  emit(opts, { type: 'self_heal_progress', attempt: loop.attempt + 1, maxAttempts: ctx.maxAttempts, remaining: reds })
  emit(opts, { type: 'self_heal_phase', phase: 'rewriting', attempt: loop.attempt + 1 })
  emit(opts, { type: 'self_heal_reset' })

  const ruleViolations = collectRuleViolations(loop.current, 'self-heal', ctx.bookRoot, chapterNo)
  // R32-13：随 recordRuleHits 异步化
  await recordRuleHits(ctx.bookRoot, ruleViolations, opts.userDataPath ?? undefined)
  const allIssues = [
    ...redIssues.map((s) => `[必须] ${s}`),
    ...ruleViolations.map((v) => `[建议] ${v.message}`),
  ]

  // A4：与上一次机检红项完全相同（第 2 次）→ 换策略提醒；不同则刷新基线
  const redKey = redSetKey(redIssues)
  const repeated = redKey !== '' && redKey === loop.prevRedKey
  loop.prevRedKey = redKey

  const prompt = buildRewritePrompt(
    'whole',
    loop.current,
    '',
    REWRITE_INSTRUCTION,
    allIssues,
    chapterNo,
    ctx.kind,
    repeated ? buildStrategyReminder(redIssues) : undefined,
    // 字数区间与首稿链同口径（ctx.config 已是 applyGlobalDefaults 合并值）
    ctx.config.book.chapter_target_words,
  )
  // R-3（第十六轮）：整章重写注入 loop.current（= 首稿/上轮重写正文，来自 loop.draftPath
  // 的章文件）——补登记该正文文件路径，铁律「模型可见 ⟺ 已记录」在 rewrite 链闭合
  const again = await runGenerate(opts, state, ctx.kind, prompt, loop.chapter, [
    relative(ctx.bookRoot, loop.draftPath).split(sep).join('/'),
  ])
  if (again.status === 'aborted') return { status: 'aborted' }
  if (again.status !== 'ok') return { status: 'error', error: again.error }
  loop.current = again.text
  // R26-5（二十六轮）：save 抛错收编——此刻 goal 已 writeGoal('create','active')，原样
  // 上抛 = goal 悬挂 active + 批量不落暂停（R76-11 修机检同族时漏掉的写盘路径）。转
  // error 出口：调用方走 exitEscalateBlocked（F2 语义——重写失败 escalate 保留当前
  // 已落盘稿），goal 落 block 附原因、批量按 escalate 落暂停，终态收口闭合。
  try {
    await ctx.save(ctx.bookRoot, loop.chapter, loop.current, { snapshotOrigin: 'self-heal' })
  } catch (e) {
    return { status: 'error', error: `重写稿落盘失败：${e instanceof Error ? e.message : String(e)}` }
  }
  loop.attempt++
  return { status: 'ok' }
}

// ── 终态出口（五路：pass / escalate×3 / 机检崩溃 failed / 中止 pause） ──

/** F5 审阅批：中止时 goal 落 pause（非终态——重跑同 id 重新 create 覆盖） */
function exitAborted(term: ChapterTerminal): ChapterRun {
  term.writeGoal('pause', 'paused')
  return { outcome: 'aborted' }
}

// R32-5：exitPass/exitEscalateBlocked 随 persistFinal 异步化改 async（调用点在 async 章循环内 return，无需改调用方）
async function exitPass(
  opts: SelfHealOpts,
  state: RunState,
  ctx: ChapterCtx,
  loop: HealLoop,
  term: ChapterTerminal,
  chapterNo: number,
): Promise<ChapterRun> {
  // R65-8（总六十五轮）：persistFinal 无守卫——抛错（磁盘满/库锁）则 writeTodos/writeGoal
  // 永不执行，事件链上 goal 永远 'active' 悬挂。失败仍走 writeGoal 终态
  //（block/blocked + blockedReason='persist-failed'）后再记失败出口（终稿未落盘，
  // 不得假报 pass）
  let final: { docId: string; relPath: string }
  try {
    final = await term.persistFinal()
  } catch (e) {
    term.writeGoal('block', 'blocked', { blockedReason: 'persist-failed', rounds: loop.attempt })
    return { chapter: loop.chapter, outcome: 'failed', error: `终稿落盘失败：${e instanceof Error ? e.message : String(e)}`, attempts: loop.attempt }
  }
  // X-P2-6：批量连写 pass 后同样生成账本推进草稿（与单章口径对称；此前批量整链旁路）。
  // 上一章未定稿确认的草稿由 generateLeadUpdateDraft 内部按章归档，finalize 按章号回收。
  // Z-P1-1：signal 透传——fire-and-forget 也随编排级中断中止（runSelfHeal 返回不等于其结束）；
  // M-2：登记进 per-book 后台表——waitSelfHealSettled 只等 runSelfHeal 本体收尾，
  // 此前该任务逃逸出删书/改名/退出的 settle 等待，落盘窗口撞上目录搬移会重建孤儿目录
  if (loop.hasWiring && !loop.leadDraftTried)
    registerBackgroundTask(opts.bookName, logLeadDraftFailure(generateLeadUpdateDraft(ctx.bookRoot, chapterNo, opts.userDataPath, state.ctrl.signal)))
  const yellows = ruleYellows(loop.current, ctx.bookRoot, chapterNo)
  term.writeTodos('completed', 'completed', 'completed')
  term.writeGoal('complete', 'complete', { rounds: loop.attempt })
  return { chapter: loop.chapter, outcome: 'pass', yellows, docId: final.docId, path: final.relPath, attempts: loop.attempt }
}

/** 有稿可交的统一出口（ok-escalate / 格式触顶 / 预算超限 / 重写失败四路同构） */
async function exitEscalateBlocked(term: ChapterTerminal, loop: HealLoop, reds: string[], blockedReason: string): Promise<ChapterRun> {
  // R65-8（总六十五轮）：同 exitPass——persistFinal 抛错仍落 goal 终态（block/blocked，
  // blockedReason='persist-failed'）后再记失败出口，防链上 'active' 悬挂
  let final: { docId: string; relPath: string }
  try {
    final = await term.persistFinal()
  } catch (e) {
    term.writeGoal('block', 'blocked', { blockedReason: 'persist-failed', rounds: loop.attempt })
    return { chapter: loop.chapter, outcome: 'failed', error: `终稿落盘失败：${e instanceof Error ? e.message : String(e)}`, attempts: loop.attempt }
  }
  term.writeTodos('completed', 'completed', 'in_progress')
  term.writeGoal('block', 'blocked', { blockedReason, rounds: loop.attempt })
  return { chapter: loop.chapter, outcome: 'escalate', reds, docId: final.docId, path: final.relPath, attempts: loop.attempt }
}

/** 机检崩溃出口：goal 落 block 附原因（todo 保持初始表：机检未完成——F5 审阅批口径） */
function exitCheckCrash(term: ChapterTerminal, loop: HealLoop, error: string): ChapterRun {
  term.writeGoal('block', 'blocked', { blockedReason: error, rounds: loop.attempt })
  return { chapter: loop.chapter, outcome: 'failed', error, attempts: loop.attempt }
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
  // ① 首稿（C-1 预算闸——超限不跑；GG-F1① 备料接线）
  const first = await draftFirstChapter(opts, state, ctx, chapter)
  if (first.status === 'aborted') return { outcome: 'aborted' }
  if (first.status !== 'ok') return { chapter, outcome: 'failed', error: first.error, attempts: 0 }

  const loop: HealLoop = {
    chapter,
    draftPath: first.draftPath,
    current: first.text,
    leadDraftTried: false,
    prevRedKey: null,
    attempt: 0,
    hasWiring: existsSync(join(ctx.bookRoot, '布线')),
  }
  const term = mkTerminal(opts, ctx, loop)
  term.writeTodos('completed', 'in_progress', 'pending')
  term.writeGoal('create', 'active')

  // ② 机检 → 红则重写 → 全绿或触顶
  for (;;) {
    if (state.ctrl.signal.aborted) return exitAborted(term)
    emit(opts, { type: 'self_heal_phase', phase: 'checking', attempt: loop.attempt })
    // R76-11（二十四轮 A 域）：机检抛异常（非返回 not-ok）收敛——ctx.check 原先裸调，
    // 内部未捕获的读盘/解析异常会原样上抛：goal 悬挂 active（writeGoal('create','active')
    // 已写、无 block 收口）、批量连写不落暂停记录（recordPause 只认 runChapter 的返回
    // 值形态，异常直接穿出 orchestrateBatch）。收敛到 exitCheckCrash 同款 failed 出口
    //（goal 落 block 附原因，批量侧按 failed 落暂停）。
    let outcome: ReturnType<typeof ctx.check>
    try {
      outcome = ctx.check(loop.draftPath)
    } catch (e) {
      return exitCheckCrash(term, loop, `机检异常（未归类）：${e instanceof Error ? e.message : String(e)}`)
    }
    // P2：机检报告事件化（红项结构化，自愈打回判据来源）
    ctx.chain?.add(
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
      // X-P1-2：账本侧红重写不可修——补生成账本推进草稿后复查一次
      if (await maybeLeadRedraft(opts, state, ctx, loop, outcome, chapterNo)) continue
      const st = evaluateRetry(outcome.report, loop.attempt, ctx.maxAttempts)
      recordRetryAttempt(ctx.chain, st, ctx.maxAttempts, loop.attempt)
      if (st.state === 'pass') return exitPass(opts, state, ctx, loop, term, chapterNo)
      // E-9g（第五十三轮）：redMessages(outcome) 原连算三次（escalate 两处 + reds 赋值），
      // 提取为单次计算复用——纯性能修，行为不变
      const redMsgs = redMessages(outcome)
      if (st.state === 'escalate') return exitEscalateBlocked(term, loop, redMsgs, redMsgs.join('；'))
      redIssues = st.redIssues
      reds = redMsgs
    } else {
      if (outcome.code !== 'NOT_CHAPTER') return exitCheckCrash(term, loop, outcome.error)
      reds = [`草稿格式不合规：${outcome.error}`]
      redIssues = reds
      if (loop.attempt >= ctx.maxAttempts) {
        return exitEscalateBlocked(term, loop, reds, reds.join('；'))
      }
    }

    // ③ 退回重写（预算超限 escalate 保留当前稿；重写失败 escalate 保留当前已落盘稿 F2）
    const again = await rewriteOnce(opts, state, ctx, loop, reds, redIssues, chapterNo)
    if (again.status === 'aborted') return exitAborted(term)
    if (again.status === 'budget') return exitEscalateBlocked(term, loop, [...reds, again.reason], [...reds, again.reason].join('；'))
    if (again.status !== 'ok') return exitEscalateBlocked(term, loop, [again.error], again.error)
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
  promptFiles: string[] = [], // C1（批 2）：prompt 引用材料 → promptMeta.files 登记
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

  // A2（五十九轮）：mock 快路撤销本地短路，改走下方 runSpec——runTask 的 mockTool 快路
  //（selfHealSpec 已声明 mock.toolName）与真实链路同口径补链路事件（step/start + llm/call
  //  + step/end，P3-6），mock 回合不再是审计黑洞。流式预览改由成功产出后补发（见
  //  emitMockPreview），前端观感口径不变（kk-P2 按码位切片）

  // 真实 provider + tool_use —— 走 runSpec（统一编排：mock/provider/中断/错误文案）
  const out = await runSpec(selfHealSpec(kind), {
    userDataPath: opts.userDataPath,
    bookRoot: opts.bookRoot,
    chapter,
    userPrompt,
    promptFiles,
    ctrl: state.ctrl,
    // Z-P2-5：登记 ctrl → driver（/auto-write 路径传入）——生成期 isRunning() 真值（SSE
    // sync 快照不再假空闲），/interrupt 的 driver.interrupt() 也能直接 abort 在途请求
    //（与 abortSelfHeal 内存闸双保险）。同 ctrl 多轮重复登记，cc 侧幂等跳过
    register: opts.register,
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
    // R35-17：abort/终态失败 attempt 的真实消耗已由 runner recordUsageSafe 按次入账
    // ai-calls，但 TaskErr 封套未携 attemptsUsage，done 事件取不到——纯展示面与账本
    // 口径分叉在此登记；对齐需 runner 失败封套补字段（另行立项）
    if (out.code === 'ABORTED' || state.ctrl.signal.aborted) return { status: 'aborted' }
    return { status: 'error', error: out.error }
  }
  if (state.ctrl.signal.aborted) return { status: 'aborted' }

  // 真实消耗入账（W-P2-7：done 事件不再恒 0；runSpec 已带回 usage）。
  // 金额按次现算累计（D2 同 stream.ts /spawn：写稿模型查价格表四档分计，未配价省略——
  // done 事件不再恒发 cost:0，前端成本口径与 spawn 路径一致）。
  // R73-10（二十一轮 A-10）：done 用量改取全 attempt 累计（attemptsUsage——重试/中断
  // attempt 的可得 usage 一并计入），与 ai-calls.json 按次入账口径一致；修复前只取
  // 末次成功 attempt，重试链的前置消耗在前端成本显示中缺失。runTask 未带该字段
  // （旧调用方/单测桩）时回退 out.usage（原口径）。含估计入账 attempt（R73-1）时
  // estimated 随之置位。
  const u = out.attemptsUsage ?? out.usage
  if (u) {
    state.usage.outputTokens += u.outputTokens
    if (u.estimated) state.usage.estimated = true
    // Y-15（第五十七轮）：计价用请求时刻的模型（TaskOk.model = resolve 时快照的 tier.model），
    // 不再二次 resolveTier 取当下档位——生成期间作者换档/改价时 done 事件与 ai-calls
    // 账本（runTask 同口径）计价漂移；mock 快路 model=null → 查价跳过（与 usage=null 同后果）
    const model = out.model
    const pricing = model ? resolveModelPricing(opts.userDataPath, model) : null
    if (pricing) {
      state.usage.cost += computeCallCost(pricing, {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
        ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
      }) ?? 0
    }
  }

  // C-2：记账已下沉到 runTask（chapter + task 块自动记，避免双记）

  // B-3：max_tokens 截断 → 警告（落盘保留，但让作者知道原因）
  const { input, text, stopReason } = out.data
  if (stopReason === 'max_tokens') {
    emit(opts, { type: 'warning', message: '产出达到长度上限被截断，建议调高单次输出上限' })
  }

  // tool_use 结构化产出 → 拼装 front matter + 正文
  const assembled = assembleChapter(input, chapter)
  if (assembled.ok) {
    // A2（五十九轮）：mock 快路（out.model === null）经 runTask 短路返回，onText 未流式——
    // 成功产出后按码位切片补发预览（与原本地 mock 快路口径一致），前端/测试能见推进
    if (out.model === null) emitMockPreview(opts, assembled.content)
    return { status: 'ok', text: assembled.content }
  }

  // 降级：tool_use 未命中（AI 产出自由文本）→ 直接用 text
  if (text.trim()) {
    if (out.model === null) emitMockPreview(opts, text.trim())
    return { status: 'ok', text: text.trim() }
  }
  return { status: 'error', error: 'AI 产出为空' }
}

/** A2（五十九轮）：mock 快路的流式预览补发——12 码位/段逐段 emit。
 *  kk-P2：按码位切片（Array.from）——String.slice 按 UTF-16 code unit 会把 emoji/
 *  扩展区字符劈成两半，前端逐字渲染出现瞬时不合法字符（turns.ts read_chapter 同做法） */
function emitMockPreview(opts: SelfHealOpts, body: string): void {
  const chars = Array.from(body)
  for (let i = 0; i < chars.length; i += 12) {
    emit(opts, { type: 'text', text: chars.slice(i, i + 12).join('') })
  }
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
    // 未配价（cost 恒 0）省略字段——与 spawn 路径同口径，不再恒发 cost:0
    ...(usage.cost > 0 ? { cost: usage.cost } : {}),
    // W-P2-7：真实 outputTokens 累计（与 stream.ts 口径一致），不再恒 0
    // R73-10：usage 为全 attempt 累计口径（runGenerate 取 attemptsUsage）；含估计入账
    // 时带 usageEstimated（R73-1 协同，前端可区分实测/估计）
    usage: usage.outputTokens,
    ...(usage.estimated ? { usageEstimated: true } : {}),
    reason: result.outcome === 'aborted' ? 'cancelled' : result.outcome === 'failed' ? 'error' : 'success',
  })
}
