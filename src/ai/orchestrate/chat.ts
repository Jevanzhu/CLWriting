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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DriverEvent, Session, StudioDriver } from '../../driver/types.js'
import type { ChatMsg, ContentBlock, TokenUsage } from '../provider/types.js'
import { generate } from '../gen.js'
import { runTask } from '../runner.js'
import { chatTools, TOOL_RISK } from '../contract/chat.js'
import { chatSystem, buildChatContext, trimHistory } from '../prompts/chat.js'
import { isSelfHealRunning, runSelfHeal, abortSelfHeal, type SelfHealOutcome } from './self-heal.js'
import { runCheckForDocument, type CheckOutcome } from '../../check/run.js'
import { resolveDraftPath } from '../../format/draft.js'

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

/** 中断本书的对话——abort + 放行挂起的确认 */
export function abortChat(bookName: string): boolean {
  const st = running.get(bookName)
  if (!st) return false
  for (const [, resolve] of st.pending) resolve(false)
  st.ctrl.abort()
  return true
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
const MAX_HISTORY_BOOKS = 8

function getHistory(bookName: string): ChatMsg[] {
  const h = histories.get(bookName)
  if (h) return h
  if (histories.size >= MAX_HISTORY_BOOKS) {
    // 删最旧（Map 保留插入顺序）
    const oldest = histories.keys().next().value
    if (oldest !== undefined) histories.delete(oldest)
  }
  const fresh: ChatMsg[] = []
  histories.set(bookName, fresh)
  return fresh
}

/** 清空本书对话历史（前端"清空对话"时调） */
export function clearChatHistory(bookName: string): void {
  histories.delete(bookName)
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
        const chapter = Number(input['chapter'])
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

export async function runChat(opts: ChatOpts): Promise<void> {
  const state: ChatRunState = {
    ctrl: new AbortController(),
    deadline: Date.now() + AGENT_DEADLINE_MS,
    pending: new Map(),
  }
  running.set(opts.bookName, state)
  const confirmTimeout = opts.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS

  try {
    const history = getHistory(opts.bookName)
    const baseLen = history.length
    history.push({ role: 'user', content: opts.message })

    const ctx = buildChatContext(opts.bookRoot, opts.chapter)
    const sys = chatSystem(ctx)

    emit(opts, { type: 'chat_start' })
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      if (state.ctrl.signal.aborted) {
        return void emit(opts, { type: 'chat_error', error: '已中断' })
      }
      if (Date.now() > state.deadline) {
        return void emit(opts, { type: 'chat_error', error: '对话超时（超过 30 分钟），已停止' })
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
        ctrl: state.ctrl,
        register: (c) => opts.driver.registerCtrl?.(opts.mainSession, c),
        onReset: () => emit(opts, { type: 'chat_reset' }),
        run: async (provider, signal, tier) => {
          const r = await generate(
            provider,
            {
              systemPrompt: sys,
              messages: history,
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
        return void emit(opts, { type: 'chat_error', error: out.error })
      }

      const { text, toolCalls, stopReason, reasoning } = out.data

      // max_tokens → 工具入参可能被截断，绝不执行；半截文本不入 history（K12）
      if (stopReason === 'max_tokens') {
        histories.set(opts.bookName, trimHistory(history, MAX_HISTORY_TURNS))
        return void emit(opts, { type: 'chat_error', error: '回复达到长度上限被截断，请缩小问题范围重试' })
      }

      // 无工具调用 → 对话结束
      if (toolCalls.length === 0) {
        history.push({ role: 'assistant', content: text })
        histories.set(opts.bookName, trimHistory(history, MAX_HISTORY_TURNS))
        return void emit(opts, {
          type: 'chat_done',
          ...(out.usage ? { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens } : {}),
        })
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
    }

    // 轮数触顶——补固定收尾文案
    emit(opts, { type: 'chat_turn', turn: MAX_AGENT_TURNS })
    emit(opts, { type: 'chat_text', text: '已达到单次对话的工具调用上限，先到这里——你可以基于以上结果继续提问。' })
    histories.set(opts.bookName, trimHistory(history, MAX_HISTORY_TURNS))
    emit(opts, { type: 'chat_done' })
  } finally {
    running.delete(opts.bookName)
  }
}
