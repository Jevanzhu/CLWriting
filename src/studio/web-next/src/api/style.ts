import { apiJson } from './client'
import { bookUrl } from './url'

// 文风系统 API：类型单源 = src/shared/contract/style.ts（服务端同源注解）。
// 条目库/候选箱/收割/定标全零 AI；AI 语义分析走 api/analysis.ts
//（源3 由后端 analyze-style 完成时自动落候选，前端无需另调）。

import type {
  EntryKind,
  EntrySource,
  StyleBaselineSummary,
  StyleCandidate,
  StyleConfig,
  StyleEntry,
  StyleMigration,
  StyleTrend,
} from '../../../../shared/contract/style'
export type EntryKindFE = EntryKind
export type EntrySourceFE = EntrySource
export type StyleEntryFE = StyleEntry & { _path: string }
export type StyleCandidateFE = StyleCandidate & { _path: string }
export type StyleMigrationFE = StyleMigration
export type StyleBaselineSummaryFE = StyleBaselineSummary
export type StyleConfigFE = StyleConfig
export type StyleTrendFE = StyleTrend
export type { StyleCandidatesResult, StyleEntriesResult } from '../../../../shared/contract/style'

function base(name: string): string {
  return bookUrl(name, 'style')
}

export async function listStyleEntries(
  name: string,
): Promise<{ entries: StyleEntryFE[]; errors: unknown[]; migration: StyleMigrationFE | null }> {
  return apiJson(`${base(name)}/entries`)
}

export async function addStyleEntry(
  name: string,
  entry: { 类型: EntryKindFE; 正文: string; 场景?: string; 说明?: string; 出处?: string; 标签?: string[] },
): Promise<{ path: string }> {
  return apiJson(`${base(name)}/entries`, {
    method: 'POST',
    json: entry,
  })
}

export async function deleteStyleEntry(name: string, path: string): Promise<void> {
  await apiJson(`${base(name)}/entries`, {
    method: 'DELETE',
    json: { path },
  })
}

export async function listStyleCandidates(
  name: string,
): Promise<{ candidates: StyleCandidateFE[]; errors: unknown[] }> {
  return apiJson(`${base(name)}/candidates`)
}

export async function confirmStyleCandidate(name: string, path: string): Promise<{ entryPath: string }> {
  return apiJson(`${base(name)}/candidates/confirm`, {
    method: 'POST',
    json: { path },
  })
}

export async function ignoreStyleCandidate(name: string, path: string): Promise<void> {
  await apiJson(`${base(name)}/candidates/ignore`, {
    method: 'POST',
    json: { path },
  })
}

/** 收割（零 AI）：源1 改稿轨迹比对 + 源2 机检漂移映射 → 候选箱 */
export async function runStyleHarvest(name: string): Promise<{ created: number; skipped: number }> {
  // 全文轨迹比对 CPU 密集，大书可能 10-30s；无超时则 loading 永转
  return apiJson(`${base(name)}/harvest`, { method: 'POST' }, 60_000)
}

export async function getStyleConfig(name: string): Promise<StyleConfigFE> {
  return apiJson(`${base(name)}/config`)
}

export async function freezeStyleBaseline(name: string): Promise<{ baseline: StyleBaselineSummaryFE }> {
  return apiJson(`${base(name)}/baseline/freeze`, { method: 'POST' })
}

/** 机检重扫（零 AI，按需全量重算；复用体检报告同源端点） */
export async function getStyleTrend(name: string): Promise<StyleTrendFE> {
  return apiJson(bookUrl(name, 'health', 'style'))
}
