/**
 * chat 相位 d：agent 轮循环（hh §八-16 自 chat.ts runChat 拆出，纯搬家）。
 *
 * 轮首中止三出口 / 快照血缘登记 / generate 流式回调 / !ok 与 max_tokens 出口 /
 * 无工具完成路径（assistant 事件 + 分支激活 Z-P1-2 + 溢出 checkpoint B1+B2）/
 * 工具路径（确认闸 + tool_use/tool_result 事件 + 分支元数据）/ 轮数触顶收尾。
 * 返回 completedOk（E1a：正常完成才续链消费队列）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMsg, ContentBlock, TokenUsage } from '../../provider/types.js'
import { generate } from '../../gen.js'
import { runTask } from '../../runner.js'
import { chatTools, TOOL_RISK } from '../../contract/chat.js'
// 工具面扩展：注册表分派（book_search/chapter_status/树操作/改写/账本/文风）
import { TOOL_EXECUTORS, type ToolContext } from '../../tools/index.js'
import { isSelfHealRunning, runSelfHeal, abortSelfHeal, type SelfHealOutcome } from '../self-heal.js'
import { runCheckForDocument, type CheckOutcome } from '../../../check/run.js'
import { resolveDraftPath } from '../../../format/draft.js'
// DSH-18：写作技巧包按需加载（read_skill 工具的执行通道）
import { listSkills, loadSkill } from '../../../process/skills.js'
import { sanitizeHistory } from '../../prompts/chat.js'
import type { SessionRecorder } from '../../../events/chat-bridge.js'
import { turnStartEvent, turnEndEvent, assistantMessageEvent, toolCallEvent, toolResultEvent } from '../../../events/chat-bridge.js'
import { settingsSnapshotEvent, revisionRefEvent, skillsSnapshotEvent } from '../../../events/chain-bridge.js'
import type { ChatOpts } from '../chat.js'
import { emit, activeBranchByBook, type ChatRunState } from './state.js'
import { finishTurn, finalizeHistory } from './finish.js'
import type { ChatSeqLedger } from './restore.js'

const MAX_AGENT_TURNS = 5

/** RB-AI-P2-5：read_chapter 单次返回上限（code points，与 chat 入口消息上限 5 万字符
 *  同量级的安全上限）——数万字整章无上限灌 tool_result 可撑爆上下文 */
const READ_CHAPTER_MAX_CHARS = 20_000
const READ_CHAPTER_HEAD_CHARS = 12_000
const READ_CHAPTER_TAIL_CHARS = 6_000

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
        const outcome = runCheckForDocument(opts.bookRoot, draftPath, opts.userDataPath)
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

// ── 轮循环 ────────────────────────────────────────

export interface TurnDeps {
  opts: ChatOpts
  state: ChatRunState
  confirmTimeout: number
  history: ChatMsg[]
  baseLen: number
  recorder: SessionRecorder
  sys: string
  /** Z-P1-2：本回合分支元数据（来自 restore 相位） */
  turnBranch: { parentSeq?: number; branchId?: string } | undefined
  /** P3 血缘：注入快照指纹（来自 restore 相位） */
  digests: { settings: string; revision?: string; skills?: string }
  seqs: ChatSeqLedger
  /** chat_done 发出当口回调置 completedOk——此后 finalizeHistory 若抛异常，
   *  续链口径与拆分前一致（正常完成已广播，队列照常消费，不因收尾压缩失败丢弃） */
  markCompleted: () => void
}

