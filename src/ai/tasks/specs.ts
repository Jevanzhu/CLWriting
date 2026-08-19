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
import { submitRelations, RELATIONS_TOOL_NAME } from '../contract/relations.js'
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

/** 账本推进声明（W-P1-3 右端：写稿后 AI 声明本章实际写入的履历行，作者确认后 finalize 回写） */
export const LEAD_UPDATE_SPEC: TaskSpec = {
  name: 'lead-updates',
  tierKind: 'creative',
  genMode: 'text',
  systemPrompt: '',
  mock: { kind: 'text', text: '- 悬念-001 递进：山门外的钟声在雨夜里连响了三下。' },
}

/** 章摘要生成（C1 批 2）：定稿即生成 / 自愈按需补漏共用；低档廉价调用 */
export const SUMMARY_CHAPTER_SPEC: TaskSpec = {
  name: 'summary-chapter',
  tierKind: 'assistant',
  genMode: 'text',
  systemPrompt: `你是网文章节摘要器。为给定章节写金字塔式章摘要，供后续章节备料与规划使用。

## 要求
- 严格三行，每行一个维度，前缀照抄：
  - 情节推进：
  - 账本变动：
  - 章尾钩子：
- 只依据给定正文，不臆造、不评论、不复述全文。
- 每行一句以内，总长遵守调用方给的字数上限。
- 直接输出三行，不加标题、不加多余说明。`,
  mock: { kind: 'text', text: '- 情节推进：林远初入宗门，玉佩初显异象。\n- 账本变动：无。\n- 章尾钩子：血中之物苏醒在即。' },
}

/** 卷摘要生成（C2 批 3）：从该卷已有章摘要链现场生成，备料 rank-3 段 / 细纲卷进展共用 */
export const SUMMARY_VOLUME_SPEC: TaskSpec = {
  name: 'summary-volume',
  tierKind: 'assistant',
  genMode: 'text',
  systemPrompt: `你是网文卷级摘要器。把给定的一卷章摘要链压缩成一份卷摘要，供远期备料与规划使用。

## 要求
- 覆盖本卷的主线推进、关键转折、开线/收线，一段到三段以内。
- 只依据给定章摘要，不臆造、不补充新信息。
- 总长遵守调用方给的字数上限。
- 直接输出卷摘要正文，不加标题、不加多余说明。`,
  mock: { kind: 'text', text: '本卷：林远入宗历练，玉佩之谜初启，与长老一脉结怨；悬念-001 埋下并推进一次；卷尾宗门大比在即。' },
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

/** 写稿 self-heal（submit_chapter 工具，kind 只决定 system prompt） */
export function selfHealSpec(kind: 'long' | 'short'): TaskSpec {
  return {
    name: 'self-heal',
    tierKind: 'creative',
    genMode: 'tool',
    systemPrompt: writerSystem(kind),
    tool: { def: chapterTool(), name: chapterToolName() },
    mock: { kind: 'tool', toolName: chapterToolName() },
  }
}

// ─── 对话（不走 runSpec，编排器持元数据直调 runTask） ──────────────────

/**
 * 对话助手声明——第 8 条 TaskSpec。
 *
 * **执行不走 runSpec**：agent 循环要传累积的 messages 数组（含 tool_use/tool_result block），
 * 超出 SpecOpts 单发 userPrompt 模型。编排器持此 spec 的 name/tierKind 元数据直调 runTask。
 * systemPrompt 由编排器在运行时用 chatSystem(ctx) 动态构建，此处留空。
 */
export const CHAT_SPEC: TaskSpec = {
  name: 'chat',
  tierKind: 'chat',
  genMode: 'text',
  systemPrompt: '',
}

// ─── 关系图梳理（工具型，submit_relations） ───────────────────────────

/** 关系图梳理（submit_relations 工具，AI 通读材料提炼关系边） */
export const RELATION_MINE_SPEC: TaskSpec = {
  name: 'relation-mine',
  tierKind: 'assistant',
  genMode: 'tool',
  systemPrompt: `你是资深网文关系分析师。通读提供的角色名册、角色卡与正文节选,提炼角色之间的关系网络。

## 要求
- 只提取材料中**有依据**的关系,不臆造;依据不足的关系不输出。
- 关系类型用**完整有区分度的短语**(师徒/仇敌/旧时婚约/挚友/道侣/血契/主仆…),**不用单字**(师/敌/友)。
- 书名/材料之外的角色不输出;姓名须与材料一致。
- 特有关系按材料原义命名(如「旧约」「暗棋」),若材料已给全称/说明则用全称。
- 覆盖主角与其他角色的主要关系,以及材料中展开的次要关系(含正文透露的隐含关系)。
- note 可写一句话依据(哪段材料/什么事实)。

## 输出
通过 submit_relations 工具提交关系数组,不要作为普通文本输出。`,
  tool: { def: submitRelations(), name: RELATIONS_TOOL_NAME },
  mock: { kind: 'tool', toolName: RELATIONS_TOOL_NAME },
}
