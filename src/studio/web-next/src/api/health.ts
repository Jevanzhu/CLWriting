// 健康面客户端：GET /api/books/:name/health/event-store（事件库体积读数）。
// 阈值与超阈标记由服务端按单源判据算好透出（服务端 health.ts 读 events/store-retention 的
// 阈值导出），前端只消费标记与阈值原值，不在此另算一份体积阈值。
// 文风体检（health/style）的客户端仍住 api/style.ts——那边是文风域数据，非体积诊断面。
import { apiJson } from './client'
import { bookUrl } from './url'

/** 事件库体积读数（服务端字段同源）。 */
export interface EventStoreFootprint {
  /** 主库文件字节数；null = 数据目录未配置 / 库文件不在位 / 读取失败（体积面空态） */
  bytes: number | null
  /** 超阈标记（服务端判定） */
  overThreshold: boolean
  /** 超阈判据的字节阈值（服务端同一单源），用于渲染人话指引 */
  warnThresholdBytes: number
}

/** 字段缺省（2xx 坏体）恒归一为「读数缺省」空态，调用方无需再判空。 */
const NO_READING: EventStoreFootprint = { bytes: null, overThreshold: false, warnThresholdBytes: 0 }

export async function getEventStoreFootprint(name: string): Promise<EventStoreFootprint> {
  const r = await apiJson<{ ok: true; eventStore?: EventStoreFootprint }>(bookUrl(name, 'health', 'event-store'))
  return r.eventStore ?? NO_READING
}
