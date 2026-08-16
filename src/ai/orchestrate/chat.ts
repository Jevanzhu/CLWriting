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
import { openSessionStore, bookHash } from '../../events/store.js'
import { selectBranch, selectBranchTo } from '../../events/branch-tree.js'
import { loadHistoryWithSeqs, SessionRecorder, sessionStartEvent, turnStartEvent, turnEndEvent, userMessageEvent, assistantMessageEvent, toolCallEvent, toolResultEvent } from '../../events/chat-bridge.js'
import { settingsSnapshotEvent, revisionRefEvent, skillsSnapshotEvent } from '../../events/chain-bridge.js'
import { digest16 } from '../../events/lineage.js'

// ── 常量 ──────────────────────────────────────────

const MAX_AGENT_TURNS = 5
const AGENT_DEADLINE_MS = 30 * 60_000
const CONFIRM_TIMEOUT_MS = 2 * 60_000
const MAX_HISTORY_TURNS = 10
/** RB-AI-P2-5：read_chapter 单次返回上限（code points，与 chat 入口消息上限 5 万字符
 *  同量级的安全上限）——数万字整章无上限灌 tool_result 可撑爆上下文 */
const READ_CHAPTER_MAX_CHARS = 20_000
const READ_CHAPTER_HEAD_CHARS = 12_000
const READ_CHAPTER_TAIL_CHARS = 6_000

// ── 类型 ──────────────────────────────────────────

