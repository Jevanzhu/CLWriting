/**
 * 分析师角色 system prompt（方案 §四③；C2 起资源化——文案唯一源 = resources/prompts/analyst.md）。
 *
 * 纯文本，不含工具指令。各 kind 输出契约由 tool_use schema 强制。
 */
import { loadBuiltinPrompt } from './resource.js'

export const ANALYST_SYSTEM = loadBuiltinPrompt('analyst').text
