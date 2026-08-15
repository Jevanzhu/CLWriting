/**
 * 窗口参数归一（批次 A1 / CS-12 maxMessagesWindow 直抄）。
 *
 * 纪律：非法值（0/负数/NaN/±Infinity/非数/分数）一律归 null = 不设限——
 * 「服务全历史是既有行为，发明一个窗口反而静默丢上下文」，绝不猜数字。
 * 触发场景：maxMessages 未来做成设置项（DB 读、无 schema 强制）时的入口防线。
 */

/** 归一窗口值：合法正整数原样返回；非法 → null（不设限） */
export function normalizeMaxMessages(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v === Infinity) {
    return null
  }
  return v
}
