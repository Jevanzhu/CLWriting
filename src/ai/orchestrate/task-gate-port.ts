/**
 * task-gate 服务端口（R0912：重评-0911b P2③ / 重评-0911c 两轮登记的 ai→studio
 * 反向依赖收口）。
 *
 * 背景（原 turns.ts 头部债务注释沿革）：chat 的 REWRITE_GATE_TOOLS 与 write_chapter
 * 需要与 studio /rewrite 端点共 task-gate 'rewrite' 一把闸互斥；此前 ai 层直接反向
 * import studio/server/api/task-gate（分层倒置）。task-gate 自身依赖 ai/orchestrate
 * 四个在途态查询（isSelfHealRunning/isChatRunning/hasBackgroundTasks/isSpawnRunning），
 * 无法下沉中性层，故走「依赖倒置 + 表现层注册」：ai 层只持端口契约，真实闸由
 * stream.ts registerStreamRoutes 注入（R37-21 同款注册原语先例见 runner.ts
 * registerDegradedPersist）。
 *
 * 口径：未注册（纯 ai 层单测 / 无服务形态）→ 返回 no-op release（放行）——端口缺失
 * 不得让 chat 工具全数 409；生产路径注册缺位的回归由
 * test/studio/r0912-task-gate-port.test.ts 源锚测试锁死（registerStreamRoutes 必调
 * registerTaskGateProvider）。
 */

/** 与 studio/server/api/task-gate.ts acquireTaskGate 同形（闸满返回 null = fail-closed） */
export type TaskGateAcquire = (bookName: string, action: string) => (() => void) | null

let provider: TaskGateAcquire | null = null

/** 表现层注册真实闸（幂等：重注册覆盖；registerStreamRoutes 每次服务构造都会调用） */
export function registerTaskGateProvider(acquire: TaskGateAcquire): void {
  provider = acquire
}

/** 测试钩子：清空注册（验证未注册放行形态；生产零调用） */
export function resetTaskGateProviderForTest(): void {
  provider = null
}

/** chat 工具侧唯一取闸入口（turns.ts REWRITE_GATE_TOOLS / write_chapter） */
export function acquireTaskGateViaPort(bookName: string, action: string): (() => void) | null {
  if (!provider) return (): void => {} // 未注册：no-op release 放行（见头注口径）
  return provider(bookName, action)
}
