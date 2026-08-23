/**
 * studio server 的 Electron utilityProcess 入口（阶段 22 批 U1/U2）。
 *
 * main 侧 server-manager fork 本文件（dist/desktop/server-utility.js，asar 内路径
 * 等价），本入口只做：解析 fork 参数 → 经 server-boot 共享核心起 server → 把启动
 * 结果经 process.parentPort 默认消息通道握手回传（§3.2，二轮 F-2 统一 parentPort，
 * 不引入 MessageChannelMain 端口转移）。
 *
 * 握手协议（消息形状与 server-manager 配对，测试两侧锚定）：
 * - child → main：{ type: 'ready', port }（listening 后每 child 一次）
 *               { type: 'boot-error', code, message }（监听失败；发完即退出）
 *               { type: 'shutdown-done' }（批 U2：shutdown 指令执行完回执）
 * - main → child：{ type: 'shutdown' }（批 U2：执行 shutdownStudio 全流程——在途
 *   编排 abort/session/end 落库 + server.close，超时参数同拆分前 main 内嵌态——
 *   该职责随 server 下沉，main 不再 import graceful-shutdown）
 *
 * 日志通道（批 U2 起）：fork 注入 CLW_LOG_STDOUT=1，src/log stdout-only 模式直写
 * stdout 一行 JSON；main 以 stdio:pipe 收行解析重发落盘（单写者，§3.5）。
 */
import process from 'node:process'
import type http from 'node:http'
import { parseServerArgs, bootServerFromArgs, describeBootError, deriveStaticDir, type ParsedServerArgs } from './server-boot.js'
import { shutdownStudio } from './graceful-shutdown.js'

/** parentPort 最小契约（Electron ParentPort 的 MessageEvent 包裹：消息在 e.data） */
export interface ParentPortLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data?: unknown }) => void): unknown
}

/**
 * utility 入口主流程（独立导出以便测试；顶层仅接线）。
 * 返回 server 实例（测试断言用）；无 parentPort 的非 utility 态打印后由调用方处置。
 */
export function runUtilityEntry(parentPort: ParentPortLike, parsed: ParsedServerArgs): http.Server {
  const server = bootServerFromArgs(parsed, deriveStaticDir(import.meta.url), {
    onReady: (port) => {
      parentPort.postMessage({ type: 'ready', port })
    },
    onBootError: (err) => {
      // 信封化（EADDRINUSE 中文口径）后回传再退出——main 侧对首启失败弹原生对话框
      const envelope = describeBootError(err, parsed.port)
      parentPort.postMessage({ type: 'boot-error', code: envelope.code, message: envelope.message })
      process.exit(1)
    },
  })
  // main → child：shutdown 指令（before-quit 下发）——执行 shutdownStudio 全流程后
  // 回执退出；main 侧另有总超时（E-1：3.5s，覆盖本流程 close+settle 最坏预算）+ kill
  // 兜底，不等本回执也安全（§3.4 时序 4）
  parentPort.on('message', (event: { data?: unknown }) => {
    const msg = event.data as { type?: string } | undefined
    if (msg?.type !== 'shutdown') return
    void shutdownStudio(() => parsed.workDir, server)
      .catch(() => {}) // 收尾失败也必须回执退出——main 总超时兜底，不让 child 挂死
      .finally(() => {
        parentPort.postMessage({ type: 'shutdown-done' })
        process.exit(0)
      })
  })
  return server
}

const parentPort = process.parentPort
if (!parentPort) {
  // 无 parentPort 的两种形态分开留痕（P3：原共用一条消息，测试态 import 的预期探针
  // 与误用直跑的报错在日志里不可区分）——vitest 探针带 [vitest] 前缀 + info 级语义，
  // 误用直跑保持 error 口径不变：
  if (process.env['VITEST'] === 'true') {
    // vitest import 本模块做单测时同样无 parentPort：只留痕不退出，避免杀 worker
    console.error('[server-utility][vitest] 测试态 import（无 process.parentPort，属预期）：本入口运行态仅供 Electron utilityProcess fork 使用')
  } else {
    // 非 utility 进程态（误用 node 直跑等）——没有回传通道，stdout 留痕后退出
    console.error('[server-utility] 缺少 process.parentPort：本入口仅供 Electron utilityProcess fork 使用')
    process.exit(1)
  }
} else {
  runUtilityEntry(parentPort, parseServerArgs(process.argv))
}
