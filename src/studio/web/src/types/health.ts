/** 体检（对接 GET /api/books/:name/health/metrics + /health/style） */

export interface MetricsReport {
  count: number
  kind: string
  range: { from: number; to: number } | null
  cost: {
    avgCalls: number
    overLimitChapters: number
    tokensNote: string
    avgByStep: { outline: number; draft: number; review: number }
    calibration: { budgetNote: string; accountingNote: string | null }
  }
  review: {
    fullRate: number
    downgradeRate: number
    avgBlockers: number
    topDowngradeReasons: { reason: string; n: number }[]
    lensCoverage: Record<string, number>
    reviewedCount: number
  }
}

export interface StyleTrend {
  kind: string
  count: number
  samples: { num: number; title: string }[]
  dialogueTagSeries: number[]
  varianceSeries: number[]
  repeatSeries: number[]
  overlongChapters: number[]
  adjStackChapters: number[]
  summaryEndingChapters: number[]
  drifts: { metric: string; message: string }[]
  baseline: {
    overall: { dialogueTagRatio: number; sentenceLenVariance: number; repeatRate: number }
  } | null
}
