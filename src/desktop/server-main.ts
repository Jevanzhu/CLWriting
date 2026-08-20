#!/usr/bin/env node
/**
 * 编译产物独立 server 入口（发布 smoke 用，U-P2-24）。
 *
 * Electron main 内嵌的是同一个 studio server 模块；此入口让打包产物
 * （dist/desktop 本文件 + dist/web 静态前端）在无 GUI 的 e2e 环境可直接
 * 启动验证——发布前跑 npm run test:e2e:release。
 *
 * 用法：node dist/desktop/server-main.js --dir <workDir> --port <port>
 * 环境变量照常透传（CLWRITING_DRIVER=mock 可脱离大模型跑通全链路）。
 */
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startServer } from '../studio/server/index.js'
import { defaultUserDataPath } from '../fs/user-data-path.js'
import { log } from '../log/index.js'

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i !== -1 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null
}

const port = Number(argValue('--port') ?? process.env['CLWRITING_PORT'] ?? 7878)
const workDir = argValue('--dir') ?? undefined
// 静态前端与 Electron 态同一落点：dist/web（相对编译产物的本文件定位）
const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

// dd-P3（C-P3-16）：APP 级数据目录与 Electron 态同源（providers/全局偏好/RAG 提供方都在这里），
// 缺省时 startServer 视为未定位 → 发布冒烟读不到真实配置，验证面就窄了一截
const server = startServer({ port, workDir, staticDir, userDataPath: defaultUserDataPath() })
// RB-SV-P2-3：监听错误兜底——EADDRINUSE 等给出可读中文后退出，而非未捕获异常崩溃
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error('server-main', `端口 ${port} 已被占用（EADDRINUSE），请释放占用进程或用 --port 换端口`, err)
  } else {
    log.error('server-main', `server 启动失败：${err.message}`, err)
  }
  process.exit(1)
})
server.on('listening', () => {
  // 用实际监听端口（--port 0 随机端口时与配置值不同）。L1：走 logger 进 JSONL（此前
  // console.log 绕过日志体系，同文件其余路径都用 log.error）
  const addr = server.address()
  const actualPort = addr && typeof addr === 'object' ? addr.port : port
  log.info('server-main', `ready on http://127.0.0.1:${actualPort} (static: ${staticDir})`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
  })
}
