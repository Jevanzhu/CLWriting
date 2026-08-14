/**
 * 模型系列参数表——唯一真相源（表驱动重构 §五）。
 *
 * 两个维度：
 * - 能力维度——模型支持什么（toolUse / toolChoiceMode / effort / structured）
 * - 线格式维度——各协议下的小参数写法（maxTokensKey / anthropicEffortWire / ...）
 *
 * 原则：检测不出系列 → 保守省略一切可选参数；**不做模型白名单**，
 * 永不拦截用户选任何模型（分发产品原则）。
 * 每项字段注释附官方文档出处（调研日期 2026-08-13）。
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

/**
 * 模型系列参数表项——能力 × 线格式二维（表驱动重构 §5.1）。
 *
 * 批次 2 起，三适配器从此表读取决策，不再各自硬编码。
 */
export interface FamilyQuirks {
  // ── 能力维度（模型支持什么）──

  /** 支持原生 function calling；false → 装配层不挂 tools，走 prompt 引导 */
  toolUse: boolean
  /**
   * tool_choice 表达力：
   *  named   = 可强制指定函数名（OpenAI/Anthropic/DeepSeek…）
   *  required= 只能"必须调某个"不能点名（Kimi k3）
   *  auto    = 仅支持 auto（GLM 类）
   *  none    = 无此参数（openai-responses 协议）
   */
  toolChoiceMode: 'named' | 'required' | 'auto' | 'none'
  /** effort 词汇表；[] = 不支持 reasoning 参数（不发） */
  effortValues: EffortLevel[]
  /** 档位收敛映射（词汇表外的档位如何折算），学 cherry-studio effortMap */
  effortMap?: Partial<Record<EffortLevel, EffortLevel>>
  /**
   * 单次输出上限（官方文档值）；Anthropic 协议 max_tokens 必填时用它，
   * 替代写死的 8192（治 #5）。undefined = 无可靠文档值，用保守兜底。
   */
  maxOutputTokens?: number

  // ── OpenAI 线格式维度 ──

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

  // ── Anthropic 线格式维度（新增）──

  /**
   * effort 在 Anthropic 协议下的落点；null = 不发 output_config.effort。
   * claude 原生走 output_config；DeepSeek Anthropic 端点支持 effort；
   * 其余厂家的 anthropic 端点文档缺失 → 保守 null。
   */
  anthropicEffortWire: 'output_config' | null
  /**
   * 并行工具控制字段是否可发（disable_parallel_tool_use / parallel_tool_calls）。
   * DeepSeek 并行恒开不可关 → false；GLM 未声明 → false。
   */
  parallelControl: boolean
  /** 多轮带 tools 时须回传 reasoning_content（DeepSeek/Kimi 硬要求，否则 400） */
  echoReasoning: boolean
}

// ── 档位映射工具 ──

/** OpenAI 官方三档映射（xhigh/max → high） */
function openaiEffort(e: EffortLevel): string {
  return e === 'xhigh' || e === 'max' ? 'high' : e
}

/** low/high/max 三档映射（DeepSeek/Kimi：medium→high、xhigh→max） */
function trimEffort(e: EffortLevel): string {
  return e === 'medium' ? 'high' : e === 'xhigh' ? 'max' : e
}

// ── 厂家表项（按官方文档填，注释附出处）──

/**
 * 按模型名查系列参数表。
 *
 * GLM/Kimi 的 effort 支持依赖模型版本（闭包捕获 model 判断），
 * 其余系列返回静态对象。
 */
