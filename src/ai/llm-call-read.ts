/**
 * llm/call 事件读侧单源（重评2-P3-2，2026-09-09 全量重评 GLM-5.3，AI 域 P3-③）。
 *
 * 此前 cost-stats.ts 与 trace-stats.ts 各持一份同构 readLlmCalls（开库 → type SQL
 * 下推取 llm/call 行 → 投影 → finally close → 失败静默 []），口径随两处抄写各自
 * 漂移（评审原诉）。现收敛为本模块，两消费方经同一实现读取，差异只剩显式的
 * skipMissingUsage 旗标（见下）与各自下游聚合。
 *
 * 各口径出处（自原两实现随迁，出处注释不删）：
 * - B1（2026-08-24 内存闸）：type SQL 下推——只取 llm/call 行，对话正文不陪载；
 * - PM-10（2026-09-05 性能专项）核查：两消费方均须全部 llm/call 行，全量语义必需、
 *   无尾读空间（成本/轨迹聚合都是账目口径）；
 * - R34D-19（三十四轮）：开库走 openSessionStoreAsync（首开锁等待不阻塞服务事件循环），
 *   调用方 await；
 * - M2（二轮复审）：本地日分桶 day = localDayKey(createdAt)（与日志文件日同口径；
 *   此前 UTC 切日，东八区 0-8 点记前一日）；
 * - 观测层失败静默 → []（观测面失败不反噬业务主流程）。
 */
import { openSessionStoreAsync, bookHash } from '../events/store.js'
import type { LlmCallData } from '../events/types.js'
import { localDayKey } from '../log/index.js'

/** llm/call 行投影（两消费方字段的并集；下游各取所需） */
export interface LlmCallReadRow {
  task: string
  /** 调用是否成功（trace 通过率用；cost 不消费） */
  ok: boolean
  durationMs: number
  attempt: number
  /** 模型名（cost 按模型查价用；trace 不消费） */
  model: string
  /** 归属章号（runTask 传章时记录；旧事件无此键按无章归集） */
  chapter?: number
  usageIn: number
  usageOut: number
  cacheRead?: number
  cacheWrite?: number
  /** 本地日分桶 key（M2 口径，见文件头） */
  day: string
}

export interface ReadLlmCallRowsOptions {
  /**
   * true = usage 缺失的行跳过（cost 侧 Q-12 口径：判跳看 usage 而非 ok——失败调用
   * 可携真实 usage 入账，失败且无 usage 才跳过，报表不系统性低于预算闸/真实账单）；
   * false = 全部行投影、usage 缺失按 0 兜底（trace 侧口径：通过率/耗时维度不依赖
   * usage，token 合计按 ?? 0 计入，行数即调用次数口径）。
   */
  skipMissingUsage: boolean
}

/**
 * 从事件库读 llm/call 事件行投影（观测层失败静默 → []）。
 * 事件挂 workspace 会话（bookHash(bookRoot) 为 book 标识），按事件创建时间聚日。
 */
export async function readLlmCallRows(
  userDataPath: string | null | undefined,
  bookRoot: string,
  opts: ReadLlmCallRowsOptions,
): Promise<LlmCallReadRow[]> {
  if (!userDataPath) return []
  try {
    const store = await openSessionStoreAsync(userDataPath, bookRoot)
    if (!store) return []
    try {
      // B1（2026-08-24 内存闸）：type SQL 下推——只取 llm/call 行；PM-10 核查为全量语义必需
      const events = store.listEvents(bookHash(bookRoot), undefined, undefined, 'llm/call')
      const out: LlmCallReadRow[] = []
      for (const e of events) {
        const d = e.data as unknown as LlmCallData
        // Q-12（第十五轮，cost 侧口径）：skipMissingUsage 见 options 注
        if (opts.skipMissingUsage && d.usage == null) continue
        out.push({
          task: d.task,
          ok: d.ok,
          durationMs: d.durationMs,
          attempt: d.attempt,
          model: d.model,
          ...(typeof d.chapter === 'number' ? { chapter: d.chapter } : {}),
          usageIn: d.usage?.input ?? 0,
          usageOut: d.usage?.output ?? 0,
          ...(d.usage?.cacheRead !== undefined ? { cacheRead: d.usage.cacheRead } : {}),
          ...(d.usage?.cacheWrite !== undefined ? { cacheWrite: d.usage.cacheWrite } : {}),
          day: localDayKey(e.createdAt),
        })
      }
      return out
    } finally {
      store.close()
    }
  } catch {
    return []
  }
}
