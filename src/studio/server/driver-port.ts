/**
 * driver 注入面（R0916-7-P3-6 / R0916-7-P3-16 driver 半条）。
 *
 * 组装根（index.ts 的 createStudioServer）**唯一**决定用哪个 driver 实现，并把
 * 「能力面 + 会话存取」作为依赖显式传到各路由；路由侧不再自取进程单例
 *（`getDriver()`/`ensureSession()` 的直调逐点改为经注入面）。
 *
 * 接口分层（P3-16「driver 拆出必需能力接口」）：
 * - DriverCore：**必需能力**——服务端消费点按本接口声明依赖，缺任一法在编译期不可表达
 *   （注入点拒收；见 test/studio/r0916-p3-6-assembly-root.test.ts 的 @ts-expect-error 探针）。
 *   startSession/stream/dispose 在 driver/types.ts 中本就非可选；emit/cancelStream 原为
 *   可选成员，但服务端对本进程内没有任何替代通道——`emit?.()` 静默跳过 = 编排进度永不
 *   到达前端，`cancelStream` 缺失 = SSE 断开后生成器滞留到下一次事件才推进 iter.return，
 *   故在本注入面提为必需。
 * - DriverExtensions：**可选扩展**（中断通道 interrupt/isRunning/isWriterRunning/
 *   registerCtrl/unregisterCtrl）——缺失只降级「在途任务能否被 /interrupt 命中」，
 *   不坏正确性（任务照常跑完、闸照常释放）。消费点必须显式分支 + 留痕（warn 口径见
 *   task-gate.ts 的 resolveInterruptChannel），不得静默跳过。
 *
 * 编译期之外的兜底：driver/types.ts（实现侧类型面）不在本批改动面，故进程单例
 * `src/driver/index.ts` 交给组装根时仍是「能力全可选」的 StudioDriver——由
 * bridgeToServiceDriver 逐能力补齐：缺失的必需能力补一个**留痕的**占位实现
 *（log.warn 一次，注明缺失能力与后果），使注入面类型为真且缺口可回溯。真驱动
 *（cc/mock）实现齐全，缺口只见于测试替身，故不 fail-fast（那会让替身驱动的端点
 * 整体不可用）。
 */
import type { DriverEvent, Session, SessionOptions, StudioDriver } from '../../driver/types.js'
import {
  getDriver as getDriverImpl,
  ensureSession as ensureSessionImpl,
  getSession as getSessionImpl,
  forgetSession as forgetSessionImpl,
} from '../../driver/index.js'
import { log } from '../../log/index.js'

/** 必需能力面（缺任一法不可作为注入面使用）。 */
export interface DriverCore {
  /** 起会话（cwd = 工作目录） */
  startSession(cwd: string, opts?: SessionOptions): Promise<Session>
  /** 流式事件（持续；done 表示单次生成完，不断流） */
  stream(session: Session): AsyncIterable<DriverEvent>
  /** 结束会话 */
  dispose(session: Session): void
  /** 事件回推单通道（编排进度 / 三审逐角等经此回前端 SSE） */
  emit(session: Session, ev: DriverEvent): void
  /** 唤醒 park 在内部等待上的 stream 生成器（SSE 断开即回收） */
  cancelStream(iter: AsyncIterable<DriverEvent>): void
}

/** 可选扩展面（中断通道）：消费点显式分支 + 留痕。 */
export interface DriverExtensions {
  interrupt?(session: Session): void
  isRunning?(session: Session): boolean
  isWriterRunning?(session: Session): boolean
  registerCtrl?(session: Session, ctrl: AbortController, owner?: string): void
  unregisterCtrl?(session: Session, ctrl: AbortController): void
}

/** 注入用 driver 面 = 必需能力 ∩ 可选扩展。 */
export type ServiceDriver = DriverCore & DriverExtensions

/**
 * driver 宿主 = 能力面 + 会话存取 + 选择结果。
 *
 * 所有权：宿主由组装根创建并持有；会话表的所有者是宿主实现（生产 = src/driver/index.ts
 * 的进程单例会话表，测试可自带隔离会话表）。路由侧只读使用，不自行建会话表。
 */
