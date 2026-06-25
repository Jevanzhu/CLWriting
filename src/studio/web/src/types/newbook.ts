/** 建书段 2 AI 填设定（对接 POST /api/books/:name/onboard-ai） */

export type OnboardStepKey =
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

export interface OnboardResult {
  path: string
  words: number
  content: string
}

export interface OnboardStep {
  key: OnboardStepKey
  label: string
  running: boolean
  result: OnboardResult | null
  skipped?: boolean
}