export interface ChatOpts {
  driver: StudioDriver
  mainSession: Session
  userDataPath: string
  bookRoot: string
  bookName: string
  /** 作者发送的消息（regenerate 时不填——复用已有 user 消息） */
  message?: string
  /** 作者选定讨论的章号（可选） */
  chapter?: number
  /** F1-P4：重新生成——parentSeq = 触发 user 的全局 seq，branchId = 变体组 */
  regenerate?: { parentSeq: number; branchId: string }
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
  /** RB-AI-P2-1：逐条语义字段各自独立——排队时完整保留 message/regenerate/chapter，
   *  续链时不得从上一轮继承（base 含 regenerate 时续链曾走恢复分支吞掉排队新消息） */
  message?: string
  chapter?: number
  regenerate?: { parentSeq: number; branchId: string }
}
const pendingChats = new Map<string, PendingChatMsg[]>()
/** P3-4：每书待处理队列容量上限——失控客户端/脚本循环发消息不能无限撑内存；超出丢最旧 */
const MAX_PENDING_CHATS = 10

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
    // P3-4：超容丢最旧（队列是「让出」语义，作者最新指令优先级高于陈旧排队消息）
    // AA-P3-1：丢弃必须可感知——API 已回 queued，若静默丢最旧，作者会以为所有消息都在排队
    if (q.length >= MAX_PENDING_CHATS) {
      const dropped = q.shift()!
      // RB-AI-P2-1：regenerate 项无 message，预览降级显示「(重新生成)」而非误报空消息
      const preview = (dropped.message || (dropped.regenerate ? '(重新生成)' : '(空消息)')).slice(0, 40)
      emit(opts, {
        type: 'notice',
        message: `对话队列已满：已丢弃最旧的排队消息「${preview}…」——你刚发送的这条会顶替它。`,
      })
    }
    // RB-AI-P2-1：排队项完整保留语义字段（此前只存 message/chapter——运行中发起的
    // regenerate 被降级为空 message 入队）
    q.push({ message: opts.message, chapter: opts.chapter, regenerate: opts.regenerate })
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
  // RB-AI-P2-1：环境字段（driver/session/userData/book 等来自 base）与逐条字段
  // （message/regenerate/chapter 来自队列项）分开组装——此前 {...base, message} 续链：
  // base 含 regenerate 时排队新消息走「恢复旧历史」分支被静默吞掉；next.chapter 缺省时
  // 误继承上一条的选定章。逐条字段一律以队列项为准（undefined 也覆盖，不继承）
  void runChat({
    ...base,
    message: next.message,
    chapter: next.chapter,
    regenerate: next.regenerate,
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
// Z-P1-2（G1 写侧谱系）：本书活跃分支 = 最近一次成功 regenerate 的 branchId——
// 其后的普通回合事件带该 branchId 进组（续聊归属明确，不摊给所有变体视图）；
// 仅成功回合激活（失败/中断的半截组已被遮蔽，激活会把续聊归因到幽灵组）；
// 与 histories 同生命周期：LRU 逐出 / clearChatHistory 一并重置
const activeBranchByBook = new Map<string, string>()
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
      activeBranchByBook.delete(oldest)
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
  activeBranchByBook.delete(bookName)
  if (userDataPath && bookRoot) {
    // Y-P2-7：两把钥匙都清——对话会话 book=bookName、workspace 会话 book=bookHash(bookRoot)，
    // 此前只清前者，链路事件（step/llm/check）残留
    const store = openSessionStore(userDataPath, bookRoot)
    try {
      store?.clearBook(bookName)
      store?.clearBook(bookHash(bookRoot))
    } finally {
      store?.close()
    }
  }
}

// ── 等确认 ────────────────────────────────────────

/** 等作者确认（导出供单测验证 abort 释放语义）。 */
export function waitConfirm(state: ChatRunState, callId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    // Z-P1-1：abort 也释放确认。abortChat 只放行「当时已挂起」的确认，其后循环里再挂起的
    // 确认若不监听 signal 会各空等满超时（默认 2 分钟），期间 running 锁被白占。
    // settle 后再触发一律 no-op（幂等：作者确认与 abort 可能先后到达同一确认）。
    let settled = false
    const onAbort = (): void => finish(false)
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      state.pending.delete(callId)
      state.ctrl.signal.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    state.pending.set(callId, finish)
    // abort 先于挂起到达（signal 已 aborted）→ 立即按取消处理，不等超时
    if (state.ctrl.signal.aborted) finish(false)
    else state.ctrl.signal.addEventListener('abort', onAbort)
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
        // Z-P1-1：编排级中断信号下发工具层——嵌套 AI 生成（rewrite/lead_update）据此
        // 同步中止，不再跑到各自的总超时；本地工具（tree/search 等）忽略之
        signal: ctrl,
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
        // RB-AI-P2-5：超上限截断到头尾保留 + 注明截断量与正文文件路径（全文在草稿文件，
        // 作者可查）。不外置 spill：read_chapter 是 spill 取回通道，二次外置会 read→spill→read
        // 环（spill.ts 防环不变量）——上限取「能覆盖绝大多数整章、又不至数万字爆上下文」
        const chars = Array.from(body)
        if (chars.length <= READ_CHAPTER_MAX_CHARS) return { ok: true, summary: body }
        const kept = READ_CHAPTER_HEAD_CHARS + READ_CHAPTER_TAIL_CHARS
        return {
          ok: true,
          summary:
            chars.slice(0, READ_CHAPTER_HEAD_CHARS).join('') +
            `\n\n（全章 ${chars.length} 字超出单次读取上限，已截断至 ${kept} 字（开头 + 结尾）。全文在 ${draftRel}。）\n\n` +
            chars.slice(chars.length - READ_CHAPTER_TAIL_CHARS).join(''),
        }
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
    // Y-P2-2：压缩存档并入 compaction/end 载荷（replace 在被遮蔽区间原位取代）——
    // 跨重启恢复经投影带回存档（此前摘要只在内存，重启丢被压上下文）
    const firstMsg = outcome.history[0]
    const archiveSeq =
      firstMsg !== undefined && typeof firstMsg.content === 'string'
        ? recorder.close('completed', shadowSeqs, firstMsg.content)
        : recorder.close('completed', shadowSeqs)
    msgSeqs.unshift(archiveSeq !== null ? [archiveSeq] : [])
    msgSeqMap.set(opts.bookName, msgSeqs)
    histories.set(opts.bookName, outcome.history)
    return
  }
  msgSeqMap.set(opts.bookName, msgSeqs)
  // no-op 或摘要失败（fail-open 保留原历史，不遮蔽）；失败 → 置 suppress，下次溢出硬截断
  if (outcome.wasOverLimit) compactionSuppressed.add(opts.bookName)
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
  // F1-P1：事件库（userData 为空 → null，退化内存模式）；连接为进程内单例（引用计数），
  // finally 的 close() 是「释放引用」——归零才真关库
  const store = openSessionStore(opts.userDataPath, opts.bookRoot)
  // Y-P1-1：recorder 提前声明——异常路径 finally 兜底 dispose（注销活跃登记，防孤儿修复误伤）
  let recorder: SessionRecorder | undefined

  try {
    const history = getHistory(opts.bookName)
    // F1-P1：事件库（userData 为空 → null，退化内存模式）+ 跨重启恢复。
    // 内存无历史且库有投影 → 恢复（LRU 逐出/重启后都走这条）。
    let msgSeqs = msgSeqMap.get(opts.bookName) ?? []
    let pendingMsgSeqs: Array<number | number[]> = []
    // Y-P2-7：批内序号 → 全局 seq 换算收口（三处重复换算，改口径极易漏改一处）
    const commitPendingMsgSeqs = (range: { first: number; last: number } | null): void => {
      if (!range) return
      for (const idx of pendingMsgSeqs) {
        msgSeqs.push(typeof idx === 'number' ? [range.first + idx] : idx.map((i) => range.first + i))
      }
      pendingMsgSeqs = []
    }
    if (opts.regenerate && store) {
      // F1-P4：重新生成——总是从事件重建到触发 user（parentSeq）为止（不依赖内存历史，
      // 内存可能含旧分支或被截断的历史），沿分支路径
      const restored = loadHistoryWithSeqs(selectBranchTo(store.listEvents(opts.bookName), opts.regenerate.parentSeq))
      history.length = 0
      history.push(...restored.msgs)
      msgSeqs = restored.seqsPerMsg
      msgSeqMap.set(opts.bookName, msgSeqs)
    } else if (store && history.length === 0) {
      // Z-P1-2：恢复走默认分支投影（最新变体组 + 线性兜底），与 GET /chat/history 视图同口径——
      // 全量投影会把兄弟变体顺序堆进模型上下文（regenerate 过的书重启后答非所问）
      const restored = loadHistoryWithSeqs(selectBranch(store.listEvents(opts.bookName)))
      if (restored.msgs.length > 0) {
        history.push(...restored.msgs)
        msgSeqs = restored.seqsPerMsg
        msgSeqMap.set(opts.bookName, msgSeqs)
      }
    }
    // 防御：msgSeqs 与 history 长度不一致（旧进程残留）→ 重置，宁可遮蔽不精准也不误遮蔽
    if (msgSeqs.length !== history.length) msgSeqs = []
    // Z-P1-2（G1 写侧谱系）：本回合分支归属——regenerate = parentSeq + 新 branchId；
    // 普通回合延续本书活跃分支（只带 branchId 进组，不设 parentSeq——不是变体根）；
    // 无活跃分支（线性书/清空后）→ undefined，行为与旧版完全一致
    const activeBranch = activeBranchByBook.get(opts.bookName)
    const turnBranch: { parentSeq?: number; branchId?: string } | undefined = opts.regenerate
      ? { parentSeq: opts.regenerate.parentSeq, branchId: opts.regenerate.branchId }
      : activeBranch !== undefined
        ? { branchId: activeBranch }
        : undefined
    const sessionId = store ? store.createSession(opts.bookName, { book: opts.bookName }) : 'mem'
    recorder = new SessionRecorder(store, sessionId)
    recorder.add(sessionStartEvent(opts.bookName))
    const baseLen = history.length
    const ctx = buildChatContext(opts.bookRoot, opts.chapter, { userDataPath: opts.userDataPath })
    const sys = chatSystem(ctx)
    // P3 血缘：注入快照指纹（settings/正文预览/技巧包索引）——turn 内登记 settings/snapshot
    // + revision/ref + skills/snapshot。三处 digest 与可见侧收集器 visibleInjections
    // （prompts/chat.ts）严格同源：同一 ctx 字段、同一 digest16——「模型可见 ⟺ 已记录」的命门
    const settingsDigest = digest16(ctx.settings)
    const revisionDigest = ctx.currentChapter ? digest16(ctx.currentChapter) : undefined
    const skillsDigest = ctx.skillsIndex ? digest16(ctx.skillsIndex) : undefined
    // #3b 根修：push 必须在 buildChatContext 之后——buildChatContext 读文件可能耗时，
    // 期间若作者发起新对话（并发），旧历史 push 会与新消息错位（交替 user 被打乱）。
    // 先读文件后 push，保证 history 修改点紧邻 generate，window 最小。
    if (!opts.regenerate) {
      // F1-P4：regenerate 复用已有 user 消息（历史恢复已含），不再 push/写新 user 事件；
      // 普通回合带活跃分支归属（Z-P1-2 写侧谱系——regenerate 后的续聊 user 进组）
      history.push({ role: 'user', content: opts.message ?? '' })
      pendingMsgSeqs.push(recorder.add(userMessageEvent(opts.message ?? '', opts.chapter, turnBranch)))
    }

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
      // P3 血缘：登记本轮注入快照（settings/snapshot + revision/ref + skills/snapshot），assistant 事件引用
      const lineageIdx: number[] = []
      lineageIdx.push(recorder.add(settingsSnapshotEvent({ scope: 'settings', digest: settingsDigest })))
      if (revisionDigest !== undefined) {
        lineageIdx.push(recorder.add(revisionRefEvent({ chapter: opts.chapter ?? 0, revision: revisionDigest, path: '' })))
      }
      // G2-2：技巧包索引注入（DSH-18）补登记——skillsIndex 非空才注入，同条件才登记
      if (skillsDigest !== undefined) {
        lineageIdx.push(recorder.add(skillsSnapshotEvent({ digest: skillsDigest })))
      }
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
        recorder.close('error', recorder.allSessionSeqs())
        return void emit(opts, { type: 'chat_error', error: out.error })
      }

      const { text, toolCalls, stopReason, reasoning } = out.data

      // max_tokens → 工具入参可能被截断，绝不执行；半截文本不入 history（K12）
      if (stopReason === 'max_tokens') {
        // P1-R1a：回滚 user 消息（与 !out.ok 路径一致），防下次对话连续 user → Anthropic 400
        history.length = baseLen
        recorder.close('max-tokens', recorder.allSessionSeqs())
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
        pendingMsgSeqs.push(recorder.add(assistantMessageEvent(asstContent, out.usage ?? undefined, stopReason, lineageIdx, turnBranch)))
        recorder.add(turnEndEvent(turn, 'completed'))
        commitPendingMsgSeqs(recorder.flush())
        emit(opts, {
          type: 'chat_done',
          ...(out.usage ? { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens } : {}),
        })
        completedOk = true
        // Z-P1-2：regenerate 成功才激活新分支（失败/中断的半截组已被遮蔽，激活会归因到幽灵组）
        if (opts.regenerate) activeBranchByBook.set(opts.bookName, opts.regenerate.branchId)
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
      pendingMsgSeqs.push(recorder.add(assistantMessageEvent(asstBlocks, out.usage ?? undefined, stopReason, lineageIdx, turnBranch)))
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
      // F1-P4：regenerate 回合同样带分支元数据——否则 tool/result 无 branchId 会落在组外，
      // selectBranch 只保留组内+祖先链，带工具调用的变体在分支视图里丢工具往返
      const resultIdxs: number[] = []
      for (const rb of results) {
        if (rb.type === 'tool_result') {
          resultIdxs.push(recorder.add(toolResultEvent(rb.toolUseId, rb.content, rb.isError, turnBranch)))
        }
      }
      pendingMsgSeqs.push(resultIdxs)
      recorder.add(turnEndEvent(turn, 'completed'))
      commitPendingMsgSeqs(recorder.flush())
    }

    // 轮数触顶——补固定收尾文案
    emit(opts, { type: 'chat_turn', turn: MAX_AGENT_TURNS })
    const closingMsg = '已达到单次对话的工具调用上限，先到这里——你可以基于以上结果继续提问。'
    emit(opts, { type: 'chat_text', text: closingMsg })
    // P1-R1b：收尾文案入历史（防末尾 user(tool_result) + 下次 user → 连续 user → Anthropic 400）
    history.push({ role: 'assistant', content: closingMsg })
    // F1-P1：事件记录 + 落库 + trim 遮蔽（与无工具完成路径一致）
    // F1-P4：收尾 assistant 也进同一变体组（regenerate 轮数触顶时整回合不丢出分支视图）
    pendingMsgSeqs.push(recorder.add(assistantMessageEvent(closingMsg, undefined, undefined, undefined, turnBranch)))
    recorder.add(turnEndEvent(MAX_AGENT_TURNS - 1, 'max-turns'))
    commitPendingMsgSeqs(recorder.flush())
    emit(opts, { type: 'chat_done' })
    completedOk = true
    // Z-P1-2：轮数触顶收尾也属正常完成——同口径激活新分支
    if (opts.regenerate) activeBranchByBook.set(opts.bookName, opts.regenerate.branchId)
    // B1+B2：溢出 → checkpoint 压缩优先（同无工具完成路径）
    await finalizeHistory(opts, history, msgSeqs, recorder, sys, state)
  } finally {
    running.delete(opts.bookName)
    // E1a：steer 续链——正常完成自动消费队头；abort/error/超时丢弃队列
    drainNextChat(opts, completedOk)
    // Y-P1-1：注销活跃会话登记（幂等；close 已调过则 no-op）——异常跳过 close 的路径兜底
    recorder?.dispose()
    // F1-P1：释放事件库引用（单例引用计数；steer 续链已拿到自己的引用，不受影响）
    store?.close()
    // X-P2-11：对话终态注销 ctrl——isRunning 归 false（此前 chat_done 后仍登记，SSE 快照假报「生成中」）
    opts.driver.unregisterCtrl?.(opts.mainSession, state.ctrl)
  }
}
