/**
 * 全链路 trace 的脱敏元信息。
 *
 * runId 贯穿 trace/SSE/记账三路；脱敏口径：不落 prompt 原文，只记长度 + 来源文件 + hash。
 * Z-P2-3：旧的文件写入层（appendTrace/readTraceLines + 5MB 轮转）已被事件库
 * llm/call 替代（零生产调用），按死代码移除；本模块只保留 runId / promptMeta /
 * usage 提取这些被 runner.ts 消费的纯函数。
 */
import { randomUUID, createHash } from 'node:crypto'
import type { TokenUsage } from './provider/types.js'

/** prompt 脱敏元信息（不落原文） */
export interface PromptMeta {
  /** prompt 总字符数 */
  chars: number
  /** 来源文件列表（相对书库根） */
  files: string[]
  /** prompt 内容 hash（SHA-256 前 16 位，用于去重/对比，不可逆推原文） */
  hash: string
}

/** 生成新的 runId */
export function newRunId(): string {
  return randomUUID()
}

/** 计算 prompt 的脱敏元信息 */
export function promptMeta(systemPrompt: string, userPrompt: string, files: string[] = []): PromptMeta {
  const full = systemPrompt + userPrompt
  // R66-8（十四轮）：两段直接拼接进 hash 时 ("ab","c") 与 ("a","bc") 同 hash——相邻
  // 字段边界不可辨，审计指纹歧义。hash 输入前置 systemPrompt 长度前缀（len:full），
  // 边界由前缀唯一确定；chars 仍记真实拼接长度，脱敏口径不变。
  const hashInput = `${systemPrompt.length}:${full}`
  // R26-26（二十六轮）：chars 记码位数（for..of 迭代）而非 UTF-16 length——usage 估算
  // 侧（usage-estimate→estimateTokens）按码位折算，校准拟合（C4 用 chars）与估算应用
  // 两侧口径对齐；代理对密集（emoji）文本下两侧系数不再有系统偏差。
  let chars = 0
  for (let i = 0; i < full.length; ) {
    const cp = full.codePointAt(i)!
    chars++
    i += cp > 0xffff ? 2 : 1
  }
  return {
    chars,
    files,
    hash: createHash('sha256').update(hashInput).digest('hex').slice(0, 16),
  }
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
