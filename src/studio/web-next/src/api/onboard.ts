import { apiJson } from './client'

// onboard 开书对话（细案 §2.2 + 服务端 onboard.ts）：分步 AI 生成设定 + 落盘。
// 长篇 9 步 + 短篇 2 步；realm 仅成长线书（服务端校验）。

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
  | 'collection-pitch'
  | 'first-outline'

export const STEP_LABEL: Record<OnboardStep, string> = {
  synopsis: '总纲',
  characters: '人物名册',
  world: '世界观',
  realm: '境界体系',
  volume: '卷纲',
  'leads-seed': '账本种子',
  'style-sample': '样章库',
  'style-rules': '文风铁律',
  'style-quotes': '金句库',
  'collection-pitch': '集子定位',
  'first-outline': '首篇细纲',
}

export interface OnboardAiResult {
  ok: true
  step: string
  path: string
  words: number
  content: string
}

// POST /onboard-ai {step, discussionContext?}（AI 阻塞数十秒，spawnRole onboard 收 text 落盘 + 返回 content）
export async function onboardAi(
  name: string,
  body: { step: OnboardStep; discussionContext?: string },
): Promise<OnboardAiResult> {
  return apiJson<OnboardAiResult>(`/api/books/${encodeURIComponent(name)}/onboard-ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
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
