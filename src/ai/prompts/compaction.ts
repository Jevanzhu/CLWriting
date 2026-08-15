/**
 * 历史压缩规划（批次 B1 / CS-7+CS-8 直抄思想；回合判定按 CLWriting 配对版重写）。
 *
 * cherry 的 groupIntoTurns 按 role:'tool' 判回合；CLWriting 的 tool_result 是
 * user 消息的 content block（Anthropic 风格），配对判定改为：
 * - user(纯文本) = 回合起点（作者发言）；
 * - assistant(tool_use) 与其后回填的 user(tool_result) 留在同一回合——
 *   切点落进配对中间 = 孤儿 tool_use/tool_result = Anthropic 400。
 *
 * 三分法（planCompaction）：system 永不裁——CLWriting 历史本身不含 system
 * （system prompt 在 history 之外组装，天然满足「常驻指令永不压缩」）；
 * 其余按回合切 toSummarize / toKeep，切点永不落回合中间（按组切，构造保证）。
 *
 * no-op 纪律：无物可压 / 摘要空 / 非严格更小 → 返回原数组引用
 * （调用方以 summarizedCount === 0 判 no-op），绝不插入占位符。
 */
import type { ChatMsg, ContentBlock } from '../provider/types.js'
import { CHECKPOINT_PREAMBLE, CHECKPOINT_TAG_OPEN, CHECKPOINT_TAG_CLOSE, extractPriorSummary } from './checkpoint.js'

/** 消息是否为回合起点（作者纯文本发言；tool_result 的 user 消息不是） */
export function isTurnStart(m: ChatMsg): boolean {
  return m.role === 'user' && typeof m.content === 'string'
}

/**
 * 按回合分组：每组 = user 起点 + 其后全部 assistant 回应 / tool 配对，
 * 直到下一个 user 起点。首条非 user 的悬空前缀（sanitizeHistory 正常会剔）自成一组。
 */
export function groupIntoTurns(messages: ChatMsg[]): ChatMsg[][] {
  const turns: ChatMsg[][] = []
  let cur: ChatMsg[] | null = null
  for (const m of messages) {
    if (isTurnStart(m)) {
      if (cur !== null) turns.push(cur)
      cur = [m]
    } else {
      if (cur === null) cur = []
      cur.push(m)
    }
  }
  if (cur !== null && cur.length > 0) turns.push(cur)
  return turns
}

export interface CompactionPlan {
  /** 待摘要压掉的旧回合（前置；可能含上一轮压缩留下的 checkpoint 消息） */
  toSummarize: ChatMsg[]
  /** 原样保留的近期回合 */
  toKeep: ChatMsg[]
}

/** 规划：保留最近 keepTurns 个完整回合，其余为待摘要区；回合数未超 → null（无物可压） */
export function planCompaction(messages: ChatMsg[], opts: { keepTurns: number }): CompactionPlan | null {
  const turns = groupIntoTurns(messages)
  if (turns.length <= opts.keepTurns) return null
  const cut = turns.length - opts.keepTurns
  return {
    toSummarize: turns.slice(0, cut).flat(),
    toKeep: turns.slice(cut).flat(),
  }
}

/** 计量消息占用的 code point 数（严格更小校验的口径；tool_use 入参按 64 粗估） */
function measureMessages(msgs: ChatMsg[]): number {
  let n = 0
  for (const m of msgs) {
    if (typeof m.content === 'string') {
      n += Array.from(m.content).length
      continue
    }
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'text' || b.type === 'reasoning') n += Array.from(b.text).length
      else if (b.type === 'tool_result') n += Array.from(b.content).length
      else n += 64
    }
  }
  return n
}

export interface CompactOutcome {
  /** 压缩后的历史（no-op / 失败时 === 入参引用） */
  history: ChatMsg[]
  /** 被压掉的消息条数（>0 = 发生了压缩；0 = no-op，调用方跳过遮蔽/持久化） */
  summarizedCount: number
  /**
   * 本次是否因溢出被触发压缩（P3-7 改名：真实含义是「被触发」，不是「仍在溢出」——
   * 压缩成功也返回 true）。true 且 summarizedCount=0 → 摘要失败，fail-open 保留原历史。
   */
  wasOverLimit: boolean
}

/**
 * 压缩历史（摘要以 user 消息插入——模型对「既定背景」接受度最高的载体）。
 *
 * 失败纪律：
 * - 空摘要 fail-open：摘要 null / 空白 → 原数组引用返回，绝不填占位符；
 * - 严格更小校验：包裹后的存档不比被压内容短 → 视为失败（防「压了没变小」活锁）；
 * - 合并而非复制：待压区首条已是先前 checkpoint → 提取旧摘要交给摘要器累计，
 *   多轮压缩始终只产一张累计存档。
 */
export async function compactHistory(
  history: ChatMsg[],
  opts: { keepTurns: number },
  summarize: (toSummarize: ChatMsg[], priorSummary: string | null) => string | null | Promise<string | null>,
): Promise<CompactOutcome> {
  const plan = planCompaction(history, opts)
  if (plan === null) return { history, summarizedCount: 0, wasOverLimit: false }

  const first = plan.toSummarize[0]
  const priorSummary =
    first !== undefined && typeof first.content === 'string' ? extractPriorSummary(first.content) : null
  const summary = await summarize(plan.toSummarize, priorSummary)
  if (summary === null || summary.trim() === '') {
    return { history, summarizedCount: 0, wasOverLimit: true }
  }
  const wrapped = `${CHECKPOINT_PREAMBLE}\n\n${CHECKPOINT_TAG_OPEN}\n${summary.trim()}\n${CHECKPOINT_TAG_CLOSE}`
  // 严格更小：与被压掉的原文比（摘要区含旧存档时一并计入——累计存档必须仍小于累计原文）
  if (Array.from(wrapped).length >= measureMessages(plan.toSummarize)) {
    return { history, summarizedCount: 0, wasOverLimit: true }
  }
  return {
    history: [{ role: 'user', content: wrapped }, ...plan.toKeep],
    summarizedCount: plan.toSummarize.length,
    wasOverLimit: true,
  }
}
