/**
 * 书配置契约——两端必须一致理解的那部分（书级别 `book.yaml`）。
 *
 * 为什么只收这几项而不是整份 `BookConfig`：前端那份是**写侧视图**（PUT 要求整文件写回，
 * 但读到的配置常常只被消费其中几个键），整份镜像过去会让每个可选键的两端差异都需要一次
 * 冗余声明；而收进来的这几项是**读侧功能真正依赖**的键——成长线判定读 `leads.enabled`、
 * 配置代际兼容读 `spec_version`，读错即功能失效（不是降级显示）。
 *
 * 机制（与 `documents.ts` / `check.ts` 同款，本条补的是原先的唯一缺口）：
 *   - 本文件 = 两端共同引用的声明；前端 `web-next/src/api/books.ts` 以 `import type` 取用，
 *     不再自持一份；
 *   - 服务端权威 = `src/format/types.ts` 的 `BookConfig`，由 `web-api.conformance.ts` 在
 *     编译期对账——服务端改名/改型在此报错；
 *   - 前端侧的「声明被漏掉」由 `BOOK_CONFIG_REQUIRED_KEYS` + 前端那份类型探针兜住
 *     （索引签名会把未声明的键退化成 `unknown`，探针判据即「不得退化」）。
 */

/** 扩展线索开关（服务端 `BookConfig['leads']`）。基础三类恒启用、不在 `enabled` 里。 */
export interface BookLeadsConfig {
  /** 启用的扩展类名清单 */
  enabled: string[]
  /** 各类「悬太久」阈值覆盖（缺省 = 各类内置阈值） */
  thresholds?: Record<string, number>
}

/**
 * 前端那份 `BookConfig` 必须**显式声明**的键。
 *
 * 判据用途：前端 interface 带 `[k: string]: unknown` 索引签名——好处是容纳未被消费的
 * 其余字段，代价是「服务端有这个键、前端忘了声明」时**不报错**：读到的是 `unknown`，
 * 消费处只能断言逃生，字段改名/改型永远不会有编译期红。这份清单就是那条红线的锚：
 * 列在此处的键若在前端退化成 `unknown`，前端类型探针即失败。
 */
export const BOOK_CONFIG_REQUIRED_KEYS = ['spec_version', 'leads'] as const

/** 上面那份清单的键联合类型（前端探针只取类型，不把运行时数组拖进打包产物）。 */
export type BookConfigRequiredKey = (typeof BOOK_CONFIG_REQUIRED_KEYS)[number]
