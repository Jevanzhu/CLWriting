/**
 * 对话助手 agent 编排器（方案 §3.4）。
 *
 * 与 self-heal 平级的新编排——不是一套新管线。
 * agent 循环：AI 自主决策调工具（≤5 轮 / ≤30min），写操作需作者确认。
 *
 * 架构要点（照搬 self-heal 的并发锁 + 中断模式）：
 * - per-book `Map<ChatRunState>` 并发锁
 * - 编排级 `AbortController` 贯穿循环 + 总时长 deadline
 * - 工具确认用 `pending Map<callId, resolve>` + 超时兜底
 * - 失败回滚 `history.length = baseLen`（不是 pop()）
 * - `runTask` 传 `task:'chat'` + `bookRoot` → trace/记账自动覆盖
 * - 持 CHAT_SPEC 元数据直调 runTask（不走 runSpec，messages 是累积数组）
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DriverEvent, Session, StudioDriver } from '../../driver/types.js'
import type { ChatMsg, ContentBlock, TokenUsage } from '../provider/types.js'
import { generate } from '../gen.js'
import { runTask } from '../runner.js'
import { chatTools, TOOL_RISK } from '../contract/chat.js'
// 工具面扩展：注册表分派（book_search/chapter_status/树操作/改写/账本/文风）
import { TOOL_EXECUTORS, type ToolContext } from '../tools/index.js'
import { chatSystem, buildChatContext, trimHistory, sanitizeHistory } from '../prompts/chat.js'
import { compactHistory } from '../prompts/compaction.js'
import { buildCheckpointInstruction, clampCheckpointOutputTokens } from '../prompts/checkpoint.js'
import { isSelfHealRunning, runSelfHeal, abortSelfHeal, type SelfHealOutcome } from './self-heal.js'
import { runCheckForDocument, type CheckOutcome } from '../../check/run.js'
import { resolveDraftPath } from '../../format/draft.js'
// DSH-18：写作技巧包按需加载（read_skill 工具的执行通道）
import { listSkills, loadSkill } from '../../process/skills.js'
// F1-P1：事件溯源——历史持久化 + 跨重启恢复 + 压缩走遮蔽
import { openSessionStore } from '../../events/store.js'
import { loadHistoryWithSeqs, SessionRecorder, sessionStartEvent, turnStartEvent, turnEndEvent, userMessageEvent, assistantMessageEvent, toolCallEvent, toolResultEvent } from '../../events/chat-bridge.js'

// ── 常量 ──────────────────────────────────────────

const MAX_AGENT_TURNS = 5
const AGENT_DEADLINE_MS = 30 * 60_000
const CONFIRM_TIMEOUT_MS = 2 * 60_000
const MAX_HISTORY_TURNS = 10

// ── 类型 ──────────────────────────────────────────

export interface ChatOpts {
  driver: StudioDriver
  mainSession: Session
  userDataPath: string
  bookRoot: string
  bookName: string
  /** 作者发送的消息 */
  message: string
  /** 作者选定讨论的章号（可选） */
  chapter?: number
  /** 确认闸超时注入（单测用短超时） */
  confirmTimeoutMs?: number
}

interface ChatRunState {
  ctrl: AbortController
  deadline: number
  /** 挂起中的工具确认：callId → resolve */
  pending: Map<string, (ok: boolean) => void>
}

// ── 并发锁 + 中断 + 确认 ──────────────────────────

const running = new Map<string, ChatRunState>()

/** 本书是否正在对话 */
export function isChatRunning(bookName: string): boolean {
  return running.has(bookName)
}

/** E1a（steer / B5 Inbox 合流）：per-book 待处理消息队列。
 * 对话运行中发来的消息入队（steer「入队让出」语义），当前轮正常完成后自动消费队头续链；
 * abort/error/超时则丢弃队列（cherry steer 四分支：aborted/error → 丢弃，持久化 user 行留历史可重发）。 */
