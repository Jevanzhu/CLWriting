#!/usr/bin/env node
/**
 * 编译产物独立 server 入口（发布 smoke 用）。
 *
 * Electron main 内嵌的是同一个 studio server 模块；此入口让打包产物
 * （dist/desktop 本文件 + dist/web 静态前端）在无 GUI 的 e2e 环境可直接
 * 启动验证——发布前跑 npm run test:e2e:release。
 *
 * 参数组装 / 启动事件信封化已收敛 server-boot 共享核心（与
 * server-utility 入口单一真相源）；本文件只留 node 直跑形态差异：端口缺省
 * 7878（env CLWRITING_PORT）、userDataPath 缺省 defaultUserDataPath、
 * SIGINT/SIGTERM 优雅退出。
 *
 * 单立：入口解耦——胶水与信号兜底收编为导出函数
 * （runServerMain / installSignalFallback），顶层只留 VITEST 探针守卫 + 接线
 * （先例 server-utility.ts）。此前整文件顶层执行（import 即读 argv / 真绑端口 /
 * 真注册信号），vitest 无法进程内测——信号兜底修复（/
 *）长期无测试装置即此因。
 *
 * 用法：node dist/desktop/server-main.js --dir <workDir> --port <port>
 * 环境变量照常透传（CLWRITING_DRIVER=mock 可脱离大模型跑通全链路）。
 */
import process from 'node:process'
import type http from 'node:http'
import {
  parseServerArgs,
  bootServerFromArgs,
  describeBootError,
  deriveStaticDir,
  resolveEnvPort,
} from './server-boot.js'
import { defaultUserDataPath } from '../fs/user-data-path.js'
import { errMsg, log } from '../log/index.js'

/**
 * node 直跑形态胶水（独立导出以便测试；行为与解耦前逐字一致）。
 * 返回 server 实例（供 installSignalFallback 接线 / 测试断言）。
 */
export function runServerMain(argv: string[], env: Record<string, string | undefined>, moduleUrl: string): http.Server {
  // node 直跑形态缺省与拆分前逐字一致：--port > CLWRITING_PORT > 7878
  // env 值经 resolveEnvPort 校验（非法 fatal 人话退出），NaN/'' 不再透传 listen
  const parsed = parseServerArgs(argv, { portDefault: resolveEnvPort(env) })
  // dd-APP 级数据目录与 Electron 态同源（providers/全局偏好/RAG 提供方都在这里），
  // 缺省时 startServer 视为未定位 → 发布冒烟读不到真实配置，验证面就窄了一截
  if (parsed.userDataPath === null) parsed.userDataPath = defaultUserDataPath()
  const staticDir = deriveStaticDir(moduleUrl)
  return bootServerFromArgs(parsed, staticDir, {
    onReady: (actualPort) => {
      // 用实际监听端口（--port 0 随机端口时与配置值不同）。走 logger 进 JSONL（此前
      // console.log 绕过日志体系，同文件其余路径都用 log.error）
      log.info('server-main', `ready on http://127.0.0.1:${actualPort} (static: ${staticDir})`)
    },
    // 监听错误兜底——EADDRINUSE 等给出可读中文后退出，而非未捕获异常崩溃
    onBootError: (err) => {
      const envelope = describeBootError(err, parsed.port)
      log.error('server-main', envelope.message, err)
      process.exit(1)
    },
  })
}

/** 信号兜底所需的最小 server 契约（测试可注入假件，http.Server 结构满足） */
interface ClosableServer {
  close(callback?: (err?: Error | null) => void): unknown
}

/**
 * 信号兜底（独立导出以便测试；三锚语义与解耦前逐字一致）。
 * 返回清理函数（摘除本组 handler + 清在途兜底 timer）——测试拆除用；真实入口不调
 * （进程生命周期即安装周期）。
 */
export function installSignalFallback(server: ClosableServer): () => void {
  // close 对 SSE/keep-alive 长连接会悬置回调（graceful-shutdown 同因）——独立
  // server 入口此前无兜底，e2e 残留连接时进程挂在信号上杀不掉。2s 超时强制退出
  //（与 Electron 态 before-quit 的总超时同量级；幂等防双信号双触发）
  let exiting = false
  // close 回调 err 分流——原 exitNow 恒 exit(0)，server.close(err)
  //（close 途中连接/监听器异常等真实故障）被吞成成功退出，发布 smoke 对非零关闭零感知。
  // 带 err → log 留痕 + exit(1)；无 err → exit(0) 原语义（2s 兜底 timer 经 setTimeout 零参
  // 触发本函数，同落 exit(0) 档）。幂等（exiting）不变：close 先到与兜底到点只退一次。
  const exitNow = (err?: Error | null): void => {
    if (exiting) return
    exiting = true
    if (err) {
      log.error('server-main', `server close 失败（以非零码退出）：${errMsg(err)}`, err)
      process.exit(1)
      return
    }
    process.exit(0)
  }
  // 兜底超时句柄单槽——原每个
  // 信号各排一个 2s timer 不清旧：SIGINT+SIGTERM 连发（Ctrl+C 后补 kill / 进程管理器
  // 双信号）叠两个等价兜底（exiting 幂等无害但句柄滞留、多排违 timer 纪律）。排前查重，
  // 已有在途兜底则跳过。
  let exitFallbackTimer: ReturnType<typeof setTimeout> | null = null
  const onSignal = (): void => {
    server.close(exitNow)
    // 兜底超时 unref + close 先到即清——server 顺利 close 后定时器
    // 不再作为活跃句柄拖慢退出。已有在途兜底不重排（重复信号安全）
    if (!exitFallbackTimer) {
      exitFallbackTimer = setTimeout(exitNow, 2_000)
      exitFallbackTimer.unref()
    }
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, onSignal)
  }
  return () => {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.removeListener(sig, onSignal)
    }
    if (exitFallbackTimer) {
      clearTimeout(exitFallbackTimer)
      exitFallbackTimer = null
    }
  }
}

// 顶层接线——vitest 探针（先例 server-utility.ts）：测试态 import 只留痕不启动
// （避免真绑端口 + 真注册信号杀测试进程），运行态经导出胶水直跑
if (process.env['VITEST'] === 'true') {
  console.error(
    '[server-main][vitest] 测试态 import（预期）：顶层接线跳过，运行态仅供 node dist/desktop/server-main.js 直跑',
  )
} else {
  installSignalFallback(runServerMain(process.argv, process.env, import.meta.url))
}
