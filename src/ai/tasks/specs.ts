/**
 * 7 条 AI 链路的 TaskSpec 声明（A1 声明化）。
 *
 * 每条链路的五件套（system/tool/tier/mock/genMode）收成一处声明。
 * 动态参数（如 kind、lens、role）通过工厂函数处理。
 *
 * 调用方不再手抄样板，改用 `runSpec(spec, opts)`。
 */
import type { TaskSpec } from './spec.js'
import { REWRITER_SYSTEM, writerSystem } from '../prompts/index.js'
import { ANALYST_SYSTEM } from '../prompts/analyst.js'
import { reviewSystem } from '../prompts/review.js'
import {
  submitText,
  chapterTool,
  chapterToolName,
} from '../contract/index.js'
import { submitAnalysis, analysisToolName, type AnalysisKind } from '../contract/analysis.js'
import { submitIssues, ISSUES_TOOL_NAME } from '../contract/review.js'

// ─── 文本型（generate，无工具） ───────────────────────────────────────

/** mock 快路的固定产出 */
const MOCK_OUTLINE = '## mock 细纲\n\n- 场景：叙事铺陈\n- 情节骨架：开篇→发展→章尾钩'
const MOCK_ONBOARD = '## mock 设定\n\n这是 mock 的模拟设定产出。'

/** 大纲生成（纯文本，prompt 自含任务说明） */
export const OUTLINE_SPEC: TaskSpec = {
  name: 'outline',
  tierKind: 'creative',
  genMode: 'text',
  systemPrompt: '',
  mock: { kind: 'text', text: MOCK_OUTLINE },
}

/** 开书引导（纯文本，prompt 自含任务说明） */
export const ONBOARD_SPEC: TaskSpec = {
  name: 'onboard',
  tierKind: 'creative',
  genMode: 'text',
  systemPrompt: '',
  mock: { kind: 'text', text: MOCK_ONBOARD },
}

/**
 * 流式写稿工厂（role 决定 system prompt）。
 *
 * stream 端点的 mock 走独立事件序列（不走 runTask mock 快路），
 * 故 spec 不含 mock 配置。
 */
export function streamSpec(role: string, kind: 'long' | 'short'): TaskSpec {
  return {
    name: 'spawn-write',
    tierKind: 'creative',
    genMode: 'text',
    systemPrompt: role === 'writer' ? writerSystem(kind) : '',
  }
}

// ─── 工具型（generateTool，结构化产出） ──────────────────────────────

/** 改写（submit_text 工具） */
export const REWRITE_SPEC: TaskSpec = {
  name: 'rewrite',
  tierKind: 'creative',
  genMode: 'tool',
  systemPrompt: REWRITER_SYSTEM,
  tool: { def: submitText(), name: 'submit_text' },
  mock: { kind: 'tool', toolName: 'submit_text' },
}

/** 三审（submit_issues 工具，逐 lens 切换 system prompt） */
export function reviewSpec(lens: string): TaskSpec {
  return {
    name: 'review',
    tierKind: 'assistant',
    genMode: 'tool',
    systemPrompt: reviewSystem(lens),
    tool: { def: submitIssues(), name: ISSUES_TOOL_NAME },
    mock: { kind: 'tool', toolName: ISSUES_TOOL_NAME },
  }
}

/** 分析（submit_analysis 工具，kind 决定 tool/system） */
export function analysisSpec(kind: AnalysisKind): TaskSpec {
  return {
    name: 'analysis',
    tierKind: 'assistant',
    genMode: 'tool',
    systemPrompt: ANALYST_SYSTEM,
    tool: { def: submitAnalysis(kind), name: analysisToolName(kind) },
    mock: { kind: 'tool', toolName: analysisToolName(kind) },
  }
}

/** 写稿 self-heal（submit_chapter/piece 工具，kind 决定 tool/system） */
export function selfHealSpec(kind: 'long' | 'short'): TaskSpec {
  return {
    name: 'self-heal',
    tierKind: 'creative',
    genMode: 'tool',
    systemPrompt: writerSystem(kind),
    tool: { def: chapterTool(kind), name: chapterToolName(kind) },
    mock: { kind: 'tool', toolName: chapterToolName(kind) },
  }
}
