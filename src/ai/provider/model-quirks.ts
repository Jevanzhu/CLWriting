/**
 * 模型系列参数表——唯一真相源（表驱动重构 §五）。
 *
 * 两个维度：
 * - 能力维度——模型支持什么（toolUse / toolChoiceMode / effort / structured）
 * - 线格式维度——各协议下的小参数写法（maxTokensKey / anthropicEffortWire / ...）
 *
 * 原则：检测不出系列 → 保守省略一切可选参数；**不做模型白名单**，
 * 永不拦截用户选任何模型（分发产品原则）。
 * 每项字段注释附官方文档出处（effort 值域调研 2026-08-14 定稿）。
 */
import type { EffortLevel } from './types.js'
import { modelIdKeys } from './normalize.js'

export type ModelFamily = 'claude' | 'gpt' | 'grok' | 'deepseek' | 'glm' | 'kimi' | 'unknown'

/** 单个键形态上的前缀判定（不做白名单，识别不出即 unknown → 保守省略） */
function familyByPrefix(m: string): ModelFamily {
  if (/^(gpt-|o\d|chatgpt-)/i.test(m)) return 'gpt'
  if (/^grok/i.test(m)) return 'grok'
  if (/^deepseek/i.test(m)) return 'deepseek'
  if (/^glm/i.test(m)) return 'glm'
  // kimi 现役 k3/k2.x（平台模型 ID 可能不带 kimi 前缀，如 "k3"）
  if (/^(kimi|moonshot|k\d)/i.test(m)) return 'kimi'
  if (/^claude/i.test(m)) return 'claude'
  return 'unknown'
}

/**
 * 判定系列——三键解析（批次 D3，学 cherry findModel「精确 → 保留尺寸 → 尺寸无关」）：
 * 原文前缀 → 带尺寸归一键 → 尺寸无关键。归一道解决组织前缀 / 冒号尺寸 / 大小写
 * 变体（`zai-org/glm-4.7`、`gpt-oss:20b`、`deepseek-ai/deepseek-chat`）。
 * 三道全不中 → unknown（宁缺勿错：错误系列比无元数据更糟——参数面发错会 400）。
 */
