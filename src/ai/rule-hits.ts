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

/** 记录一次规则违规命中（多条违规 → 多条统计）。落盘失败不炸流程（观测层）。
 *  并发安全：本函数全程同步 I/O（readFileSync → mutate → atomicWriteFile），
 *  Node.js 单线程事件循环保证同步段不会交叉，read-modify-write 天然原子。
 *  若将来改为异步 I/O（fs.promises），需加 per-bookRoot 写锁防交叉覆盖。 */
export function recordRuleHits(bookRoot: string, violations: RuleViolation[], userDataPath?: string): void {
  if (!violations.length) return
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
  // P3 事件化（rule/hit）：可选 userDataPath 时双写事件（审计单一事实源；观测层静默）
  if (userDataPath) {
    try {
      const store = openSessionStore(userDataPath, bookRoot)
      if (store) {
        const sessionId = store.workspaceSession(bookHash(bookRoot))
        store.appendEvents(
          sessionId,
          violations.map((v) => ruleHitEvent({ ruleId: v.ruleId, task: 'check', message: v.message })),
        )
        store.close()
      }
    } catch {
      // 观测层失败静默
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