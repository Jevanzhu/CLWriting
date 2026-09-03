#!/usr/bin/env node
/**
 * 编译产物独立 server 入口（发布 smoke 用，U-P2-24）。
 *
 * Electron main 内嵌的是同一个 studio server 模块；此入口让打包产物
 * （dist/desktop 本文件 + dist/web 静态前端）在无 GUI 的 e2e 环境可直接
 * 启动验证——发布前跑 npm run test:e2e:release。
 *
 * 参数组装 / listening-error 信封化已收敛 server-boot 共享核心（U-3，与
 * server-utility 入口单一真相源）；本文件只留 node 直跑形态差异：端口缺省
 * 7878（env CLWRITING_PORT）、userDataPath 缺省 defaultUserDataPath()、
 * SIGINT/SIGTERM 优雅退出。
 *
 * 用法：node dist/desktop/server-main.js --dir <workDir> --port <port>
 * 环境变量照常透传（CLWRITING_DRIVER=mock 可脱离大模型跑通全链路）。
 */
import process from 'node:process'
import { parseServerArgs, bootServerFromArgs, describeBootError, deriveStaticDir, resolveEnvPort } from './server-boot.js'
import { defaultUserDataPath } from '../fs/user-data-path.js'
import { log } from '../log/index.js'

// node 直跑形态缺省与拆分前逐字一致：--port > CLWRITING_PORT > 7878
// R39-9：env 值经 resolveEnvPort 校验（非法 fatal 人话退出），NaN/'' 不再透传 listen
const parsed = parseServerArgs(process.argv, { portDefault: resolveEnvPort(process.env) })
// dd-P3（C-P3-16）：APP 级数据目录与 Electron 态同源（providers/全局偏好/RAG 提供方都在这里），
// 缺省时 startServer 视为未定位 → 发布冒烟读不到真实配置，验证面就窄了一截
if (parsed.userDataPath === null) parsed.userDataPath = defaultUserDataPath()
const staticDir = deriveStaticDir(import.meta.url)

const server = bootServerFromArgs(parsed, staticDir, {
  onReady: (actualPort) => {
    // 用实际监听端口（--port 0 随机端口时与配置值不同）。L1：走 logger 进 JSONL（此前
    // console.log 绕过日志体系，同文件其余路径都用 log.error）
    log.info('server-main', `ready on http://127.0.0.1:${actualPort} (static: ${staticDir})`)
  },
  // RB-SV-P2-3：监听错误兜底——EADDRINUSE 等给出可读中文后退出，而非未捕获异常崩溃
  onBootError: (err) => {
    const envelope = describeBootError(err, parsed.port)
    log.error('server-main', envelope.message, err)
    process.exit(1)
  },
})

// M-8：close 对 SSE/keep-alive 长连接会悬置回调（graceful-shutdown 同因）——独立
// server 入口此前无兜底，e2e 残留连接时进程挂在信号上杀不掉。2s 超时强制退出
//（与 Electron 态 before-quit 的总超时同量级；幂等防双信号双触发）
let exiting = false
const exitNow = (): void => {
  if (exiting) return
  exiting = true
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(exitNow)
    // R-20（第十六轮）：兜底超时 unref + close 先到即清——server 顺利 close 后定时器
    // 不再作为活跃句柄拖慢退出
    const t = setTimeout(exitNow, 2_000)
    t.unref()
  })
}
