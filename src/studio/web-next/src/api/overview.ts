import { apiJson } from './client'
import { bookUrl } from './url'

// 总览（细案 §2.3 T4.1）：GET /overview → 身份/进度/状态机/卷结构/写作热力。
// 长短篇按 identity.kind 分流：长篇 volumes+words 实质，短篇 volumes=[] words=0。
// 类型单源 = src/shared/contract/overview.ts（服务端 payload 同源注解）。

import type { OverviewResult } from '../../../../shared/contract/overview'
export type { OverviewResult } from '../../../../shared/contract/overview'

export async function getOverview(name: string): Promise<OverviewResult> {
  return apiJson<OverviewResult>(bookUrl(name, 'overview'))
}
