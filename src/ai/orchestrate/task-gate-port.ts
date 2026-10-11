/**
 * task-gate 服务端口（ai→studio 反向依赖收口）。
 *
 * 背景：chat 的 REWRITE_GATE_TOOLS 与 write_chapter
 * 需要与 studio /rewrite 端点共 task-gate 'rewrite' 一把闸互斥；ai 层直接反向
 * import studio/server/api/task-gate 是分层倒置。task-gate 自身依赖 ai/orchestrate
 * 四个在途态查询（isSelfHealRunning/isChatRunning/hasBackgroundTasks/isSpawnRunning），
 * 无法下沉中性层，故走「依赖倒置 + 表现层注册」：ai 层只持端口契约，真实闸由
 * stream.ts registerStreamRoutes 注入（同款注册原语先例见 runner.ts
 * registerDegradedPersist）。
 *
 * 口径：未注册（纯 ai 层单测 / 无服务形态）→ 返回 no-op release（放行）**并留痕**——
 * 端口缺失不得让 chat 工具全数 409（合法降级路径：无服务形态的 ai 层装配本就没有
 * 跨任务互斥的对象），但静默放行会让接线遗漏（生产忘了注册）退化成「chat 写工具绕过
 * 跨任务互斥」且无任何痕迹。故保留放行、留一条带书本/动作的告警，让缺位可诊断。
 * 不抛错的依据：抛错会把「无服务形态的正常装配」一并打死（ai 层单测直接调 chat 工具
 * 的形态没有闸可注册），而缺位的真实危害是「并发互斥失效」而非「调用必须失败」——
 * 留痕 + 放行的保守度与该风险相称；生产装配恒经 registerStreamRoutes 注册
 * （源锚见 test/ai/task-gate-port.test.ts），告警只在异常装配时出现，不构成正常路径噪声。
 *
 * 注册槽随端口实例化——裸模块级 `let provider` 收进 createTaskGatePort 的实例槽位，
 * 模块级函数保留为**进程默认端口**的委托壳（与 task-gate.ts 的进程默认实例委托壳
 * 同型）：stream.ts 与既有测试按模块级函数取用，语义不变；同进程需要第二套注册面时
 *（组装根多实例的未来形态）可自建端口实例。
 * 注意：acquire 调用面（chat 工具）无实例判别信息，进程默认端口仍是单通道——最后注册
 * 者生效（生产单 server 进程一份，无差异）。
 */
import { log } from '../../log/index.js'

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
      if (!provider) {
        // 未注册：no-op release 放行（见头注口径）——留痕使接线遗漏可诊断，
        // 告警带书本/动作足以定位是哪一次取闸落到了无闸形态
        log.warn(
          'task-gate',
          JSON.stringify({
            msg: 'task-gate 端口未注册——本次取闸放行（跨任务互斥未生效）',
            bookName,
            action,
          }),
        )
        return (): void => {}
      }
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
