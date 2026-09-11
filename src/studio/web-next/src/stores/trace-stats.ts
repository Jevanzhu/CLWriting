import { defineStore } from 'pinia'
import { getTraceStats, type TraceStats } from '../api/trace-stats'

/**
 * trace-stats 请求协调 store（R0912-FE-P3-4，2026-09-11 重评-0911b 修复批）。
 *
 * 背景：工作台同屏两处各拉一次 GET /trace-stats——WorkbenchView.loadRuleHits（规则命中）
 * 与 WbUsageCard.load（byTask 用量 + getCostStats），api 层无去重，同屏挂载即双发。
 * 仿 words/provider 的在途合并台账（words.ensureBaseline inflightBaselines 手法）：
 * 同书并发调用共享同一在途 promise，settle 后 identity 删键。数据面口径不变——
 * 不做结果缓存（settle 即删键，各消费方语义/失败路径/切书代守卫全部原样保留），
 * 只消除「同书并发重复请求」。
 */
export const useTraceStatsStore = defineStore('trace-stats', () => {
  /** 同书在途 promise 台账（bookName → promise）。 */
  const inflight = new Map<string, Promise<TraceStats>>()

  /** 取 trace-stats：同书在途共享，无在途才真发请求。失败同样删键（下调用重试）。 */
  function getStats(bookName: string): Promise<TraceStats> {
    const running = inflight.get(bookName)
    if (running) return running
    const p = getTraceStats(bookName).finally(() => {
      // identity 删键（words.ts R46-33 口径）：settle 前台账被清/被新请求顶替时，
      // 旧 promise 的 finally 不得误删新条目
      if (inflight.get(bookName) === p) inflight.delete(bookName)
    })
    inflight.set(bookName, p)
    return p
  }

  return { getStats }
})