export interface DriverHost {
  readonly driver: ServiceDriver
  ensureSession(bookId: string, cwd: string): Promise<Session>
  getSession(bookId: string): Session | null
  forgetSession(bookId: string): void
  /** 驱动选择结果（'mock' = 假事件流，e2e / 前端调试）——mock 快路等分支只读本字段，
   *  不再各处读环境变量（选择点在组装根）。 */
  readonly kind: 'cc' | 'mock'
}

/** 必需能力名表（桥接与校验单源）。 */
const DRIVER_CORE_METHODS = ['startSession', 'stream', 'dispose', 'emit', 'cancelStream'] as const

/** 缺失必需能力时的留痕话术（一次缺口一条，可回溯到具体能力与后果）。 */
const CORE_MISSING_HINT: Record<(typeof DRIVER_CORE_METHODS)[number], string> = {
  startSession: '无法起会话（生成链路整体不可用）',
  stream: '无事件流（生成产出无法回流）',
  dispose: '会话无法释放',
  emit: '编排进度回推被丢弃（前端看不到逐角/自愈进度）',
  cancelStream: 'SSE 断开时生成器滞留到下一次事件才回收',
}

/**
 * 桥接进程单例 driver（能力全可选的实现侧类型）到注入面（能力必需）。
 * 缺失的必需能力补留痕占位：占位实现使调用不抛，缺口经 log.warn 可查（见文件头注）。
 */
export function bridgeToServiceDriver(raw: StudioDriver, label: string): ServiceDriver {
  const missing = DRIVER_CORE_METHODS.filter((m) => typeof raw[m] !== 'function')
  if (missing.length > 0) {
    log.warn(
      'driver',
      `注入驱动缺必需能力：${missing.map((m) => `${m}（${CORE_MISSING_HINT[m]}）`).join('；')}（${label}）——已补留痕占位使端点仍可用，但上述后果成立；真驱动实现齐全，缺实现多见于测试替身`,
    )
  }
  const fallback = (m: (typeof DRIVER_CORE_METHODS)[number]): unknown => {
    if (m === 'startSession') return async (cwd: string): Promise<Session> => ({ id: `missing-${label}`, cwd, closed: false })
    if (m === 'stream') return async function* (): AsyncIterable<DriverEvent> {}
    return (): void => {}
  }
  return new Proxy(raw as unknown as ServiceDriver, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (typeof v === 'function') return v
      const name = prop as (typeof DRIVER_CORE_METHODS)[number]
      if (DRIVER_CORE_METHODS.includes(name)) return fallback(name)
      return v
    },
  })
}

/**
 * 生产 driver 宿主（组装根缺省值）。
 *
 * 环境变量 `CLWRITING_DRIVER` 的唯一读取点：选实现 + 决定 mock 快路（kind）都在这里
 * 一次完成，下游一切分支只读 host.kind，不各自读环境（P3-6「mock driver 只在组装根
 * 选择」）。driver 与会话存取经**取值器**转发到进程单例（不在组装时捕获实例：
 * 测试以 vi.mock 替换 driver/index.js 的导出后，宿主仍取到替身）；桥接结果按实例
 * 身份记忆（同一 driver 只桥接一次——留痕不随每次取值重复，热路径零重付）。
 */
export function productionDriverHost(): DriverHost {
  const kind: 'cc' | 'mock' = process.env['CLWRITING_DRIVER'] === 'mock' ? 'mock' : 'cc'
  let bridgedRaw: StudioDriver | null = null
  let bridged: ServiceDriver | null = null
  return {
    get driver(): ServiceDriver {
      const raw = getDriverImpl()
      if (raw !== bridgedRaw || bridged === null) {
        bridgedRaw = raw
        bridged = bridgeToServiceDriver(raw, kind)
      }
      return bridged
    },
    ensureSession: (bookId, cwd) => ensureSessionImpl(bookId, cwd),
    getSession: (bookId) => getSessionImpl(bookId),
    forgetSession: (bookId) => forgetSessionImpl(bookId),
    kind,
  }
}
