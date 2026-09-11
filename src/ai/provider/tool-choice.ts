/**
 * tool_choice 意图翻译单源（R0912-D-P3-3，2026-09-12 第十篇独立重评修复批）。
 *
 * 三适配器（openai / anthropic / responses）此前各持一份同构的
 * 「toolChoiceMode × req.toolChoice」分档决策 if 树（openai :188 / anthropic :155 /
 * responses :151 一带），分档口径面临漂移。收敛到本模块：决策只做一次——
 * 输入 quirks 档位 + 请求意图，输出抽象动作；各适配器只留一个「动作 → wire 值」
 * 发射 switch（'required' 字符串 / {type:'any'} / {type:'function',name}）。
 * wire 产出逐字节不变（既有 provider 适配测试守护）。
 */
import type { GenRequest } from './types.js'

export type ToolChoiceAction = 'force-named' | 'force' | 'auto' | 'none'

/** 判别联合：force-named 才带 name（适配器发射点收窄为 string，无需非空断言） */
export type ToolChoiceIntent =
  | { action: 'force-named'; name: string }
  | { action: 'force' }
  | { action: 'auto' }
  | { action: 'none' }

/**
 * 解析 tool_choice 意图（分档决策单源）：
 * - named：强制意图按请求形态分指名（'tool' + toolName）/ 不指名（'any'）；auto 照发。
 * - required（如 kimi k3 指名与思考不兼容 / deepseek anthropic 端点无指名）：强制意图
 *   一律降级为不指名 force；auto 照发。
 * - auto（如 GLM 仅 auto 可用）：仅 auto 意图放行，强制意图不发（prompt 引导 + 契约层
 *   校验重试兜底）。
 * - none：协议不支持 tool_choice——恒 'none'（openai/anthropic 线外层守卫本就整块
 *   跳过；responses 线视图无 none 档，不会走进此分支）。
 * toolChoice 缺省（未挂工具意图）→ 'none'（调用方对 'none' 不发射 wire 值）。
 */
export function resolveToolChoiceIntent(input: {
  toolChoiceMode: 'named' | 'required' | 'auto' | 'none'
  toolChoice?: GenRequest['toolChoice']
  toolName?: string
}): ToolChoiceIntent {
  const { toolChoiceMode, toolChoice, toolName } = input
  if (!toolChoice) return { action: 'none' }
  if (toolChoiceMode === 'named') {
    if (toolChoice === 'any') return { action: 'force' }
    if (toolChoice === 'tool' && toolName) return { action: 'force-named', name: toolName }
    if (toolChoice === 'auto') return { action: 'auto' }
    return { action: 'none' } // 'tool' 无 toolName → 不发（与原三分支树一致）
  }
  if (toolChoiceMode === 'required') {
    if (toolChoice === 'any' || toolChoice === 'tool') return { action: 'force' }
    if (toolChoice === 'auto') return { action: 'auto' }
    return { action: 'none' }
  }
  if (toolChoiceMode === 'auto') {
    if (toolChoice === 'auto') return { action: 'auto' }
    return { action: 'none' } // 'any'/'tool' → 不支持，不发（prompt 引导 + 契约层校验重试兜底）
  }
  return { action: 'none' } // toolChoiceMode 'none'
}
