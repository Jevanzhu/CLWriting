/**
 * 路由 ctx 注入面测试助手（R0916-7-P3-6）。
 *
 * 直调 registerXxxRoutes 的用例（不起 server，只测单一端点族的 handler）需要给出
 * 组装根本会解析的三件注入项。这里给的是**进程默认**取值（同 startServer 的生产组装）：
 * 闸表与模块级委托壳同源、driver 宿主转发 driver/index.js（vi.mock 仍可拦截）、
 * provider 运行时直连 store——即「以生产口径组装」的等价写法。
 *
 * 要隔离闸表/会话/回调注册面的用例，请自行 createTaskGate / 自建 DriverHost 传入。
 */
import { processTaskGate, type TaskGate } from '../../../src/studio/server/api/task-gate.js'
import { productionDriverHost, type DriverHost } from '../../../src/studio/server/driver-port.js'
import { processProviderRuntime, type ProviderRuntime } from '../../../src/ai/provider/store.js'

export interface RouteDeps {
  gate: TaskGate
  driver: DriverHost
  providers: ProviderRuntime
}

/** 生产口径的路由注入面（每次调用新建 driver 宿主与运行时对象；闸为进程默认实例）。 */
export function processRouteDeps(): RouteDeps {
  return { gate: processTaskGate(), driver: productionDriverHost(), providers: processProviderRuntime() }
}
