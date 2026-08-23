/**
 * studio server 的 Electron utilityProcess 入口（阶段 22 批 U1）。
 *
 * main 侧 server-manager fork 本文件（dist/desktop/server-utility.js，asar 内路径
 * 等价），本入口只做三件事：解析 fork 参数 → 经 server-boot 共享核心起 server →
 * 把启动结果经 process.parentPort 默认消息通道握手回传（§3.2，二轮 F-2 统一
 * parentPort，不引入 MessageChannelMain 端口转移）。
 *
 * 握手协议（消息形状与 server-manager 配对，测试两侧锚定）：
 * - child → main：{ type: 'ready', port }（listening 后每 child 一次）
 *               { type: 'boot-error', code, message }（监听失败；发完即退出）
 * - main → child：{ type: 'shutdown' }（批 U2 下沉 shutdownStudio 后接线）
 *
 * 日志通道：本形态下 src/log 恒走 stdout（批 U2 起 fork 注入 CLW_LOG_STDOUT=1、
 * main 以 stdio:pipe 收行转发落盘——单写者，§3.5）；批 U1 中间态 initLogging
 * 仍直写 JSONL（startServer 内部行为），批 U2 收口。
 */
import process from 'node:process'
import { parseServerArgs, bootServerFromArgs, describeBootError, deriveStaticDir } from './server-boot.js'

const parsed = parseServerArgs(process.argv)
const parentPort = process.parentPort
if (!parentPort) {
  // 非 utility 进程态（误用 node 直跑等）——没有回传通道，stdout 留痕后退出
  console.error('[server-utility] 缺少 process.parentPort：本入口仅供 Electron utilityProcess fork 使用')
  process.exit(1)
}

bootServerFromArgs(parsed, deriveStaticDir(import.meta.url), {
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
