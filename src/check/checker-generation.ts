/**
 * 机检代次（CHECKER_GENERATION）——由各检查器模块导出的规则表面机械哈希生成。
 *
 * 为什么：代次参与 tree_issues_cache 的缓存键（tree-issues-cache.ts 的
 * computeTreeIssuesGlobalFpCore 把它并入纪元指纹首段）——规则变了而代次不变，旧缓存
 * 按章指纹照常命中，红黄项静默陈旧。故规则改动须机械映射到代次：本模块收编各检查器
 * 模块的**导出面**（正则 source/flags、词表、阈值、升红集、占位词，以及导出函数的
 * 名/参数个数/**源文本**）→ 规范化串 → FNV-1a 64 位哈希；规则改一处，代次自动变，
 * 旧缓存整代表失效。
 *
 * 覆盖边界（明示，防误信自动面）：
 * - 覆盖：导出常量的值变更、导出面增删改名、导出函数**源文本**变更（体内逻辑如
 *   `>` 改 `>=` 必改源文本 → 必换代次）；
 * - 不覆盖：未入 RULE_MODULES 的模块；导出函数**闭包捕获的模块内非导出量**
 *   （子函数/常量/正则的定义不在导出函数源文本里，改它们不动代次）；来自盘上数据的
 *   规则文本（这类输入走纪元指纹的文件/目录指纹，见 tree-issues-cache.ts）；
 * - 逃生口：代次是纯计算值（没有可改的代次字面量）——上列未覆盖面须改用机械面兜住：
 *   把阈值/词表提为导出常量，或把模块加进 RULE_MODULES 一行，使改动自动入代次；
 * - 排除表：调度粒度/缓存容量一类非判定常量不参与，见 EXCLUDED_RULE_KEYS。
 *
 * 不变量：同一份代码恒同串（跨平台/跨进程稳定）——代次参与缓存键，哈希须确定性；
 * 数组/集合按原序与排序规则规范化，对象按键排序，函数收源文本。
 */

import * as countDialogueRules from './count-dialogue.js'
import * as countRules from './count.js'
import * as countStyleRules from './count-style.js'
import * as quotesRules from './quotes.js'
import * as imagerySeedRules from './imagery-seed.js'
import * as aiPatternsRules from './ai-patterns.js'
import * as bodyFormatRules from './body-format.js'
import * as manifestCheckRules from './manifest-check.js'
import * as growthRules from './growth.js'
import * as leadsRules from './leads.js'
import * as strictShortRules from './strict-short-ids.js'
// 账本/进度类判定：条目正则与证据命中（lead-updates）、声明侧三态读取（outline-leads）
import * as leadUpdatesRules from './lead-updates.js'
import * as outlineLeadsRules from './outline-leads.js'
// 判定所依赖的 format 侧规则家：境界抽取、铁律阈值解析、分句与 n-gram 复读率
import * as realmsRules from '../format/realms.js'
import * as ironRules from '../format/iron-rules.js'
import * as sentencesRules from '../format/sentences.js'

/** 收编模块表：键 = 代次键前缀。新增检查器规则模块时在此加一行（导出面自动进快照，
 *  无需逐个登记）。
 *
 *  收编原则：**整模块收**（导出面全入哈希）。IO/缓存运维类导出即便与判定无关也一并
 *  收——代价只是改它多失效一次缓存（安全方向）；逐键排除会重新打开「判定函数漏收 →
 *  规则改了而代次不动」的静默陈旧面，而该面正是本表要堵的。仅「确定无判定输出」的
 *  调度/容量常量走 EXCLUDED_RULE_KEYS。
 *
 *  收编前提：这些模块的导出面是规则数据（正则/词表/阈值/字符串常量）或纯函数，
 *  canonicalRuleValue 能全量规范化；模块顶层除常量与缓存 Map 初始化外零行为面（书键
 *  缓存自登记 registerBookKeyedCache 幂等——ESM 模块体单次求值），import 它们不触发
 *  IO、不改变任何判定结果。 */
