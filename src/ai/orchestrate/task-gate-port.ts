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
 *
 * R0916-7-P3-6 收编：注册槽随端口实例化——原裸模块级 `let provider` 收进
 * createTaskGatePort 的实例槽位，模块级函数保留为**进程默认端口**的委托壳（与
 * task-gate.ts 的进程默认实例委托壳同型）：stream.ts 与既有测试按模块级函数取用，
 * 语义逐位不变；同进程需要第二套注册面时（组装根多实例的未来形态）可自建端口实例。
 * 如实记：acquire 调用面（chat 工具）无实例判别信息，进程默认端口仍是单通道——
 * 最后注册者生效（生产单 server 进程一份，无差异）；多实例判据测试不依赖本端口
 *（chat 工具闸属进程级编排面，与 isChatRunning 等在途表同层，收口见评审报告遗留项）。
 */

/** 与 studio/server/api/task-gate.ts acquireTaskGate 同形（闸满返回 null = fail-closed） */
type TaskGateAcquire = (bookName: string, action: string) => (() => void) | null

export interface TaskGatePort {
  /** 表现层注册真实闸（幂等：重注册覆盖；registerStreamRoutes 每次服务构造都会调用） */
  register(acquire: TaskGateAcquire): void
  /** chat 工具侧唯一取闸入口（turns.ts REWRITE_GATE_TOOLS / write_chapter）；
   *  未注册返回 no-op release（放行，见头注口径） */
  acquire(bookName: string, action: string): (() => void) | null
  /** 测试钩子：清空注册（验证未注册放行形态；生产零调用） */
  resetForTest(): void
}

export function createTaskGatePort(): TaskGatePort {
  let provider: TaskGateAcquire | null = null
  return {
    register: (acquire) => {
      provider = acquire
    },
    acquire: (bookName, action) => {
      if (!provider) return (): void => {} // 未注册：no-op release 放行（见头注口径）
      return provider(bookName, action)
    },
    resetForTest: () => {
      provider = null
    },
  }
}

/** 进程默认端口（模块级委托壳的状态归属；生产注册面）。 */
const processPort = createTaskGatePort()

/** 表现层注册真实闸（进程默认端口委托壳；语义见 TaskGatePort.register）。 */
export function registerTaskGateProvider(acquire: TaskGateAcquire): void {
  processPort.register(acquire)
}

/** chat 工具侧唯一取闸入口（进程默认端口委托壳）。 */
export function acquireTaskGateViaPort(bookName: string, action: string): (() => void) | null {
  return processPort.acquire(bookName, action)
}

/** 测试钩子：清空进程默认端口注册（防跨用例泄漏；生产零调用）。 */
export function resetTaskGateProviderForTest(): void {
  processPort.resetForTest()
}
