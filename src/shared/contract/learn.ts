/**
 * 文风收割回包契约（前端 api/learn.ts 与服务端 learn 端点共用）。
 *
 * 服务端权威类型 = src/learn/index.ts 的 SampleCandidate / QuoteCandidate；收敛结果
 * 只回 samples/quotes 两数组（LearnResult 的计数/目录字段不下发）。漂移由
 * learn.conformance.ts 钉住。
 */

export interface SampleCandidate {
  /** 拟定场景（作者审核时确认/改归）。 */
  场景: string
  /** 正文片段。 */
  正文: string
  /** 出处：《书名》第 N 章。 */
  出处: string
  /** 章号。 */
  章号: number
  /** 打分（0-100）。 */
  打分: number
  /** 技法指令（可空）。 */
  技法指令?: string
}

export interface QuoteCandidate {
  场景: string
  正文: string
  出处: string
  章号: number
}

/** POST /learn 回包。 */
export interface LearnResult {
  samples: SampleCandidate[]
  quotes: QuoteCandidate[]
}

/** POST /learn-commit 回包。 */
export interface LearnCommitResult {
  ok: true
  sampleFiles: string[]
  quoteFiles: string[]
}
