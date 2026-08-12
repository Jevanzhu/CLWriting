/**
 * SSE 事件 type guard —— stores 的 SSE 事件运行时校验统一收口（P2-2）。
 *
 * 原先 workbench.ts / chat.ts 各自手写 `as Record` 断言 + 重复的 str() 提取，
 * 后端事件结构变化时前端静默失败。本模块提供：
 * - str / strArr：字段安全提取（原两处重复实现合并）
 * - isSseEvent：基础对象守卫（取代手写 typeof 检查 + as Record）
 * - isHealPhaseEvent / isHealResultEvent：全自动写章事件守卫（白名单 + 类型收窄）
 *
 * 事件类型的字段校验规则与旧实现逐字一致（不做行为变更，仅收口 + 收窄类型）。
 */

/** 字段安全提取：仅字符串返回，否则 undefined（拒绝数字/布尔等误用） */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** 字段安全提取：字符串数组（过滤非字符串元素，长度 0 的数组也返回） */
export function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
}

/** SSE 事件基础守卫：是对象且含 type 字符串 */
export function isSseEvent(ev: unknown): ev is { type: string; [k: string]: unknown } {
  if (typeof ev !== 'object' || ev === null) return false
  return typeof (ev as Record<string, unknown>)['type'] === 'string'
}

/** 全自动写章阶段（与 HEAL_PHASES 白名单一致） */
export type HealPhaseName = 'drafting' | 'checking' | 'rewriting'

/** self_heal_phase 事件守卫：phase 白名单校验 + 类型收窄 */
export function isHealPhaseEvent(
  ev: { type: string; [k: string]: unknown },
): ev is { type: 'self_heal_phase'; phase: HealPhaseName } {
  if (ev.type !== 'self_heal_phase') return false
  const p = ev.phase
  return p === 'drafting' || p === 'checking' || p === 'rewriting'
}

/** 全自动写章终局 outcome（与 HEAL_OUTCOMES 白名单一致） */
export type HealOutcomeName = 'pass' | 'escalate' | 'aborted' | 'failed'

/** self_heal_result 事件守卫：outcome 白名单 + 可选字符串数组/字符串字段收窄 */
export function isHealResultEvent(
  ev: { type: string; [k: string]: unknown },
): ev is {
  type: 'self_heal_result'
  outcome: HealOutcomeName
  reds?: string[]
  yellows?: string[]
  docId?: string
  path?: string
  error?: string
} {
  if (ev.type !== 'self_heal_result') return false
  const o = ev.outcome
  if (o !== 'pass' && o !== 'escalate' && o !== 'aborted' && o !== 'failed') return false
  if (ev.reds !== undefined && !Array.isArray(ev.reds)) return false
  if (ev.yellows !== undefined && !Array.isArray(ev.yellows)) return false
  for (const k of ['docId', 'path', 'error']) {
    if (ev[k] !== undefined && typeof ev[k] !== 'string') return false
  }
  return true
}
