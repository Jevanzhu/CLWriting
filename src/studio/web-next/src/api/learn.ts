import { apiJson } from './client'

// 文风收割 API（M12 后置 · learn 候选制）：镜像后端 learn/index.ts + knowledge.ts 契约。
// learn 是规则打分（借 #10 机检），**不涉大模型**——无 AI 可达性问题，始终可用。

/** 样章候选（镜像 learn/index.ts SampleCandidate） */
export interface SampleCandidateFE {
  /** 拟定场景（作者审核时确认/改归） */
  场景: string
  /** 正文片段 */
  正文: string
  /** 出处：《书名》第 N 章 */
  出处: string
  /** 章号 */
  章号: number
  /** 打分（0-100，借 #10 机检） */
  打分: number
  /** 技法指令（可空） */
  技法指令?: string
}

/** 金句候选（镜像 learn/index.ts QuoteCandidate） */
export interface QuoteCandidateFE {
  场景: string
  正文: string
  出处: string
  章号: number
}

/** 收割结果（POST /learn 响应） */
export interface LearnResultFE {
  samples: SampleCandidateFE[]
  quotes: QuoteCandidateFE[]
}

/** 入库结果（POST /learn-commit 响应） */
export interface LearnCommitResultFE {
  ok: true
  sampleFiles: string[]
  quoteFiles: string[]
}

/** 收割候选（扫定稿正文 → 段落分块 + #10 打分 + 场景预归类 → 候选） */
export async function runLearn(name: string): Promise<LearnResultFE> {
  return apiJson<LearnResultFE>(`/api/books/${encodeURIComponent(name)}/learn`, { method: 'POST' })
}

/** 入库勾选候选（作者勾选才入库；品味归人，不自动入库） */
export async function runLearnCommit(
  name: string,
  body: { samples: SampleCandidateFE[]; quotes: QuoteCandidateFE[] },
): Promise<LearnCommitResultFE> {
  return apiJson<LearnCommitResultFE>(
    `/api/books/${encodeURIComponent(name)}/learn-commit`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
}