interface PendingChatMsg {
  message: string
  chapter?: number
}
const pendingChats = new Map<string, PendingChatMsg[]>()

/** 中断本书的对话——abort + 放行挂起的确认 + 丢弃待处理队列（用户停止 = 后续指令一并作废） */
export function abortChat(bookName: string): boolean {
  const st = running.get(bookName)
  if (!st) return false
  for (const [, resolve] of st.pending) resolve(false)
  pendingChats.delete(bookName)
  st.ctrl.abort()
  return true
}

/** E1a：对话消息统一入口——无运行直接启动；运行中入队（当前轮结束自动续链）。
 * 返回 'started'（直接开跑）| 'queued'（已入队）。错误兜底 emit driver error（与 stream.ts 原 emitSpawnError 对齐）。 */
export function sendChatMessage(opts: ChatOpts): 'started' | 'queued' {
  if (running.has(opts.bookName)) {
    const q = pendingChats.get(opts.bookName) ?? []
    q.push({ message: opts.message, chapter: opts.chapter })
    pendingChats.set(opts.bookName, q)
    return 'queued'
  }
  void runChat(opts).catch((e) => {
    opts.driver.emit?.(opts.mainSession, {
      type: 'error',
      kind: 'chat',
      message: e instanceof Error ? e.message : String(e),
      recoverable: false,
    })
  })
  return 'started'
}

/** E1a：runChat 收尾续链——正常完成消费队头自动跑下一条；abort/error/超时丢弃队列。 */
function drainNextChat(base: ChatOpts, completedOk: boolean): void {
  const q = pendingChats.get(base.bookName)
  if (!q || q.length === 0) {
    pendingChats.delete(base.bookName)
    return
  }
  if (!completedOk) {
    pendingChats.delete(base.bookName)
    return
  }
  const next = q.shift()!
  if (q.length === 0) pendingChats.delete(base.bookName)
  void runChat({
    ...base,
    message: next.message,
    ...(next.chapter !== undefined ? { chapter: next.chapter } : {}),
  }).catch((e) => {
    base.driver.emit?.(base.mainSession, {
      type: 'error',
      kind: 'chat',
      message: e instanceof Error ? e.message : String(e),
      recoverable: false,
    })
  })
}

/** 作者点了确认/取消（由 POST /chat/confirm 调用） */
export function resolveChatConfirm(bookName: string, callId: string, ok: boolean): boolean {
  const st = running.get(bookName)
  const resolve = st?.pending.get(callId)
  if (!resolve) return false
  st!.pending.delete(callId)
  resolve(ok)
  return true
}

// ── 内存级对话历史（per-book，LRU 上限防多书累积） ────

const histories = new Map<string, ChatMsg[]>()
// F1-P1：与 histories 并行维护「每条消息 → 事件 seq」映射（压缩遮蔽用，跨 runChat 持久）
const msgSeqMap = new Map<string, number[][]>()
const MAX_HISTORY_BOOKS = 8

/** 取（或建）本书对话历史——命中重插（真 LRU，X-P2-24）。导出供测试验证逐出语义。 */
export function getHistory(bookName: string): ChatMsg[] {
  // X-P2-24：命中重插实现真 LRU——Map 按插入序淘汰，get 不重插的话
  // 热点书历史会被只碰过一次的冷书逐出
  const hit = histories.get(bookName)
  if (hit) {
    histories.delete(bookName)
    histories.set(bookName, hit)
    return hit
  }
  if (histories.size >= MAX_HISTORY_BOOKS) {
    // 删最旧（Map 保留插入顺序）
    const oldest = histories.keys().next().value
    if (oldest !== undefined) {
      histories.delete(oldest)
      msgSeqMap.delete(oldest)
    }
  }
  const fresh: ChatMsg[] = []
  histories.set(bookName, fresh)
  return fresh
}

/**
 * 清空本书对话历史（前端"清空对话"时调）。
 * F1-P1：可选传 userDataPath + bookRoot 一并清事件库（无参时只清内存，保持测试兼容）。
 */
