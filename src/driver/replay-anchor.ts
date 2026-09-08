/**
 * R-P1-1（2026-09-08 全量代码重审 批1）：迟到回放的清屏锚。
 *
 * cc/mock driver 的 pre/execRing 回放会把断连前已送达的 text 增量原样重发给新消费者
 * （E1b 迟到回放），而 workbench.dispatch 对 text 事件盲追加（textOut += text）——
 * 重连消费者已积累的 textOut 与重放增量叠加即整段重复。回放序列首个 text 增量之前
 * 若没有会清空/重建 textOut 的锚事件，回放侧先补发一个合成 text_reset（前端既有
 * 清空语义，src/studio/web-next/src/stores/workbench.ts dispatch 的 text_reset 分支），
 * 重放文本从空重建；锚仍在回放内时补发为幂等冗余（清空空缓冲）。
 */
import type { DriverEvent } from './types.js'

/** workbench.dispatch 侧会清空 textOut 的事件：role_spawn（新生成清空旧正文）/
 *  init（会话元数据清场）/ text_reset 与 self_heal_reset（重写/重试前清正文缓冲） */
const TEXTOUT_ANCHORS: ReadonlySet<string> = new Set(['role_spawn', 'init', 'text_reset', 'self_heal_reset'])

/** 回放是否需要前导清屏锚：序列中首个 text 增量之前无锚事件 → true（无 text 事件恒 false） */
export function replayNeedsResetAnchor(replay: readonly DriverEvent[]): boolean {
  for (const e of replay) {
    if (e.type === 'text') return true
    if (TEXTOUT_ANCHORS.has(e.type)) return false
  }
  return false
}

/** 合成回放锚（只读共享——事件沿广播链按引用透传，消费侧只读展开无变异面） */
export const REPLAY_RESET: DriverEvent = { type: 'text_reset' }