export function quirksFor(model: string): FamilyQuirks {
  switch (detectFamily(model)) {
    case 'claude':
      // Claude 原生系列。docs.anthropic.com
      return {
        toolUse: true,
        toolChoiceMode: 'named', // tool_choice 四取值全支持
        effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
        // claude 原生支持全部档位，无需收敛
        maxOutputTokens: 16_384, // 安全默认（个别模型上限更高，但不做白名单）
        maxTokensKey: 'max_tokens', // 走 OpenAI 网关时用
        reasoningEffort: () => null, // claude 走 anthropic 协议不发 reasoning_effort
        thinkingWithEffort: false,
        trimStop: (s) => s,
        emitStreamOptions: true,
        structuredMode: 'json_schema',
        anthropicEffortWire: 'output_config', // 原生支持 output_config.effort
        parallelControl: true, // disable_parallel_tool_use 支持
        echoReasoning: false, // 原生端点无 reasoning_content 回传要求
      }

    case 'gpt':
      // OpenAI gpt/o 系列。platform.openai.com/docs
      return {
        toolUse: true,
        toolChoiceMode: 'named',
        effortValues: ['low', 'medium', 'high'],
        effortMap: { xhigh: 'high', max: 'high' },
        maxTokensKey: 'max_completion_tokens',
        reasoningEffort: openaiEffort,
        thinkingWithEffort: false,
        trimStop: (s) => s,
        emitStreamOptions: true,
        structuredMode: 'json_schema',
        anthropicEffortWire: null, // gpt 不走 anthropic 协议
        parallelControl: true,
        echoReasoning: false,
      }

    case 'grok':
      // xAI Grok 系列。docs.x.ai
      // effort 两处文档矛盾（REST 表仅 4.3 vs 推理指南 4.6 四档）→ 透传 + 400 容错
      return {
        toolUse: true,
        toolChoiceMode: 'named', // tool_choice 四取值全支持
        effortValues: ['low', 'medium', 'high', 'xhigh'],
        maxOutputTokens: 128_000, // 官方默认值（只算可见输出，不含推理 token）
        maxTokensKey: 'max_completion_tokens',
        reasoningEffort: (e) => e, // 透传，400 由降级链处理
        thinkingWithEffort: false,
        trimStop: () => null, // 推理模型 stop 报错
        emitStreamOptions: true,
        structuredMode: 'json_schema',
        anthropicEffortWire: null, // Grok anthropic 端点已完全弃用
        parallelControl: true, // parallel_tool_calls 可关
        echoReasoning: false,
      }

    case 'deepseek':
      // DeepSeek v4 系列。api-docs.deepseek.com
      return {
        toolUse: true,
        // 官方 tool_choice 仅 auto/none/required 三个字符串枚举，无指名工具
        //（CCats 等网关对 anthropic 端点发 type:'tool' 指名会 400）→ required 转 any
        toolChoiceMode: 'required',
        effortValues: ['low', 'high', 'max'],
        effortMap: { medium: 'high', xhigh: 'max' },
        maxOutputTokens: 384_000, // v4-pro 最大输出 384K
        maxTokensKey: 'max_tokens',
        reasoningEffort: trimEffort,
        thinkingWithEffort: true, // thinking + reasoning_effort 双写法
        trimStop: (s) => s,
        emitStreamOptions: true,
        structuredMode: 'json_object', // 无 json_schema
        anthropicEffortWire: 'output_config', // anthropic 端点支持 effort
        parallelControl: false, // 并行恒开不可关 → disable_parallel_tool_use 被忽略
        echoReasoning: true, // 多轮带 tools 时必须完整回传 reasoning_content
      }

    case 'glm': {
      // 智谱 GLM 系列。docs.bigmodel.cn
      const hasEffort = isGlmAtLeast(model, 5, 2)
      return {
        toolUse: true,
        toolChoiceMode: 'auto', // 官方明写"默认且仅支持 auto"
        effortValues: hasEffort ? ['low', 'medium', 'high', 'xhigh', 'max'] : [],
        // GLM 5.2+ 7 档内部折叠：none/minimal=不思考，low/medium→high，xhigh→max
        effortMap: hasEffort ? { medium: 'high', xhigh: 'max' } : undefined,
        maxTokensKey: 'max_tokens',
        // openai 线档位收敛走 trimEffort（与 effortMap 一致）；openaiEffort 会把
        // xhigh/max 压成 high，与 effortMap 的 xhigh→max 矛盾（max 档不可达）
        reasoningEffort: hasEffort ? trimEffort : () => null,
        thinkingWithEffort: false,
        trimStop: (s) => s.slice(0, 1), // 文档冲突，取保守首个
        emitStreamOptions: false, // 无此参数，usage 末 chunk 自带
        structuredMode: 'json_object', // 无 json_schema
        anthropicEffortWire: null, // anthropic 端点零参数级文档 → 保守不发
        parallelControl: false, // 并行控制未声明
        echoReasoning: true, // 有 reasoning_content
      }
    }

    case 'kimi': {
      // 月之暗面 Kimi 系列。platform.kimi.com
      const k3 = isKimiK3(model)
      return {
        toolUse: true,
        // k3 = auto/none/required（指名与思考不兼容）；k2.x 无 required
        toolChoiceMode: k3 ? 'required' : 'auto',
        effortValues: k3 ? ['low', 'high', 'max'] : [],
        effortMap: k3 ? { medium: 'high', xhigh: 'max' } : undefined,
        maxTokensKey: 'max_completion_tokens', // 已弃用 max_tokens
        reasoningEffort: k3 ? trimEffort : () => null,
        thinkingWithEffort: false,
        trimStop: (s) => s.slice(0, 5), // 最多 5 个且各 ≤32 字节
        emitStreamOptions: true,
        structuredMode: 'json_schema', // MFJS 方言，strict 默认 true
        anthropicEffortWire: null, // anthropic 端点零参数级文档 → 保守不发
        parallelControl: true, // 并行工具调用支持
        echoReasoning: true, // 多轮/工具必须原样回传完整 assistant 消息
      }
    }

    default:
      // unknown：保守省略一切可选参数（出问题由降级兜底学习）
      return {
        toolUse: true, // 尝试挂 tools（不支持时 400 由降级兜底）
        toolChoiceMode: 'auto',
        effortValues: [],
        maxTokensKey: 'max_tokens',
        reasoningEffort: () => null,
        thinkingWithEffort: false,
        trimStop: (s) => s,
        emitStreamOptions: true,
        structuredMode: 'none',
        anthropicEffortWire: null,
        parallelControl: false,
        echoReasoning: false,
      }
  }
}
