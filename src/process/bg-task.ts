/**
 * 后台 AI 任务的独立中断通道——（
 *）自 process/summary.ts 独立成模块。
 *
 * 起因：runRegisteredBgTask 原居 process/summary.ts（章/卷摘要生成器），但它是**通用
 * 编排原语**（摘要钩子之外的 self-heal 账本推进草稿同用）——消费方从 summary.js 引它，
 * 等于把「摘要生成」整条依赖链拖进消费方的依赖图（ai/orchestrate/self-heal 与
 * 摘要模块互相可见，环边来源之一）。本模块零内部依赖（仅 driver 的类型面），
 * summary / self-heal 等消费方直引，摘要模块不再是通用原语的转运点。
 *
 * 语义（随迁逐位不变）：
 * 后台 AI 任务改持**独立登记的 ctrl**：启动处新建 AbortController 并
 * driver.registerCtrl(session, ctrl, owner)（owner 如 'bg-summary:<bookName>' /
 * 'bg-lead-draft:<bookName>'——与 'chat:<book>'/'spawn'/'self-heal' 各占 owner 槽位，
 * 互不抢占），任务 settle（成功/失败/中断）finally unregisterCtrl。
 *
 * 背景：此前两类后台任务的 AI 调用没有可被 /interrupt 命中的在册 ctrl——定稿摘要
 * 钩子（afterFinalizeGenerateSummary/Batch）根本不持 ctrl；self-heal pass 后账本
 * 推进草稿（self-heal exitPass）持编排级 state.ctrl，而编排收尾后 running Map 已删
 * （self-heal.ts）、ctrl 已在 stream.ts unregister——/interrupt 既找不到编排闸也无
 * 在册 ctrl，该 AI 调用只能跑到 10min 总超时（分钟级白烧 token）。
 *
 * 中断语义：/interrupt 对 session 全部在册 ctrl abort（cc interrupt）→ ctrl.signal
 * 置位 → run 内部 runTask 经 signal 桥接即时收口；失败/中断由调用方按既有后台任务
 * 失败口径落账/落日志（不 crash）。driver/session 未接线（旧调用方不传新形参）→
 * 只建 ctrl 不登记：中断面退化为「无外部中断点」，与修复前等价，不影响既有调用方。
 */
import type { Session, StudioDriver } from '../driver/index.js'

export async function runRegisteredBgTask<T>(
  driver: StudioDriver | null | undefined,
  session: Session | null | undefined,
  owner: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController()
  const registered = driver != null && session != null
  if (registered) driver!.registerCtrl?.(session!, ctrl, owner)
  try {
    return await run(ctrl.signal)
  } finally {
    // settle（成功/失败/中断）即注销——isRunning 归位（cc 口径）；
    // 只注销自己：晚到的注销不得抹掉同 session 后来的新登记
    if (registered) driver!.unregisterCtrl?.(session!, ctrl)
  }
}
