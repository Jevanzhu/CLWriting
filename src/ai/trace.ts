/**
 * 全链路 trace —— 每次 runTask 调用记一条结构化轨迹。
 *
 * 写入书库 .cache/ai-trace.jsonl（一行一条），含 runId 贯穿 trace/SSE/记账三路。
 * 脱敏口径：不落 prompt 原文，只记长度 + 来源文件 + hash。
 *
 * 轮转：文件超 5MB 时 rename → ai-trace.1.jsonl（仅保留一代）。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { TokenUsage } from './provider/types.js'

const FILE = 'ai-trace.jsonl'
const ROTATED = 'ai-trace.1.jsonl'
const MAX_BYTES = 5 * 1024 * 1024 // 5MB

/** prompt 脱敏元信息（不落原文） */
export interface PromptMeta {
  /** prompt 总字符数 */
  chars: number
  /** 来源文件列表（相对书库根） */
  files: string[]
  /** prompt 内容 hash（SHA-256 前 16 位，用于去重/对比，不可逆推原文） */
  hash: string
}

/** 一条 trace 记录 */
export interface TraceEntry {
  /** 本次调用的唯一标识（贯穿 SSE/记账同一次调用） */
  runId: string
  /** ISO 时间戳 */
  ts: string
  /** 任务名（如 'self-heal' / 'analysis' / 'outline'） */
  task: string
  /** 任务档位 */
  tierKind: 'creative' | 'assistant' | 'chat'
  /** 模型名 */
  model: string
  /** 第几次尝试（0 = 首次，1+ = 重试） */
  attempt: number
  /** 停止原因（end_turn / max_tokens / tool_use / abort 等） */
  stopReason: string
  /** prompt 脱敏元信息 */
  promptMeta: PromptMeta
  /** token 用量（D4：cache 命中/写入可选入账——端点下发才有） */
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  /** 总耗时 ms（含重试退避） */
  durationMs: number
  /** 是否成功 */
  ok: boolean
  /** 失败时的错误码 */
  errCode?: string
}

/** 生成新的 runId */
export function newRunId(): string {
  return randomUUID()
}

/** 计算 prompt 的脱敏元信息 */
export function promptMeta(systemPrompt: string, userPrompt: string, files: string[] = []): PromptMeta {
  const full = systemPrompt + userPrompt
  return {
    chars: full.length,
    files,
    hash: createHash('sha256').update(full).digest('hex').slice(0, 16),
  }
}

/** trace 文件路径 */
function tracePath(bookRoot: string): string {
  return join(bookRoot, '.cache', FILE)
}

/**
 * 追加一条 trace 记录。
 *
 * 两参数齐备（bookRoot + entry）才落盘。轮转：超 5MB 时 rename → ai-trace.1.jsonl。
 * 损坏行容错：写入失败不炸调用方（trace 是观测层，不应影响业务流程）。
 */
export function appendTrace(bookRoot: string, entry: TraceEntry): void {
  const fp = tracePath(bookRoot)
  try {
    // 轮转检查
    if (existsSync(fp)) {
      const stat = statSync(fp)
      if (stat.size > MAX_BYTES) {
        renameSync(fp, join(dirname(fp), ROTATED))
      }
    }
    mkdirSync(dirname(fp), { recursive: true })
    appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // trace 写入失败不炸业务流程（观测层不应对业务产生副作用）
  }
}

/** 读全部 trace 行（含轮转代），跳过损坏行 */
export function readTraceLines(bookRoot: string): TraceEntry[] {
  const dir = join(bookRoot, '.cache')
  const rotated = join(dir, ROTATED)
  const current = tracePath(bookRoot)
  const lines: TraceEntry[] = []
  // 先读轮转代（旧），再读当前代（新），保持时间序
  for (const fp of [rotated, current]) {
    if (!existsSync(fp)) continue
    try {
      const content = readFileSync(fp, 'utf8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          lines.push(JSON.parse(line) as TraceEntry)
        } catch {
          // 损坏行跳过
        }
      }
    } catch {
      // 文件不可读跳过
    }
  }
  return lines
}

/** trace 落盘用的 token 用量提取（从 TaskOk.usage 或 GenResult.usage；D4 含 cache 字段） */
export function toTraceUsage(usage: TokenUsage | null): { input: number; output: number; cacheRead?: number; cacheWrite?: number } {
  if (!usage) return { input: 0, output: 0 }
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheRead: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWrite: usage.cacheWriteTokens } : {}),
  }
}
