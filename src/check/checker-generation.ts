/**
 * 机检代次（CHECKER_GENERATION）——由各检查器模块导出的规则表面机械哈希生成，
 * 不再手工 bump 字面量。
 *
 * 由来：代次原为 tree-issues-cache.ts 里的 `'a1-v2'` 字面量，靠人记「检查器词表/
 * 阈值/规则语义演进时改一处」；漏 bump 时旧缓存按章指纹照常命中，红黄项静默陈旧。
 * 现改为：本模块收编各检查器的**导出面**（正则 source/flags、词表、阈值、升红集、
 * 占位词与导出函数名/参数个数）→ 规范化串 → FNV-1a 64 位哈希。规则改一处，
 * 代次自动变，旧缓存整代表失效（tree-issues-cache.computeTreeIssuesGlobalFpCore
 * 把代次并入纪元指纹首段）。
 *
 * 覆盖边界（明示，防误信自动面）：
 * - 覆盖：导出常量的值变更、导出面增删名、导出函数增删/改名/参数个数变化；
 * - 不覆盖：既有函数**体内逻辑**改动（如 `>` 改 `>=`）而不动任何导出常量——此类
 *   演进仍须顺带把改动落进某条导出规则面（阈值提常量等），或人工 bump 代次；
 * - 排除表：调度粒度类常量（非判定规则）不参与，见 EXCLUDED_RULE_KEYS。
 *
 * 不变量：canonicalRuleValue 对同一输入恒同串（跨平台/跨进程稳定）——代次参与
 * 缓存键，哈希须确定性；数组/集合按原序与排序规则规范化，对象按键排序。
 */

import * as countDialogueRules from './count-dialogue.js'
import * as countRules from './count.js'
import * as countStyleRules from './count-style.js'
import * as quotesRules from './quotes.js'
import * as imagerySeedRules from './imagery-seed.js'
import * as manifestCheckRules from './manifest-check.js'
import * as growthRules from './growth.js'
import * as leadsRules from './leads.js'
import * as strictShortRules from './strict-short-ids.js'

/** 收编模块表：键 = 代次键前缀。新增检查器规则模块时在此加一行（其导出常量
 *  自动进快照，无需逐个登记）。 */
const RULE_MODULES: ReadonlyArray<readonly [string, object]> = [
  ['count-dialogue', countDialogueRules],
  ['count', countRules],
  ['count-style', countStyleRules],
  ['quotes', quotesRules],
  ['imagery-seed', imagerySeedRules],
  ['manifest-check', manifestCheckRules],
  ['growth', growthRules],
  ['leads', leadsRules],
  ['strict-short', strictShortRules],
]

/** 排除表：非判定规则（调度粒度/缓存容量一类），变更不触碰机检语义。 */
const EXCLUDED_RULE_KEYS = new Set<string>(['leads.LEADS_BOOK_YIELD_EVERY'])

/** 规范串分隔符（避免与规则内容撞串歧义） */
const SEP = '\u0001'
const KV_SEP = '\u0002'

/**
 * 规则值 → 确定性规范串；不可规范化的值（undefined/symbol/类实例）返回 null
 * （该条整体跳过——规则表须为纯数据，含不可序列化项即不参与代次，宁缺勿蒙）。
 * 函数不收源码体，只收「名 + 参数个数」的在场性（导出面增删/改名/改签名可察），
 * 体内逻辑演进不在此面（见头注覆盖边界）。
 */
export function canonicalRuleValue(value: unknown): string | null {
  if (typeof value === 'string') return `str${KV_SEP}${value}`
  if (typeof value === 'number') return `num${KV_SEP}${value}`
  if (typeof value === 'boolean') return `bool${KV_SEP}${value}`
  if (typeof value === 'bigint') return `big${KV_SEP}${value}`
  if (typeof value === 'function') return `fn${KV_SEP}${value.length}`
  if (value === null) return 'null'
  if (value === undefined || typeof value === 'symbol') return null
  if (value instanceof RegExp) return `re${KV_SEP}${value.source}/${value.flags}`
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalRuleValue(v))
    if (items.some((s) => s === null)) return null
    return `arr[${(items as string[]).join(SEP)}]`
  }
  if (value instanceof Set) {
    const items = [...value].map((v) => canonicalRuleValue(v))
    if (items.some((s) => s === null)) return null
    return `set{${(items as string[]).join(SEP)}}`
  }
  if (value instanceof Map) {
    const items: string[] = []
    for (const [k, v] of value) {
      const ck = canonicalRuleValue(k)
      const cv = canonicalRuleValue(v)
      if (ck === null || cv === null) return null
      items.push(`${ck}=>${cv}`)
    }
    return `map{${items.join(SEP)}}`
  }
  const proto = Object.getPrototypeOf(value) as object | null
  if (proto === Object.prototype || proto === null) {
    const obj = value as Record<string, unknown>
    const parts: string[] = []
    for (const key of Object.keys(obj).sort()) {
      const cv = canonicalRuleValue(obj[key])
      if (cv === null) return null
      parts.push(`${key}=${cv}`)
    }
    return `obj{${parts.join(SEP)}}`
  }
  return null
}

/** 收编模块导出面 → 扁平规则快照（键 `${module}.${name}`，值 = 规范串）。
 *  导出供测试锚「快照确由规则表机械导出」与「逐条参与哈希」。 */
export function snapshotRuleModules(
  modules: ReadonlyArray<readonly [string, object]> = RULE_MODULES,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [mod, ns] of modules) {
    const entries = Object.entries(ns as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [name, value] of entries) {
      const key = `${mod}.${name}`
      if (EXCLUDED_RULE_KEYS.has(key)) continue
      const canon = canonicalRuleValue(value)
      if (canon !== null) out[key] = canon
    }
  }
  return out
}

/** 本仓检查器规则表快照（模块加载时冻结一次）。 */
export const CHECKER_RULE_SNAPSHOT: Readonly<Record<string, string>> = Object.freeze(snapshotRuleModules())

/** FNV-1a 64 位（bigint 实现，跨平台确定；代次是缓存键成分，须稳定）。 */
function fnv1a64Hex(input: string): string {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

/**
 * 规则快照 → 机检代次。默认吃本仓快照；测试可传变异快照锚「任一规则变更 →
 * 代次必变」。输出不含字面量版本号——代次值本身不是契约，可观察契约是
 * 「规则变 ⟺ 代次变（有变必变，未变不变）」。
 */
export function computeCheckerGeneration(snapshot: Readonly<Record<string, string>> = CHECKER_RULE_SNAPSHOT): string {
  const lines = Object.keys(snapshot)
    .sort()
    .map((k) => `${k}=${snapshot[k]}`)
  return fnv1a64Hex(lines.join('\n'))
}

/** 现行机检代次：规则表面哈希（见头注覆盖边界）。 */
export const CHECKER_GENERATION = computeCheckerGeneration()
