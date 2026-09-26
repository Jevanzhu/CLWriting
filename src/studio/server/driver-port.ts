/**
 * driver 注入面（/）。
 *
 * 组装根（index.ts 的 createStudioServer）**唯一**决定用哪个 driver 实现，并把
 * 「能力面 + 会话存取」作为依赖显式传到各路由；路由侧不再自取进程单例
 *（`getDriver`/`ensureSession` 的直调逐点改为经注入面）。
 *
 * 能力契约（收尾）：`src/driver/types.ts` 的 StudioDriver 已**全成员必需**——
 * 缺任一实现即类型错误，`interrupt` 等中断通道族不再以可选成员表达（「mock 不支持
 * 中断」以显式 no-op/常量实现声明，见 mock.ts）。本文件的 DriverCore/DriverExtensions
 * 分层与 bridgeToServiceDriver 的「缺失必需能力补留痕占位」运行时兜底随之删除：
 * 类型契约成立后兜底不可达，保留只会重新打开「缺实现静默降级」的口子（占位实现
 * 正是 fail-open 的变体）。消费点若有针对可选性的 `?.` / 探测残留，属消费面清理项，
 * 不在本文件（注入面本身无可选成员）。
 */
import type { Session, StudioDriver } from '../../driver/types.js'
import {
  getDriver as getDriverImpl,
  ensureSession as ensureSessionImpl,
  getSession as getSessionImpl,
  forgetSession as forgetSessionImpl,
} from '../../driver/index.js'

/**
 * 注入用 driver 面 = StudioDriver（全能力必需契约）。
 * 独立别名保留注入面命名（DriverHost.driver 的类型锚）；契约单源在 driver/types.ts。
 */
export type ServiceDriver = StudioDriver

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

/**
 * 生产 driver 宿主（组装根缺省值）。
 *
 * 环境变量 `CLWRITING_DRIVER` 的唯一读取点：选实现 + 决定 mock 快路（kind）都在这里
 * 一次完成，下游一切分支只读 host.kind，不各自读环境（「mock driver 只在组装根
 * 选择」）。driver 与会话存取经**取值器**转发到进程单例（不在组装时捕获实例：
 * 测试以 vi.mock 替换 driver/index.js 的导出后，宿主仍取到替身）。
 */
export function productionDriverHost(): DriverHost {
  const kind: 'cc' | 'mock' = process.env['CLWRITING_DRIVER'] === 'mock' ? 'mock' : 'cc'
  return {
    get driver(): ServiceDriver {
      return getDriverImpl()
    },
    ensureSession: (bookId, cwd) => ensureSessionImpl(bookId, cwd),
    getSession: (bookId) => getSessionImpl(bookId),
    forgetSession: (bookId) => forgetSessionImpl(bookId),
    kind,
  }
}