const RULE_MODULES: ReadonlyArray<readonly [string, object]> = [
  ['count-dialogue', countDialogueRules],
  ['count', countRules],
  ['count-style', countStyleRules],
  ['quotes', quotesRules],
  ['imagery-seed', imagerySeedRules],
  ['ai-patterns', aiPatternsRules],
  ['body-format', bodyFormatRules],
  ['manifest-check', manifestCheckRules],
  ['growth', growthRules],
  ['leads', leadsRules],
  ['strict-short', strictShortRules],
  ['lead-updates', leadUpdatesRules],
  ['outline-leads', outlineLeadsRules],
  ['realms', realmsRules],
  ['iron-rules', ironRules],
  ['sentences', sentencesRules],
]

/** 排除表：非判定规则（调度粒度/缓存容量一类），变更不触碰机检语义。 */
const EXCLUDED_RULE_KEYS = new Set<string>(['leads.LEADS_BOOK_YIELD_EVERY'])

/** 规范串分隔符（避免与规则内容撞串歧义） */
const SEP = '\u0001'
const KV_SEP = '\u0002'

/**
 * 函数规则值 → 确定性规范串：**名 + 参数个数 + 源文本**（`toString()`）。
 *
 * 为什么收源文本：函数体是最常见的规则演进形态——只收「名 + 参数个数」时，把
 * `>` 改成 `>=` 不动任何导出常量即漏换代次，旧缓存按章指纹继续命中，红黄项静默陈旧。
 *
 * 约束与代价：
 * - 确定性：`toString()` 回读源文本，同一份代码在同一管线内恒同串（不掺路径、时长等
 *   环境量）——代次是缓存键成分，此点不可放宽；
 * - 打包态：tsup.config.ts 未开 minify（`format: 'esm'`、`target: 'node24'`，无
 *   `minify` 键），打包态 `toString()` 拿到的是可读真实源文本；若将来开启 minify，
 *   名字与正文会被压缩，覆盖面退化为构建产物形态（仍随源码变，只是不再可读）；
 * - 代价：源文本里「哪些成分参与」由所在管线决定——esbuild 打包态剥注释（生产态改
 *   函数内注释不换代次），dev/test 直读源码态则注释一并参与（改注释也换代次）。
 *   含注释的一侧是多失效一次缓存，方向安全、可接受。
 *
 * 兜底：`toString()` 抛错或返回非串（代理/绑定/宿主边界形态）时降级为「名 + 参数
 * 个数」——只丢该条函数的体内覆盖，绝不因单条导出让整个代次计算失败。原生/绑定函数
 * 的 `toString()` 按规范返回 `function name() { [native code] }`（稳定串，无需特判）。
 */
function canonicalFunctionValue(fn: { name?: string; length: number; toString(): string }): string {
  const arity = `${fn.name ?? ''}${KV_SEP}${fn.length}`
  try {
    const src = fn.toString()
    return typeof src === 'string' ? `fn${KV_SEP}${arity}${KV_SEP}${src}` : `fn${KV_SEP}${arity}`
  } catch {
    return `fn${KV_SEP}${arity}`
  }
}

/**
 * 规则值 → 确定性规范串；不可规范化的值（undefined/symbol/类实例）返回 null
 * （该条整体跳过——规则表须为纯数据，含不可序列化项即不参与代次，宁缺勿蒙）。
 * 函数收「名 + 参数个数 + 源文本」，见 canonicalFunctionValue（体内逻辑改必换代次）。
 */
export function canonicalRuleValue(value: unknown): string | null {
  if (typeof value === 'string') return `str${KV_SEP}${value}`
  if (typeof value === 'number') return `num${KV_SEP}${value}`
  if (typeof value === 'boolean') return `bool${KV_SEP}${value}`
  if (typeof value === 'bigint') return `big${KV_SEP}${value}`
  if (typeof value === 'function') return canonicalFunctionValue(value)
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
 *  导出供测试锚「快照确由规则表机械导出」与「逐条参与哈希」。
 *  注：ESM 命名空间里从子模块 re-export 的键（如 count.ts 转出的 count-style 表）
 *  会各自成立一条，与直接收编同族模块形成重复键——重复无害（同值同串，同一规则变
 *  则两键同变），不做去重。 */
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
