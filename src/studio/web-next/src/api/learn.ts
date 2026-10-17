import { apiJson } from './client'
import { bookUrl } from './url'

// 文风收割 API：类型单源 = src/shared/contract/learn.ts（服务端同源注解）。
// learn 是规则打分（借 #10 机检），**不涉大模型**——无 AI 可达性问题，始终可用。

import type { LearnCommitResult, LearnResult, QuoteCandidate, SampleCandidate } from '../../../../shared/contract/learn'
export type SampleCandidateFE = SampleCandidate
export type QuoteCandidateFE = QuoteCandidate

/** 收割候选（扫定稿正文 → 段落分块 + #10 打分 + 场景预归类 → 候选） */
export async function runLearn(name: string): Promise<LearnResult> {
  // 扫全部定稿章打分，大书可能 10-30s；无超时则 loading 永转
  return apiJson<LearnResult>(bookUrl(name, 'learn'), { method: 'POST' }, 60_000)
}

/** 入库勾选候选（作者勾选才入库；品味归人，不自动入库） */
export async function runLearnCommit(
  name: string,
  body: { samples: SampleCandidateFE[]; quotes: QuoteCandidateFE[] },
): Promise<LearnCommitResult> {
  // 入库为纯文件写（候选已在内存），但兜底超时仍须与收割同档
  // 60s——无超时的请求挂死时调用方 loading 永转（大书候选 payload 大，弱机慢盘同受
  // 10-30s 量级影响，与 runLearn 同口径）
  return apiJson<LearnCommitResult>(bookUrl(name, 'learn-commit'), { method: 'POST', json: body }, 60_000)
}