/** 相位 d：轮循环 + 轮数触顶收尾。返回 completedOk（E1a 续链口径：正常完成才 true）。 */
export async function runAgentTurns(deps: TurnDeps): Promise<boolean> {
  const { opts, state, confirmTimeout, history, baseLen, recorder, sys, turnBranch, seqs } = deps
  const { settings: settingsDigest, revision: revisionDigest, skills: skillsDigest } = deps.digests

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    if (state.ctrl.signal.aborted) {
      // P1-S4 回滚 + F1-P1 遮蔽在 finishTurn 内；CC-P2-2：deadline 定时器触发的 abort
      // 报「超时」（含嵌套 self-heal / 确认闸期间），用户中断报「已中断」
      finishTurn(opts, history, baseLen, recorder, state.timedOut ? 'timeout' : 'interrupted')
      return false
    }
    if (Date.now() > state.deadline) {
      finishTurn(opts, history, baseLen, recorder, 'timeout')
      return false
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
      /** Responses 线缺口 11：加密推理项随 reasoning 块入历史，下轮回传维持推理状态 */
      reasoningEncrypted?: string
      reasoningItemId?: string
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
        return {
          text: r.text,
          toolCalls: r.toolCalls,
          stopReason: r.stopReason,
          usage: r.usage,
          reasoning: r.reasoning,
          reasoningEncrypted: r.reasoningEncrypted,
          reasoningItemId: r.reasoningItemId,
        }
      },
    })

    if (!out.ok) {
      // CC-P2-2：deadline 定时器在 generate 期间触发 → 按超时收口（与轮首 aborted 分支同文案）
      finishTurn(opts, history, baseLen, recorder, state.timedOut ? 'timeout' : { error: out.error })
      return false
    }

    const { text, toolCalls, stopReason, reasoning, reasoningEncrypted, reasoningItemId } = out.data

    // max_tokens → 工具入参可能被截断，绝不执行；半截文本不入 history（K12）；
    // P1-R1a：回滚 user 消息（与 !out.ok 路径一致），防下次对话连续 user → Anthropic 400
    if (stopReason === 'max_tokens') {
      finishTurn(opts, history, baseLen, recorder, 'max-tokens')
      return false
    }

    // 无工具调用 → 对话结束
    if (toolCalls.length === 0) {
      // P2-AI-1：reasoning 非空时入历史（与工具路径一致——DeepSeek/Kimi 多轮带 tools 硬要求）
      let asstContent: string | ContentBlock[]
      if (reasoning) {
        const blocks: ContentBlock[] = []
        if (text) blocks.push({ type: 'text', text })
        // Responses 线缺口 11：加密推理项随 reasoning 块入历史，下轮回传维持推理状态
        blocks.push({
          type: 'reasoning',
          text: reasoning,
          ...(reasoningEncrypted ? { encrypted: reasoningEncrypted, ...(reasoningItemId ? { itemId: reasoningItemId } : {}) } : {}),
        })
        asstContent = blocks
      } else {
        asstContent = text
      }
      history.push({ role: 'assistant', content: asstContent })
      // F1-P1：记录 assistant 事件 + 回合收尾 + 落库
      seqs.pendingMsgSeqs.push(recorder.add(assistantMessageEvent(asstContent, out.usage ?? undefined, stopReason, lineageIdx, turnBranch)))
      recorder.add(turnEndEvent(turn, 'completed'))
      seqs.commitPendingMsgSeqs(recorder.flush())
      emit(opts, {
        type: 'chat_done',
        ...(out.usage ? { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens } : {}),
      })
      deps.markCompleted()
      // Z-P1-2：regenerate 成功才激活新分支（失败/中断的半截组已被遮蔽，激活会归因到幽灵组）
      if (opts.regenerate) activeBranchByBook.set(opts.bookName, opts.regenerate.branchId)
      // B1+B2：溢出 → checkpoint 压缩优先（chat_done 先发，不被摘要调用拖住）
      await finalizeHistory(opts, history, seqs.msgSeqs, recorder, sys, state)
      return true
    }

    // 有工具调用 → assistant 消息按 block 结构入历史
    // reasoning 块保留回传（DeepSeek/Kimi 多轮带 tools 硬要求，方案 §4.2）
    const asstBlocks: ContentBlock[] = []
    if (text) asstBlocks.push({ type: 'text', text })
    if (reasoning) {
      // Responses 线缺口 11：加密推理项随 reasoning 块入历史（同无工具路径）
      asstBlocks.push({
        type: 'reasoning',
        text: reasoning,
        ...(reasoningEncrypted ? { encrypted: reasoningEncrypted, ...(reasoningItemId ? { itemId: reasoningItemId } : {}) } : {}),
      })
    }
    for (const c of toolCalls) {
      asstBlocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
    }
    history.push({ role: 'assistant', content: asstBlocks })
    // F1-P1：assistant 事件（tool_use 在载荷里）+ tool/call 审计事件
    seqs.pendingMsgSeqs.push(recorder.add(assistantMessageEvent(asstBlocks, out.usage ?? undefined, stopReason, lineageIdx, turnBranch)))
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
    seqs.pendingMsgSeqs.push(resultIdxs)
    recorder.add(turnEndEvent(turn, 'completed'))
    seqs.commitPendingMsgSeqs(recorder.flush())
  }

  // 轮数触顶——补固定收尾文案
  emit(opts, { type: 'chat_turn', turn: MAX_AGENT_TURNS })
  const closingMsg = '已达到单次对话的工具调用上限，先到这里——你可以基于以上结果继续提问。'
  emit(opts, { type: 'chat_text', text: closingMsg })
  // P1-R1b：收尾文案入历史（防末尾 user(tool_result) + 下次 user → 连续 user → Anthropic 400）
  history.push({ role: 'assistant', content: closingMsg })
  // F1-P1：事件记录 + 落库 + trim 遮蔽（与无工具完成路径一致）
  // F1-P4：收尾 assistant 也进同一变体组（regenerate 轮数触顶时整回合不丢出分支视图）
  seqs.pendingMsgSeqs.push(recorder.add(assistantMessageEvent(closingMsg, undefined, undefined, undefined, turnBranch)))
  // CC-P2-1：触顶收尾记 turn 5 的终态（与上方 chat_turn emit 的 turn=MAX_AGENT_TURNS 同口径）——
  // 此前记 MAX_AGENT_TURNS-1 会把循环内已记 completed 的最后一轮再关一次，同轮双终态
  recorder.add(turnEndEvent(MAX_AGENT_TURNS, 'max-turns'))
  seqs.commitPendingMsgSeqs(recorder.flush())
  emit(opts, { type: 'chat_done' })
  deps.markCompleted()
  // Z-P1-2：轮数触顶收尾也属正常完成——同口径激活新分支
  if (opts.regenerate) activeBranchByBook.set(opts.bookName, opts.regenerate.branchId)
  // B1+B2：溢出 → checkpoint 压缩优先（同无工具完成路径）
  await finalizeHistory(opts, history, seqs.msgSeqs, recorder, sys, state)
  return true
}
