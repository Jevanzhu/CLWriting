/**
 * RB-SV-P2-2：API 层长任务并发闸（per book+action）。
 *
 * 分钟级 AI 任务端点重复点击 = 双倍费用 + 落盘互踩。各 handler 入口同步占位
 * （无 TOCTOU 窗口）、finally 释放；同 key 已在跑 → 409（与 /spawn、/auto-write
 * 闸同口径）。「随客户端断开中止 AI」不在本闸范围（接线面大，转后续轮次）。
 */
const running = new Set<string>()

// dd-P2 自查修正：书名可含 ":"（isInvalidBookName 只禁 \/ 与路径段），action:book 冒号拼接
// 在 heldTaskGatesFor 的后缀匹配下有歧义（闸"分析:A"会让书"A"误判持闸）。
// NUL 做分隔——书名经 isInvalidBookName 不含 \0，action 是代码字面量亦然，键无歧义。
const SEP = '\u0000'
const keyOf = (bookName: string, action: string): string => `${action}${SEP}${bookName}`

/**
 * 占闸：成功返回 release（幂等）；同 book+action 已在跑返回 null（调用方回 409）。
 * action 是本模块约定字面量（不含 ":"），保证 key 无歧义。
 */
export function acquireTaskGate(bookName: string, action: string): (() => void) | null {
  const key = keyOf(bookName, action)
  if (running.has(key)) return null
  running.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    running.delete(key)
  }
}

/** 状态查询（测试用）：该闸当前是否被持有。 */
export function isTaskGateHeld(bookName: string, action: string): boolean {
  return running.has(keyOf(bookName, action))
}

/**
 * 该书当前被持有的全部任务闸（action 名列表）。
 * dd-P2：删书/改名前拒收——分钟级 AI 任务（analyze/rewrite/outline/rag-build 等）
 * 无 abort 通道，带着跑会让旧目录被收尾落盘重建 + 白烧 API 费用；入口拒 409 最省。
 */
export function heldTaskGatesFor(bookName: string): string[] {
  const actions: string[] = []
  for (const key of running) {
    const i = key.indexOf(SEP)
    if (i !== -1 && key.slice(i + SEP.length) === bookName) actions.push(key.slice(0, i))
  }
  return actions
}