export function detectFamily(model: string): ModelFamily {
  const { raw, sized, norm } = modelIdKeys(model)
  for (const key of [raw, sized, norm]) {
    const f = familyByPrefix(key)
    if (f !== 'unknown') return f
  }
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
 * Responses 线（/v1/responses）格式档——家族表内嵌子表（Responses 启用批 R2a）。
 *
 * 必须保持**纯数据**（无函数维度）：catalog.ts 探测白名单不含本子表，
 * 塞函数会迫使目录维度扩列 + 重新生成 catalog.gen.ts（catalog-sync 双向校验红线）。
 * 设计定型「格式级 profile × 家族覆盖」（cherry reasoningProfiles 同构），出处见
 * 《Responses格式适配》设计第六节。
 */
export interface ResponsesWireQuirks {
  /** 三值语义同 FamilyQuirks.toolChoiceMode（responsesWire 视图覆盖基表值），无 'none'——协议本身有 tool_choice */
  toolChoiceMode: 'named' | 'required' | 'auto'
  /** effort 落点：openai reasoning:{effort} / grok 顶层 reasoning_effort / deepseek output_config:{effort} */
  effortWire: 'reasoning-effort' | 'reasoning_effort' | 'output_config'
  /** 结构化输出档位（json_object/none 不发 text.format，prompt 约束兜底） */
  structuredMode: 'json_schema' | 'json_object' | 'none'
  /** 多轮工具调用的推理延续（缺口 11）：encrypted=回传加密推理项；strip=剥除；none=未测不发 */
  echoReasoning: 'encrypted' | 'strip' | 'none'
  /** Responses 独有 text.verbosity 支持（缺口 13，留位不发——true 的家未来才可能发） */
  verbosity: boolean
  /** max_output_tokens 是否含推理 token（缺口 8，grok=true；首版只标记不换算，reasoningTokens 观测积累后另批定） */
  maxTokensIncludesReasoning: boolean
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
   *  none    = 该线无此参数（保留枚举位防生成物 schema 漂移；Responses 线有 tool_choice，
   *            由 responsesWire 子表接管，不落此值）
   */
  toolChoiceMode: 'named' | 'required' | 'auto' | 'none'
  /**
   * 档位收敛映射（wire 查表，学 cherry-studio effortMap）。
   * 2026-08-14 定稿：仅 deepseek 有特例映射（anthropic 线真消费）；
   * 其余厂家全透传，不预演官方折叠（服务端行为）。
   */
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
  /** Responses 线（/v1/responses）格式档——只对 openai-responses 协议生效，Chat/Anthropic 线不读 */
  responsesWire: ResponsesWireQuirks
}

// ── 档位映射工具 ──

/**
 * DeepSeek 专用 wire 收敛（2026-08-14 定稿唯一特例）。
 * 出处：cherry-studio deepseek 特例——官方 thinking_mode 折叠 medium/xhigh→high，
 * cherry 有意发 max 直达顶档（注释 "leaving max as the only way to reach the top
 * level"），故 wire 上 medium→high、xhigh→max。其余厂家全透传，不预演折叠。
 */
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
        // effort 五档全收（docs.anthropic.com），anthropic 线 output_config 原生透传
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
        responsesWire: FALLBACK_RESPONSES_WIRE, // claude 无 /v1/responses 端点，中转转发场景按 unknown 保守
      }

    case 'gpt':
      // OpenAI gpt/o 系列。platform.openai.com/docs
      return {
        toolUse: true,
        toolChoiceMode: 'named',
        // effort 七档全收（platform.openai.com guide ReasoningEffort），客户端全透传不预演
        maxTokensKey: 'max_completion_tokens',
        reasoningEffort: (e) => e,
        thinkingWithEffort: false,
        trimStop: (s) => s,
        emitStreamOptions: true,
        structuredMode: 'json_schema',
        anthropicEffortWire: null, // gpt 不走 anthropic 协议
        parallelControl: true,
        echoReasoning: false,
        responsesWire: {
          toolChoiceMode: 'named',
          effortWire: 'reasoning-effort',
          structuredMode: 'json_schema',
          // codex 后端强制 include encrypted_content + reasoning item 回传（cherry codex.ts 印证）
          echoReasoning: 'encrypted',
          verbosity: true, // Responses 独有 text.verbosity（留位不发）
          maxTokensIncludesReasoning: false, // 待核实（观测 reasoningTokens 后定，缺口 8）
        },
      }

    case 'grok':
      // xAI Grok 系列。docs.x.ai
      // effort 两处文档矛盾（REST 表仅 4.3 vs 推理指南 4.6 四档）→ 透传 + 400 容错
      return {
        toolUse: true,
        toolChoiceMode: 'named', // tool_choice 四取值全支持
        // effort 四档透传（docs.x.ai reasoning guide，4.5 收 xhigh 当 high 不 400）
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
        responsesWire: {
          toolChoiceMode: 'named',
          effortWire: 'reasoning_effort', // 顶层参数（与 Chat 线同款）
          structuredMode: 'json_schema',
          // CLI 代理语义（拒绝回传 reasoning item，cherry grokCli.ts 剥除处理）；官方线实测后翻档
          echoReasoning: 'strip',
          verbosity: false,
          maxTokensIncludesReasoning: true, // 含推理 token（官方文档：上限计入推理消耗）
        },
      }

    case 'deepseek':
      // DeepSeek v4 系列。api-docs.deepseek.com
      return {
        toolUse: true,
        // 官方 tool_choice 仅 auto/none/required 三个字符串枚举，无指名工具
        //（CCats 等网关对 anthropic 端点发 type:'tool' 指名会 400）→ required 转 any
        toolChoiceMode: 'required',
        // 唯一 effort 特例（cherry 出处见 trimEffort）：official thinking_mode
        // 折叠 medium/xhigh→high，wire 有意发 medium→high、xhigh→max
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
        responsesWire: {
          toolChoiceMode: 'required', // /v1/responses 同样无指名
          effortWire: 'output_config',
          structuredMode: 'json_object', // 不发 text.format，避免首发 400 再降级（缺口 7）
          echoReasoning: 'none', // 未测（缺口 16），首版不发
          verbosity: false,
          maxTokensIncludesReasoning: false, // 待核实
        },
      }

    case 'glm': {
      // 智谱 GLM 系列。docs.bigmodel.cn
      const hasEffort = isGlmAtLeast(model, 5, 2)
      return {
        toolUse: true,
        toolChoiceMode: 'auto', // 官方明写"默认且仅支持 auto"
        // GLM 5.2+ 官方 7 档内部折叠（docs.bigmodel.cn concept-param：low/medium→high、
        // xhigh→max、none/minimal=不思考）——折叠是服务端行为，客户端全透传不预演
        maxTokensKey: 'max_tokens',
        reasoningEffort: hasEffort ? (e) => e : () => null,
        thinkingWithEffort: false,
        trimStop: (s) => s.slice(0, 1), // 文档冲突，取保守首个
        emitStreamOptions: false, // 无此参数，usage 末 chunk 自带
        structuredMode: 'json_object', // 无 json_schema
        anthropicEffortWire: null, // anthropic 端点零参数级文档 → 保守不发
        parallelControl: false, // 并行控制未声明
        echoReasoning: true, // 有 reasoning_content
        responsesWire: FALLBACK_RESPONSES_WIRE, // GLM 官方无 /v1/responses（设计第二节支持面）
      }
    }

    case 'kimi': {
      // 月之暗面 Kimi 系列。platform.kimi.com
      const k3 = isKimiK3(model)
      return {
        toolUse: true,
        // k3 = auto/none/required（指名与思考不兼容）；k2.x 无 required
        toolChoiceMode: k3 ? 'required' : 'auto',
        // k3 官方未声明折叠方向（platform.kimi.ai）→ 客户端全透传
        maxTokensKey: 'max_completion_tokens', // 已弃用 max_tokens
        reasoningEffort: k3 ? (e) => e : () => null,
        thinkingWithEffort: false,
        trimStop: (s) => s.slice(0, 5), // 最多 5 个且各 ≤32 字节
        emitStreamOptions: true,
        structuredMode: 'json_schema', // MFJS 方言，strict 默认 true
        anthropicEffortWire: null, // anthropic 端点零参数级文档 → 保守不发
        parallelControl: true, // 并行工具调用支持
        echoReasoning: true, // 多轮/工具必须原样回传完整 assistant 消息
        responsesWire: FALLBACK_RESPONSES_WIRE, // Kimi 官方无 /v1/responses（设计第二节支持面）
      }
    }

    default:
      // unknown：保守省略一切可选参数（出问题由降级兜底学习）
      return {
        toolUse: true, // 尝试挂 tools（不支持时 400 由降级兜底）
        toolChoiceMode: 'auto',
        maxTokensKey: 'max_tokens',
        reasoningEffort: () => null,
        thinkingWithEffort: false,
        trimStop: (s) => s,
        emitStreamOptions: true,
        structuredMode: 'none',
        anthropicEffortWire: null,
        parallelControl: false,
        echoReasoning: false,
        responsesWire: FALLBACK_RESPONSES_WIRE,
      }
  }
}

/** Responses 线保守兜底档——unknown 家族 / 无 /v1/responses 官方端点的家族共用 */
const FALLBACK_RESPONSES_WIRE: ResponsesWireQuirks = {
  toolChoiceMode: 'auto', // 非 auto 意图不发（prompt 引导 + 契约层校验重试兜底）
  effortWire: 'reasoning-effort',
  structuredMode: 'none',
  echoReasoning: 'strip',
  verbosity: false,
  maxTokensIncludesReasoning: false,
}

/**
 * responses 协议视图（Responses 启用批 R2a，缺口 5「gen 层静默丢弃」消除）：
 * 基表 + responsesWire 覆盖 toolChoiceMode / structuredMode 并挂子表。
 *
 * gen 层意图翻译与适配器 toParams 都走本视图——Chat/Anthropic 线走 quirksFor
 * （签名与行为不动，零风险）；本函数只被 openai-responses 协议的调用方触达。
 */
export function responsesQuirksFor(model: string): FamilyQuirks & { responsesWire: ResponsesWireQuirks } {
  const base = quirksFor(model)
  return {
    ...base,
    toolChoiceMode: base.responsesWire.toolChoiceMode,
    structuredMode: base.responsesWire.structuredMode,
  }
}