export function clearChatHistory(bookName: string, userDataPath?: string, bookRoot?: string): void {
  histories.delete(bookName)
  msgSeqMap.delete(bookName)
  if (userDataPath && bookRoot) {
    openSessionStore(userDataPath, bookRoot)?.clearBook(bookName)
  }
}

// ── 等确认 ────────────────────────────────────────

function waitConfirm(state: ChatRunState, callId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { state.pending.delete(callId); resolve(false) }, timeoutMs)
    state.pending.set(callId, (ok) => { clearTimeout(timer); resolve(ok) })
  })
}

// ── emit 辅助 ─────────────────────────────────────

function emit(opts: ChatOpts, ev: DriverEvent): void {
  opts.driver.emit?.(opts.mainSession, ev)
}

// ── 工具执行 ──────────────────────────────────────

async function executeChatTool(
  call: { id: string; name: string; input: unknown },
  opts: ChatOpts,
  ctrl: AbortSignal,
): Promise<{ ok: boolean; summary: string }> {
  const input = call.input as Record<string, unknown>
  try {
    // 工具面扩展：注册表分派（read_chapter/read_skill 等既有分支不走注册表）
    const executor = TOOL_EXECUTORS[call.name]
    if (executor) {
      const tctx: ToolContext = {
        bookRoot: opts.bookRoot,
        bookName: opts.bookName,
        userDataPath: opts.userDataPath ?? null,
      }
      return await executor(tctx, input)
    }
    switch (call.name) {
      case 'write_chapter': {
        if (isSelfHealRunning(opts.bookName)) {
          return { ok: false, summary: '本书正在全自动写章，无法同时再起一轮。' }
        }
        const chapter = Number(input['chapter'])
        if (!Number.isInteger(chapter) || chapter < 1) {
          return { ok: false, summary: '章号需为正整数。' }
        }
        // chat 中断时同步中断 self-heal（abortChat 只 abort chat ctrl，self-heal 独立 ctrl 须显式桥接）
        const onAbort = (): void => { abortSelfHeal(opts.bookName) }
        ctrl.addEventListener('abort', onAbort)
        try {
          const r: SelfHealOutcome = await runSelfHeal({
            driver: opts.driver,
            mainSession: opts.mainSession,
            userDataPath: opts.userDataPath,
            cwd: opts.bookRoot,
            bookRoot: opts.bookRoot,
            bookName: opts.bookName,
            chapter,
          })
          return {
            // B-P1-6：escalate 时章已生成落盘，不应标记 isError（ok=false 会让 AI 误判失败重复写章）
            ok: r.outcome === 'pass' || r.outcome === 'escalate',
            summary: formatHealResult(r),
          }
        } finally {
          ctrl.removeEventListener('abort', onAbort)
        }
      }
      case 'check_chapter': {
        // X-P2-12：AI 常省略 chapter 入参——回落到作者选定章（均缺才报错；此前 NaN 直接被拒）
        const chapter = Number(input['chapter'] ?? opts.chapter)
        if (!Number.isInteger(chapter) || chapter < 1) {
          return { ok: false, summary: '章号需为正整数。' }
        }
        const draftRel = resolveDraftPath(opts.bookRoot, chapter).relPath
        const draftPath = join(opts.bookRoot, draftRel)
        if (!existsSync(draftPath)) {
          return { ok: false, summary: `第${chapter}章草稿不存在。` }
        }
        const outcome = runCheckForDocument(opts.bookRoot, draftPath)
        return formatCheckResult(outcome)
      }
      case 'read_chapter': {
        // B3 spill 取回通道：读完整正文回填（上下文里被外置省略的全文由此取回）。
        // 章号回落与 check_chapter 同口径（X-P2-12）；结果不再二次 spill（防 read→spill→read 环）
        const chapter = Number(input['chapter'] ?? opts.chapter)
        if (!Number.isInteger(chapter) || chapter < 1) {
          return { ok: false, summary: '章号需为正整数。' }
        }
        const draftRel = resolveDraftPath(opts.bookRoot, chapter).relPath
        const draftPath = join(opts.bookRoot, draftRel)
        if (!existsSync(draftPath)) {
          return { ok: false, summary: `第${chapter}章草稿不存在。` }
        }
        const raw = readFileSync(draftPath, 'utf-8')
        const body = raw.replace(/^---[\s\S]*?---\n?/, '')
        if (!body.trim()) return { ok: false, summary: `第${chapter}章正文为空。` }
        return { ok: true, summary: body }
      }
      case 'read_skill': {
        // DSH-18 按需加载通道：system prompt 索引只给元信息，正文用时才取
        //（三根 rank 覆盖序与 listSkills 一致：项目 > 用户 > 捆绑）
        const skill = loadSkill(String(input['name'] ?? ''), {
          bookRoot: opts.bookRoot,
          userDataPath: opts.userDataPath,
        })
        if (!skill) {
          const names = listSkills({ bookRoot: opts.bookRoot, userDataPath: opts.userDataPath })
            .map((m) => m.name)
            .join('、')
          return { ok: false, summary: `未找到该技巧包。可用：${names}` }
        }
        return { ok: true, summary: skill.content }
      }
      default:
        return { ok: false, summary: `未知工具：${call.name}` }
    }
  } catch (e) {
    return { ok: false, summary: `执行失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

function formatHealResult(r: SelfHealOutcome): string {
  switch (r.outcome) {
    case 'pass':
      // B-P1-2：用 r.chapter（章号）而非 r.docId（稳定 ID，如 legacy:9f8e7d6c）
      return r.yellows && r.yellows.length > 0
        ? `第${r.chapter}章已生成，机检全绿。仍有 ${r.yellows.length} 条文风建议未采纳。`
        : `第${r.chapter}章已生成，机检全绿。`
    case 'escalate':
      return `第${r.chapter}章已生成但有 ${r.reds.length} 个红项未能自动修复，需要手动处理。`
    case 'aborted':
      return '写章已中断。'
    case 'failed':
      return `写章失败：${r.error}`
  }
}

function formatCheckResult(outcome: CheckOutcome): { ok: boolean; summary: string } {
  if (!outcome.ok) {
    return { ok: false, summary: outcome.error }
  }
  if (!outcome.hasRed) {
    return { ok: true, summary: '机检全绿，无红项。' }
  }
  // 提取所有红项/黄项
  const items = outcome.report.sections.flatMap((s) => s.items)
  const reds = items.filter((i) => i.level === 'red')
  const yellows = items.filter((i) => i.level === 'yellow')
  const parts: string[] = []
  if (reds.length) parts.push(`${reds.length} 个红项`)
  if (yellows.length) parts.push(`${yellows.length} 个黄项`)
  const detail = items.slice(0, 5).map((i) => `- [${i.level}] ${i.message}`).join('\n')
  return {
    ok: reds.length === 0,
    summary: parts.length ? `${parts.join('，')}：\n${detail}` : '机检通过',
  }
}

// ── 主循环 ────────────────────────────────────────

// B2：压缩失败一次的书 → 下次溢出直接硬截断（防「每次溢出白打一次摘要」级联，学 cherry E10 抑制）
const compactionSuppressed = new Set<string>()

/**
 * checkpoint 摘要调用（B2，KV-cache 友好形态）：同一 system + tools + 待压前缀原样重放，
 * 末尾追加一条 user 指令——摘要调用成为刚结束对话的真前缀延伸。
 * fail-closed：max_tokens 收尾（截断摘要）/ 意外工具调用 / 空文本 / 调用失败 → null。
 */
async function summarizeCheckpoint(
  opts: ChatOpts,
  sys: string,
  state: ChatRunState,
  toSummarize: ChatMsg[],
  priorSummary: string | null,
): Promise<string | null> {
  const sanitized = sanitizeHistory(toSummarize)
  if (sanitized.length === 0) return null
  const instruction = buildCheckpointInstruction(priorSummary ?? undefined)
  const out = await runTask<string | null>({
    userDataPath: opts.userDataPath,
    tierKind: 'chat',
    task: 'chat',
    bookRoot: opts.bookRoot,
    systemPrompt: sys,
    promptText: instruction,
    ctrl: state.ctrl,
    register: (c) => opts.driver.registerCtrl?.(opts.mainSession, c),
    onReset: () => emit(opts, { type: 'chat_reset' }),
    onRetry: (attempt, error) =>
      emit(opts, { type: 'warning', message: `历史压缩摘要生成异常（${error}），第 ${attempt + 1} 次重试中…` }),
    run: async (provider, signal, tier) => {
      const r = await generate(
        provider,
        {
          systemPrompt: sys,
          messages: [...sanitized, { role: 'user', content: instruction }],
          tools: chatTools,
          maxTokens: clampCheckpointOutputTokens(),
          effort: tier.effort,
        },
        signal,
      )
      if (r.stopReason === 'max_tokens' || r.toolCalls.length > 0) return null
      const t = r.text.trim()
      return t === '' ? null : t
    },
  })
  return out.ok ? out.data : null
}

/**
 * 对话收尾的历史窗口处理（B1+B2 升级 F1-P1 的 trim 遮蔽点）：
 * 溢出时优先 checkpoint 压缩（信息保留 + seq 遮蔽语义不变），失败回落现行硬截断。
 * 空摘要 fail-open：保留原历史、不插占位符（B2 纪律），本次不遮蔽。
 */
async function finalizeHistory(
  opts: ChatOpts,
  history: ChatMsg[],
  msgSeqs: number[][],
  recorder: SessionRecorder,
  sys: string,
  state: ChatRunState,
): Promise<void> {
  // 硬截断兜底（= F1-P1 原行为）：trim 掉的旧消息 seq 区间 replace 遮蔽（人类抄本 append 全量保留）
  const trimAndClose = (): void => {
    const trimmed = trimHistory(history, MAX_HISTORY_TURNS)
    const cut = history.length - trimmed.length
    const shadowSeqs = msgSeqs.splice(0, cut).flat()
    msgSeqMap.set(opts.bookName, msgSeqs)
    histories.set(opts.bookName, trimmed)
    recorder.close('completed', shadowSeqs)
  }

  // suppress 短路在摘要尝试之前——失败过的书不再白打一次摘要调用（E10 抑制的本意）
  if (compactionSuppressed.has(opts.bookName)) {
    compactionSuppressed.delete(opts.bookName)
    trimAndClose()
    return
  }

  const outcome = await compactHistory(history, { keepTurns: MAX_HISTORY_TURNS }, (toSum, prior) =>
    summarizeCheckpoint(opts, sys, state, toSum, prior),
  )
  if (outcome.summarizedCount > 0) {
    const shadowSeqs = msgSeqs.splice(0, outcome.summarizedCount).flat()
    // 压缩存档消息无事件 seq（replace 遮蔽事件已表达「被压内容 → 存档」的来源关系）；
    // 跨重启恢复暂只回放未遮蔽节点（存档入事件流属 F1-P2/P3 事件族收敛）
    msgSeqs.unshift([])
    msgSeqMap.set(opts.bookName, msgSeqs)
    histories.set(opts.bookName, outcome.history)
    recorder.close('completed', shadowSeqs)
    return
  }
  msgSeqMap.set(opts.bookName, msgSeqs)
  // no-op 或摘要失败（fail-open 保留原历史，不遮蔽）；失败 → 置 suppress，下次溢出硬截断
  if (outcome.overflow) compactionSuppressed.add(opts.bookName)
  recorder.close('completed')
}

export async function runChat(opts: ChatOpts): Promise<void> {
  const state: ChatRunState = {
    ctrl: new AbortController(),
    deadline: Date.now() + AGENT_DEADLINE_MS,
    pending: new Map(),
  }
  running.set(opts.bookName, state)
  // E1a：正常完成（emit chat_done）才续链；abort/error/超时丢弃队列
  let completedOk = false
  const confirmTimeout = opts.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS
  // F1-P1：事件库（userData 为空 → null，退化内存模式）；finally 关闭连接
  const store = openSessionStore(opts.userDataPath, opts.bookRoot)

  try {
    const history = getHistory(opts.bookName)
    // F1-P1：事件库（userData 为空 → null，退化内存模式）+ 跨重启恢复。
    // 内存无历史且库有投影 → 恢复（LRU 逐出/重启后都走这条）。
    let msgSeqs = msgSeqMap.get(opts.bookName) ?? []
    let pendingMsgSeqs: Array<number | number[]> = []
    if (store && history.length === 0) {
      const restored = loadHistoryWithSeqs(store.listEvents(opts.bookName))
      if (restored.msgs.length > 0) {
        history.push(...restored.msgs)
        msgSeqs = restored.seqsPerMsg
        msgSeqMap.set(opts.bookName, msgSeqs)
      }
    }
    // 防御：msgSeqs 与 history 长度不一致（旧进程残留）→ 重置，宁可遮蔽不精准也不误遮蔽
    if (msgSeqs.length !== history.length) msgSeqs = []
    const sessionId = store ? store.createSession(opts.bookName, { book: opts.bookName }) : 'mem'
    const recorder = new SessionRecorder(store, sessionId)
    recorder.add(sessionStartEvent(opts.bookName))
    const baseLen = history.length
    const ctx = buildChatContext(opts.bookRoot, opts.chapter, { userDataPath: opts.userDataPath })
    const sys = chatSystem(ctx)
    // #3b 根修：push 必须在 buildChatContext 之后——buildChatContext 读文件可能耗时，
    // 期间若作者发起新对话（并发），旧历史 push 会与新消息错位（交替 user 被打乱）。
    // 先读文件后 push，保证 history 修改点紧邻 generate，window 最小。
    history.push({ role: 'user', content: opts.message })
    pendingMsgSeqs.push(recorder.add(userMessageEvent(opts.message, opts.chapter)))

    emit(opts, { type: 'chat_start' })
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      if (state.ctrl.signal.aborted) {
        // P1-S4：回滚历史（防末尾 user → 下次连续 user → Anthropic 400，与 max_tokens 路径 :295 一致）
        history.length = baseLen
        // F1-P1：本会话已落库事件遮蔽（防下次恢复出已回滚的废数据）
        recorder.close('interrupted', recorder.allSessionSeqs())
        return void emit(opts, { type: 'chat_error', error: '已中断' })
      }
      if (Date.now() > state.deadline) {
        history.length = baseLen
        recorder.close('aborted', recorder.allSessionSeqs())
        return void emit(opts, { type: 'chat_error', error: '对话超时（超过 30 分钟），已停止' })
      }

      recorder.add(turnStartEvent(turn))
      emit(opts, { type: 'chat_turn', turn })

      const out = await runTask<{
        text: string
        toolCalls: { id: string; name: string; input: unknown }[]
        stopReason: string
        usage: TokenUsage
        reasoning: string
      }>({
        userDataPath: opts.userDataPath,
        tierKind: 'chat',
        task: 'chat',
        bookRoot: opts.bookRoot,
        // B-P2-2：trace hash 纳入 system prompt——chat 的 system prompt 稳定（设定+职责），
        // 不带则同 user 消息不同书 hash 冲突
        systemPrompt: sys,
        promptText: opts.message,
        ctrl: state.ctrl,
        register: (c) => opts.driver.registerCtrl?.(opts.mainSession, c),
        onReset: () => emit(opts, { type: 'chat_reset' }),
        // P1-R3：provider 429/5xx 重试时推 warning（与 self-heal.ts:496 对齐，Bug C 同类补齐）
        onRetry: (attempt, error) =>
          emit(opts, { type: 'warning', message: `AI 响应异常（${error}），第 ${attempt + 1} 次重试中…` }),
        run: async (provider, signal, tier) => {
          // 发送前历史消毒（§6.4 第二道防线）：多轮 tool 往返/中断回滚后历史可能
          // 出现非法序列（空 content / 连续同 role / 孤儿 tool_result / 首条非 user）→ 400。
          // 消毒产副本，不污染累积的 history（回滚仍按 baseLen 精确）。
          const sanitized = sanitizeHistory(history)
          const r = await generate(
            provider,
            {
              systemPrompt: sys,
              messages: sanitized,
              tools: chatTools,
              toolChoice: 'auto',
              effort: tier.effort,
            },
            signal,
            (delta) => emit(opts, { type: 'chat_text', text: delta }),
          )
          return { text: r.text, toolCalls: r.toolCalls, stopReason: r.stopReason, usage: r.usage, reasoning: r.reasoning }
        },
      })

      if (!out.ok) {
        history.length = baseLen
        recorder.close('failed', recorder.allSessionSeqs())
        return void emit(opts, { type: 'chat_error', error: out.error })
      }

      const { text, toolCalls, stopReason, reasoning } = out.data

      // max_tokens → 工具入参可能被截断，绝不执行；半截文本不入 history（K12）
      if (stopReason === 'max_tokens') {
        // P1-R1a：回滚 user 消息（与 !out.ok 路径一致），防下次对话连续 user → Anthropic 400
        history.length = baseLen
        recorder.close('failed', recorder.allSessionSeqs())
        return void emit(opts, { type: 'chat_error', error: '回复达到长度上限被截断，请缩小问题范围重试' })
      }

      // 无工具调用 → 对话结束
      if (toolCalls.length === 0) {
        // P2-AI-1：reasoning 非空时入历史（与工具路径 :311-320 一致——DeepSeek/Kimi 多轮带 tools 硬要求）
        let asstContent: string | ContentBlock[]
        if (reasoning) {
          const blocks: ContentBlock[] = []
          if (text) blocks.push({ type: 'text', text })
          blocks.push({ type: 'reasoning', text: reasoning })
          asstContent = blocks
        } else {
          asstContent = text
        }
        history.push({ role: 'assistant', content: asstContent })
        // F1-P1：记录 assistant 事件 + 回合收尾 + 落库
        pendingMsgSeqs.push(recorder.add(assistantMessageEvent(asstContent, out.usage ?? undefined, stopReason)))
        recorder.add(turnEndEvent(turn, 'completed'))
        const range = recorder.flush()
        if (range) {
          for (const idx of pendingMsgSeqs) {
            msgSeqs.push(typeof idx === 'number' ? [range.first + idx] : idx.map((i) => range.first + i))
          }
          pendingMsgSeqs = []
        }
        emit(opts, {
          type: 'chat_done',
          ...(out.usage ? { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens } : {}),
        })
        completedOk = true
        // B1+B2：溢出 → checkpoint 压缩优先（chat_done 先发，不被摘要调用拖住）
        await finalizeHistory(opts, history, msgSeqs, recorder, sys, state)
        return
      }

      // 有工具调用 → assistant 消息按 block 结构入历史
      // reasoning 块保留回传（DeepSeek/Kimi 多轮带 tools 硬要求，方案 §4.2）
      const asstBlocks: ContentBlock[] = []
      if (text) asstBlocks.push({ type: 'text', text })
      if (reasoning) asstBlocks.push({ type: 'reasoning', text: reasoning })
      for (const c of toolCalls) {
        asstBlocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
      }
      history.push({ role: 'assistant', content: asstBlocks })
      // F1-P1：assistant 事件（tool_use 在载荷里）+ tool/call 审计事件
      pendingMsgSeqs.push(recorder.add(assistantMessageEvent(asstBlocks, out.usage ?? undefined, stopReason)))
      for (const c of toolCalls) recorder.add(toolCallEvent(c.id, c.name, c.input))

      // 执行工具 + 结果按 tool_result block 回填
      const results: ContentBlock[] = []
      for (const call of toolCalls) {
        const risk = TOOL_RISK[call.name] ?? 'write'
        if (risk === 'write') {
          emit(opts, { type: 'chat_tool_pending', callId: call.id, name: call.name, input: call.input })
          const ok = await waitConfirm(state, call.id, confirmTimeout)
          if (!ok) {
            results.push({ type: 'tool_result', toolUseId: call.id, content: '作者取消了该操作。', isError: true })
            emit(opts, { type: 'chat_tool_result', callId: call.id, summary: '已取消', ok: false })
            continue
          }
        }
        emit(opts, { type: 'chat_tool', callId: call.id, name: call.name, input: call.input })
        const r = await executeChatTool(call, opts, state.ctrl.signal)
        results.push({ type: 'tool_result', toolUseId: call.id, content: r.summary, isError: !r.ok })
        emit(opts, { type: 'chat_tool_result', callId: call.id, summary: r.summary, ok: r.ok })
      }
      history.push({ role: 'user', content: results })
      // F1-P1：tool/result 事件（每条 tool_result block 一个事件，合成一条 user 消息的 seqs）
      const resultIdxs: number[] = []
      for (const rb of results) {
        if (rb.type === 'tool_result') {
          resultIdxs.push(recorder.add(toolResultEvent(rb.toolUseId, rb.content, rb.isError)))
        }
      }
      pendingMsgSeqs.push(resultIdxs)
      recorder.add(turnEndEvent(turn, 'completed'))
      const range2 = recorder.flush()
      if (range2) {
        for (const idx of pendingMsgSeqs) {
          msgSeqs.push(typeof idx === 'number' ? [range2.first + idx] : idx.map((i) => range2.first + i))
        }
        pendingMsgSeqs = []
      }
    }

    // 轮数触顶——补固定收尾文案
    emit(opts, { type: 'chat_turn', turn: MAX_AGENT_TURNS })
    const closingMsg = '已达到单次对话的工具调用上限，先到这里——你可以基于以上结果继续提问。'
    emit(opts, { type: 'chat_text', text: closingMsg })
    // P1-R1b：收尾文案入历史（防末尾 user(tool_result) + 下次 user → 连续 user → Anthropic 400）
    history.push({ role: 'assistant', content: closingMsg })
    // F1-P1：事件记录 + 落库 + trim 遮蔽（与无工具完成路径一致）
    pendingMsgSeqs.push(recorder.add(assistantMessageEvent(closingMsg)))
    recorder.add(turnEndEvent(MAX_AGENT_TURNS - 1, 'max-turns'))
    const range3 = recorder.flush()
    if (range3) {
      for (const idx of pendingMsgSeqs) {
        msgSeqs.push(typeof idx === 'number' ? [range3.first + idx] : idx.map((i) => range3.first + i))
      }
      pendingMsgSeqs = []
    }
    emit(opts, { type: 'chat_done' })
    completedOk = true
    // B1+B2：溢出 → checkpoint 压缩优先（同无工具完成路径）
    await finalizeHistory(opts, history, msgSeqs, recorder, sys, state)
  } finally {
    running.delete(opts.bookName)
    // E1a：steer 续链——正常完成自动消费队头；abort/error/超时丢弃队列
    drainNextChat(opts, completedOk)
    // F1-P1：关闭事件库连接（防 FD 泄漏；WAL 多连接虽不锁，但连接需释放）
    store?.close()
    // X-P2-11：对话终态注销 ctrl——isRunning 归 false（此前 chat_done 后仍登记，SSE 快照假报「生成中」）
    opts.driver.unregisterCtrl?.(opts.mainSession, state.ctrl)
  }
}
