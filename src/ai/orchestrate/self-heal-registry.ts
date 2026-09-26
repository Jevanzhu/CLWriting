/**
 * 全自动写章 · 运行登记/并发锁族（缝 A）—— （⑤④产品巨件拆分
 * 波3）自 self-heal.ts 纯移动拆出：RunState/running 登记表（book 级并发锁 + 中断
 * 句柄）、isSelfHealRunning/isChatEmbeddedSelfHealRunning 在途查询、
 * forceReleaseSelfHealRunning 与测试别名 __setSelfHealRunningForTest 强释放对、
 * settling 收尾表（#7）与 waitSelfHealSettled 等待、abortSelfHeal 中断入口。
 * 顶层求值常量（running/settling 两 Map）单源本文件，残核 self-heal.ts 直接
 * import 回引（不经桥、不经环回链）。本文件零 import（依赖叶子），不回引残核或
 * 同批任何模块——单向边无环。生成族见 self-heal-generate.ts（缝 B）；编排主流程
 * 残核与 re-export 桥在 self-heal.ts（全库消费方 import 面零改动）。
 * 注释全部原样随迁；行为零改动。原私有而残核跨文件消费项（RunState/running/
 * settling）就此导出，其余保持私有。
 */

/** 运行中的编排（book 级并发锁 + 中断句柄） */
export interface RunState {
  ctrl: AbortController
  /** chat 对话嵌套写章标记（SelfHealOpts.embedded 透传） */
  embedded?: boolean
  /** 本次运行 AI 消耗累计（done 事件上报，；genFn 单测替身无 usage 不入账）。
   *  cost 按次现算累计（写稿模型四档分计，未配价不入账）——与 stream.ts /spawn 同口径。
   *  低级项：删掉无人读取的 calls/inputTokens 累计（emitResult 只读
   *  cost/outputTokens，单次明细已在事件库 llm/call 行）
   *  ：estimated——任一 attempt 为估计入账时置位，done 事件透出
   *  usageEstimated（前端可区分实测/估计口径） */
  usage: { outputTokens: number; cost: number; estimated?: boolean }
}
export const running = new Map<string, RunState>()

/** 本书是否正在全自动写章 */
export function isSelfHealRunning(bookName: string): boolean {
  return running.has(bookName)
}

/** （二十四轮 A 域）：在途自愈是否为 chat 对话嵌套写章（write_chapter 工具驱动）
 *  ——chat 入口闸（stream.ts）据此区分独立写稿（409 拒新对话）与对话嵌套写稿（放行
 *  交 sendChatMessage 入队 steer，当前轮结束自动续链）。 */
export function isChatEmbeddedSelfHealRunning(bookName: string): boolean {
  return running.get(bookName)?.embedded === true
}

/**
 * （修复批）：运行登记强删除（生产命名导出）——
 * stream.ts 静默挂死 watchdog 二段强释放的登记清理入口。语义 = running.delete(bookName)，
 * 幂等（不在册/重复调用均安全；被强释放的编排若日后 settle，其 finally 的同键删除天然互容）。
 * 此前该生产清理点直调测试命名导出 __setSelfHealRunningForTest，测试专用 API 进了生产路径。
 */
export function forceReleaseSelfHealRunning(bookName: string): void {
  running.delete(bookName)
}

/** 回归注入（先例同 api/review.ts __setReviewRunning）——orchestrationBusyFor
 *  互斥矩阵测试需制造「self-heal 在途」态，真实跑完整闭环过重。生产零调用；off 分支
 *  转调 forceReleaseSelfHealRunning（起本函数是它的测试别名）。 */
export function __setSelfHealRunningForTest(bookName: string, on: boolean): void {
  if (on) running.set(bookName, { ctrl: new AbortController(), usage: { outputTokens: 0, cost: 0 } })
  else forceReleaseSelfHealRunning(bookName)
}

/** #7：在途 runSelfHeal 的收尾 Promise（改名/删书/退出等待用；含 emitResult 后的完整收尾） */
export const settling = new Map<string, Promise<unknown>>()

/** #7：等本书在途自愈收尾（无在途立即返回）。与 chat.ts waitChatSettled 同款——
 * abort 是异步信号，straggler 的链路事件 flush 在关库/搬路径后恢复会丢/抛。
 * 循环等到表项清空（防表项被替换后等待方拿旧 resolve 提前返回——与 chat 侧同构） */
export async function waitSelfHealSettled(bookName: string): Promise<void> {
  for (;;) {
    const p = settling.get(bookName)
    if (!p) return
    await p.catch(() => undefined)
  }
}

/** 中断本书的全自动写章 */
export function abortSelfHeal(bookName: string): boolean {
  const st = running.get(bookName)
  if (!st) return false
  st.ctrl.abort()
  return true
}
