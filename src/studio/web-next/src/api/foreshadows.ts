import { apiJson } from './client'
import { bookUrl } from './url'

// 伏笔/线索追踪：GET /foreshadows → 结构化列表（fm 字段 + 足迹 + 风险）
// 类型单源 = src/shared/contract/foreshadows.ts（服务端同源注解）。

import type { Foreshadow } from '../../../../shared/contract/foreshadows'
export type { Foreshadow, ForeshadowHit, ForeshadowTrail } from '../../../../shared/contract/foreshadows'

export async function getForeshadows(name: string): Promise<Foreshadow[]> {
  return apiJson<Foreshadow[]>(bookUrl(name, 'foreshadows'))
}
