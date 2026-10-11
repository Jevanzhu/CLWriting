/**
 * 启动预算守卫：boot 与偏好加载按「合计总预算」等待。
 *
 * 为什么需要：main.ts 原先 `await boot()`（4 次尝试 × 5s 超时 + 退避 ≈21s）与
 * `await prefs.init()`（apiJson 默认 30s 超时）两段串联无上界——本地 API 正常时
 * 两段都是毫秒级，但 API 异常（接受 TCP 连接却不响应：服务端重启中、迁移卡顿、
 * 磁盘慢）时白屏可达 ~50s，用户会误判应用损坏。
 *
 * 语义：到总预算即放行（调用方以离线态先挂载）；未落定的 step **不取消**——后台
 * 继续跑完并自行落位（boot 落 token、prefs.init 内部 apply CSS 变量），不刷新自愈。
 * step 自身的失败降级链不变：本函数只限等待时长，不改 resolve/reject 结果。
 */

/** 启动两段（boot + 偏好加载）合计预算上限。本地 API 正常时远用不到。 */
export const STARTUP_BUDGET_MS = 6_000

/**
 * 按序等待 steps 落定，**合计**至多 budgetMs（前段耗掉的额度从后段扣除，非每段
 * 独立预算）。同步抛错按已落定处理并留痕——启动链不因单步同步错误卡死。
 */
export async function awaitStartupWithBudget(
  steps: ReadonlyArray<() => Promise<unknown>>,
  budgetMs: number = STARTUP_BUDGET_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (const step of steps) {
    let p: Promise<unknown>
    try {
      p = step()
    } catch (e) {
      console.warn('[startup] 启动步骤同步抛错，按已落定继续（不阻断挂载）:', e)
      continue
    }
    await withBudget(p, Math.max(0, deadline - Date.now()))
  }
}

/** 等待 p 至多 budgetMs；到期即放行（p 不取消）。 */
function withBudget(p: Promise<unknown>, budgetMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, budgetMs)
    const settle = (): void => {
      clearTimeout(timer)
      resolve()
    }
    // step 自带降级不 reject；双面 settle 兼防未捕获拒绝
    p.then(settle, settle)
  })
}
