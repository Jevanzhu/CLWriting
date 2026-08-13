import { apiJson } from './client'

// onboard 开书对话（细案 §2.2 + 服务端 onboard.ts）：分步 AI 生成设定 + 落盘。
// 长篇 9 步 + 短篇 1 步；realm 仅成长线书（服务端校验）。

export type OnboardStep =
  | 'synopsis'
  | 'characters'
  | 'world'
  | 'realm'
  | 'volume'
  | 'leads-seed'
  | 'style-sample'
  | 'style-rules'
  | 'style-quotes'
  | 'first-outline'

export const STEP_LABEL: Record<OnboardStep, string> = {
  synopsis: '总纲',
  characters: '人物名册',
  world: '世界观',
  realm: '境界体系',
  volume: '卷纲',
  'leads-seed': '线索种子',
  'style-sample': '样章库',
  'style-rules': '文风铁律',
  'style-quotes': '金句库',
  'first-outline': '首章细纲',
}

/** 各步落盘路径（与后端 STEP_PATH 对齐，用于「已生成」判定）。 */
export const STEP_PATH: Record<OnboardStep, string> = {
  synopsis: '大纲/总纲.md',
  characters: '设定/名册.md',
  world: '设定/世界观.md',
  realm: '设定/境界体系.md',
  volume: '大纲/卷纲/卷纲_第1卷.md',
  'leads-seed': '大纲/账本种子.md',
  'style-sample': '文风/样章库.md',
  'style-rules': '文风/文风铁律.md',
  'style-quotes': '文风/金句库.md',
  'first-outline': '大纲/首章细纲.md',
}

/** 各步描述（面向作者：这个步骤会生成什么内容）。 */
export const STEP_DESC: Record<OnboardStep, string> = {
  synopsis: '全书总纲。核心主线一句话、主角设定、世界观概要、明暗双线、全书最大反转靶心、第一卷定位。',
  characters: '首批 3-5 个主角角色卡。每角含身份、动机、外貌、性格、弧光（成长轨迹），覆盖正反、师友、敌对。',
  world: '世界观设定。力量体系（修炼法门）、社会结构（势力/组织/阶层）、核心规则（运转法则/禁忌）。',
  realm: '境界进阶链（低→高）。每境界一句话特征，高层留余地。仅成长线书可用。',
  volume: '第一卷卷纲。主线阶段、核心冲突、角色登场顺序、章数预估（30-50 章）、卷末钩子。',
  'leads-seed': '线索种子。各类初始线（悬念/感情线等），每条含开启章、线索摘要、预期回收章。',
  'style-sample': '文风样章库。5 场景（战斗/对话/抒情/铺陈/爽点）各 200-400 字，供写章时文风对齐。',
  'style-rules': '文风铁律。正文规范、对话标签占比上限、句长方差、重复率上限、题材专属禁忌。',
  'style-quotes': '金句库。20-30 条题材典型金句（角色台词/叙事金句），供写章时点缀。',
  'first-outline': '首章细纲。目标情绪、核心反转、五段结构、伏笔回收、字数预估。',
}

export interface OnboardAiResult {
  ok: true
  step: string
  path: string
  words: number
  content: string
}

// POST /onboard-ai {step, premise?, discussionContext?}（AI 阻塞数十秒，spawnRole onboard 收 text 落盘 + 返回 content）
export async function onboardAi(
  name: string,
  body: { step: OnboardStep; premise?: string; discussionContext?: string },
): Promise<OnboardAiResult> {
  return apiJson<OnboardAiResult>(`/api/books/${encodeURIComponent(name)}/onboard-ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 180_000) // AI 开书对话超时 3 分钟
}

// POST /onboard-save {step, content}（作者预览改后落盘）
export async function onboardSave(
  name: string,
  body: { step: OnboardStep; content: string },
): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/onboard-save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
