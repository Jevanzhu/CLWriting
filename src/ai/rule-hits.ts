/**
 * 规则命中统计（B3）—— 按书记录「哪条规则最常被违反」。
 *
 * 写入书库 .cache/rule-hits.json（独立于 ai-trace：规则违规是确定性检测，
 * 不是 AI 调用日志，分开存更干净）。
 *
 * 用途：
 * - B3 统计：trace-stats 聚合透出（工作台可见高频违规）
 * - B4 前置：写稿 TaskSpec 组装 prompt 时读 Top-N 高频违规注入预防指令
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { acquireCrossProcessLockWithTimeout } from '../fs/cross-process-lock.js'
import { log } from '../log/index.js'
import type { RuleViolation } from './rules/types.js'
import { openSessionStore, bookHash } from '../events/store.js'
import { ruleHitEvent } from '../events/chain-bridge.js'

const FILE = 'rule-hits.json'
/** 每条规则保留最近命中 message 数（B4 前置注入参考） */
const RECENT_LIMIT = 5

/** 单条规则的命中统计 */
export interface RuleHitEntry {
  /** 规则 ID */
  ruleId: string
  /** 累计命中次数 */
  hits: number
  /** 最后命中时间（ISO） */
  lastHit: string
  /** 最近命中 message（修复指令，供 B4 前置注入参考） */
  recentMessages: string[]
}

type RuleHitsMap = Record<string, RuleHitEntry>

function hitsPath(bookRoot: string): string {
  return join(bookRoot, '.cache', FILE)
}

function readHits(bookRoot: string): RuleHitsMap {
  try {
    const raw = readFileSync(hitsPath(bookRoot), 'utf-8')
    const parsed = JSON.parse(raw) as RuleHitsMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** R63-6（十一轮）：rule-hits 跨进程锁等待超时（毫秒）——可注入缩短保测试快；
 *  争用为文件 IO 级毫秒，5s 已极保守（对齐 ai-calls J7）。 */
export let RULE_HITS_LOCK_TIMEOUT_MS = 5_000

/** 测试注入钩子（生产零调用）。 */
export function __setRuleHitsLockTimeoutForTest(ms: number): void {
  RULE_HITS_LOCK_TIMEOUT_MS = ms
}

/** 记录一次规则违规命中（多条违规 → 多条统计）。落盘失败不炸流程（观测层）。
 *  R63-6（十一轮）：读改写整段进跨进程锁（.cache/rule-hits.json.lock，J7 同款）——
 *  原并发说明只覆盖进程内（同步段单线程天然原子）；CLI 机检与桌面端并发命中同书时
 *  双进程 RMW 交错覆盖丢计数。锁超时按观测层口径降级：warn 留痕跳过文件统计，
 *  事件双写（单一事实源）照常。 */
export function recordRuleHits(bookRoot: string, violations: RuleViolation[], userDataPath?: string): void {
  if (!violations.length) return
  const release = acquireCrossProcessLockWithTimeout(`${hitsPath(bookRoot)}.lock`, RULE_HITS_LOCK_TIMEOUT_MS)
  if (!release) {
    log.warn('rule-hits', `rule-hits 跨进程锁获取超时，本轮命中统计未记（观测层降级；事件库照常）`)
  } else {
    try {
      const hits = readHits(bookRoot)
      const now = new Date().toISOString()
      for (const v of violations) {
        const entry = hits[v.ruleId] ?? { ruleId: v.ruleId, hits: 0, lastHit: '', recentMessages: [] }
        entry.hits++
        entry.lastHit = now
        entry.recentMessages = [v.message, ...entry.recentMessages].slice(0, RECENT_LIMIT)
        hits[v.ruleId] = entry
      }
      try {
        mkdirSync(join(bookRoot, '.cache'), { recursive: true })
        atomicWriteFile(hitsPath(bookRoot), JSON.stringify(hits, null, 2))
      } catch {
        // 统计是旁路，不影响主流程
      }
    } finally {
      release()
    }
  }
  // P3 事件化（rule/hit）：可选 userDataPath 时双写事件（审计单一事实源；观测层静默）
  if (userDataPath) {
    let store: ReturnType<typeof openSessionStore> | null = null
    try {
      store = openSessionStore(userDataPath, bookRoot)
      if (store) {
        const sessionId = store.workspaceSession(bookHash(bookRoot))
        store.appendEvents(
          sessionId,
          violations.map((v) => ruleHitEvent({ ruleId: v.ruleId, task: 'check', message: v.message })),
        )
      }
    } catch {
      // 观测层失败静默
    } finally {
      // dd-P2：close 挪进 finally——appendEvents 抛错时此前被跳过，句柄泄漏（同 author-signal）
      store?.close()
    }
  }
}

/** 读规则命中统计（按 hits 降序） */
export function readRuleHits(bookRoot: string): RuleHitEntry[] {
  return Object.values(readHits(bookRoot)).sort((a, b) => b.hits - a.hits)
}

/** 取 Top-N 高频违规（B4 前置注入用）。无命中 / 文件不存在 → 空数组。 */
export function topRuleHits(bookRoot: string, n: number): RuleHitEntry[] {
  if (!existsSync(hitsPath(bookRoot))) return []
  return readRuleHits(bookRoot).slice(0, n)
}