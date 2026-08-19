/**
 * chat 相位 e：失败出口收敛 + 收尾历史窗口处理（hh §八-16 自 chat.ts 拆出，纯搬家）。
 *
 * - finishTurn：六处失败出口（轮首中止 timedOut / 轮首中止用户中断 / 轮首 deadline /
 *   !ok 超时 / !ok 错误 / max_tokens）的单一出口——回滚 + 全会话 surface 遮蔽 +
 *   chat_error 文案，遮蔽口径（GG-P2-1 幽灵消息口径）只在此处定义；
 * - finalizeHistory / summarizeCheckpoint：B1+B2 溢出时 checkpoint 压缩优先，
 *   失败回落 F1-P1 硬截断（trim 遮蔽语义不变）。
 */
import type { ChatMsg } from '../../provider/types.js'
import { modelConfOf } from '../../provider/store.js'
import { generate } from '../../gen.js'
import { runTask } from '../../runner.js'
import { chatTools } from '../../contract/chat.js'
import { trimHistory, sanitizeHistory } from '../../prompts/chat.js'
import { compactHistory } from '../../prompts/compaction.js'
import { buildCheckpointInstruction, clampCheckpointOutputTokens } from '../../prompts/checkpoint.js'
import type { SessionRecorder } from '../../../events/chat-bridge.js'
import type { ChatOpts } from '../chat.js'
import { emit, histories, msgSeqMap, type ChatRunState } from './state.js'

const MAX_HISTORY_TURNS = 10

// ── 失败出口收敛 ──────────────────────────────────

/** 失败出口口径表——mask 是 session/end 终态 + 全会话 surface 遮蔽实参，message 是 chat_error 文案 */
type ChatExitReason = 'timeout' | 'interrupted' | 'max-tokens' | { error: string }

const CHAT_EXIT_SPEC = {
  timeout: { mask: 'aborted', message: '对话超时（超过 30 分钟），已停止' },
  interrupted: { mask: 'interrupted', message: '已中断' },
  'max-tokens': { mask: 'max-tokens', message: '回复达到长度上限被截断，请缩小问题范围重试' },
} as const

/** 单一失败出口：回滚历史到 baseLen（P1-S4/R1a：防末尾 user → 下次连续 user → Anthropic 400）
 * + 本会话全部 surface 消息遮蔽（F1-P1：防下次恢复/审计重放出已回滚的废数据）+ chat_error 文案。 */
export function finishTurn(
  opts: ChatOpts,
  history: ChatMsg[],
  baseLen: number,
  recorder: SessionRecorder,
  reason: ChatExitReason,
): void {
  history.length = baseLen
  const spec = typeof reason === 'object' ? { mask: 'error' as const, message: reason.error } : CHAT_EXIT_SPEC[reason]
  recorder.closeMaskingAll(spec.mask)
  emit(opts, { type: 'chat_error', error: spec.message })
}

// ── 收尾压缩（B1+B2 升级 F1-P1 的 trim 遮蔽点） ──────

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
          // P8：摘要输出预算按模型上下文窗口吃 clamp——模型行未声明 contextWindow → 维持旧上限 16384
          maxTokens: clampCheckpointOutputTokens(modelConfOf(provider.conf)?.contextWindow),
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
export async function finalizeHistory(
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
