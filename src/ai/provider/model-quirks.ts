/**
 * 模型 quirks 表——按模型系列输出参数翻译决策（方案 §4.1）。
 *
 * 原则：检测不出系列 → 保守省略一切可选参数；**不做模型白名单**，
 * 永不拦截用户选任何模型（分发产品原则）。
 *
 * Chat 侧五维度：effort 发射 / 输出上限参数名 / stop 裁剪 / stream_options /
 * 结构化输出档位。anthropic 侧仅 DeepSeek effort 档位收敛一处（见 anthropic 适配器）。
 */
import type { EffortLevel } from './types.js'

export type ModelFamily = 'claude' | 'gpt' | 'grok' | 'deepseek' | 'glm' | 'kimi' | 'unknown'

/** 按模型名前缀判定系列（不做白名单，识别不出即 unknown → 保守省略） */
export function detectFamily(model: string): ModelFamily {
  const m = model.trim()
  if (/^(gpt-|o\d|chatgpt-)/i.test(m)) return 'gpt'
  if (/^grok/i.test(m)) return 'grok'
  if (/^deepseek/i.test(m)) return 'deepseek'
  if (/^glm/i.test(m)) return 'glm'
  // kimi 现役 k3/k2.x（平台模型 ID 可能不带 kimi 前缀，如 "k3"）
  if (/^(kimi|moonshot|k\d)/i.test(m)) return 'kimi'
  if (/^claude/i.test(m)) return 'claude'
  return 'unknown'
}

/** GLM 仅 5.2+ 支持 reasoning_effort（4.x 发则 400） */
function isGlmAtLeast(model: string, major: number, minor: number): boolean {
  const mm = model.match(/glm[-._]?(\d+)\.(\d+)/i)
  if (!mm) return false
  const a = Number(mm[1])
  const b = Number(mm[2])
  return a > major || (a === major && b >= minor)
}

/** kimi 仅 k3 支持 reasoning_effort（k2.x 采样参数固定，发则 400） */
function isKimiK3(model: string): boolean {
  return /k3/i.test(model)
}

export interface ChatQuirks {
  /** 输出上限参数名（OpenAI 侧新旧名并存，各家不同） */
  maxTokensKey: 'max_completion_tokens' | 'max_tokens'
  /** effort → reasoning_effort 值；null = 该系列不支持，不发 */
  reasoningEffort(effort: EffortLevel): string | null
  /** 发 effort 时是否附带 thinking 对象（DeepSeek 双写法官方并存） */
  thinkingWithEffort: boolean
  /** stop 序列裁剪；返回 null = 不发该参数 */
  trimStop(stops: string[]): string[] | null
  /** 是否发 stream_options.include_usage */
  emitStreamOptions: boolean
  /** 结构化输出档位（json_schema 400 降级剥除；json_object 需 prompt 约束） */
  structuredMode: 'json_schema' | 'json_object' | 'none'
}

/** OpenAI 官方三档映射（xhigh/max → high） */
function openaiEffort(e: EffortLevel): string {
  return e === 'xhigh' || e === 'max' ? 'high' : e
}

/** low/high/max 三档映射（DeepSeek/Kimi：medium→high、xhigh→max） */
function trimEffort(e: EffortLevel): string {
  return e === 'medium' ? 'high' : e === 'xhigh' ? 'max' : e
}

export function quirksFor(model: string): ChatQuirks {
  switch (detectFamily(model)) {
    case 'gpt':
      return {
        maxTokensKey: 'max_completion_tokens',
        reasoningEffort: openaiEffort,
        thinkingWithEffort: false,
        trimStop: (s) => s,
        emitStreamOptions: true,
        structuredMode: 'json_schema',
      }
    case 'grok':
      return {
        maxTokensKey: 'max_completion_tokens',
        // 两文档矛盾：按模型透传，400 由适配器剥除重试
        reasoningEffort: (e) => e,
        thinkingWithEffort: false,
        trimStop: () => null, // 推理模型 stop 报错
        emitStreamOptions: true,
        structuredMode: 'json_schema',
      }
    case 'deepseek':
      return {
        maxTokensKey: 'max_tokens',
        reasoningEffort: trimEffort,
        thinkingWithEffort: true,
        trimStop: (s) => s,
        emitStreamOptions: true,
        structuredMode: 'json_object',
      }
    case 'glm':
      return {
        maxTokensKey: 'max_tokens',
        reasoningEffort: (e) => (isGlmAtLeast(model, 5, 2) ? openaiEffort(e) : null),
        thinkingWithEffort: false,
        trimStop: (s) => s.slice(0, 1), // 文档冲突，取保守首个
        emitStreamOptions: false, // 无此参数，usage 末 chunk 自带
        structuredMode: 'json_object',
      }
    case 'kimi':
      return {
        maxTokensKey: 'max_completion_tokens',
        reasoningEffort: (e) => (isKimiK3(model) ? trimEffort(e) : null),
        thinkingWithEffort: false,
        trimStop: (s) => s.slice(0, 5), // 最多 5 个且各 ≤32 字节
        emitStreamOptions: true,
        structuredMode: 'json_schema',
      }
    default:
      // claude（走 chat 网关）/ unknown：保守省略一切可选参数
      return {
        maxTokensKey: 'max_tokens',
        reasoningEffort: () => null,
        thinkingWithEffort: false,
        trimStop: (s) => s,
        emitStreamOptions: true,
        structuredMode: 'none',
      }
  }
}
