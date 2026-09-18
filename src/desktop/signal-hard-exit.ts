/**
 * 0918二轮修复批（C107）：Electron 主进程重复信号硬退出口（可测小模块——对齐
 * bootstrap-runner / server-utility 的拆分纪律：信号响应逻辑收编此处，main.ts 只留
 * process.on 接线）。
 *
 * 背景：R1W-9/R38-19 起 SIGINT/SIGBREAK/SIGTERM 注册 `() => app.quit()`——注册后
 * Node 默认退出取消，重复信号被 quit 链的幂等门（quitViaShutdown / beginShutdown）
 * 吸收，优雅链最坏 ~10s（close flush 4s 预算 + shutdown 3.5s 总超时）内二次信号
 * 无效，dev 终端狂按 Ctrl+C 无法加速退出。
 *
 * 语义：同型信号计数——首次走既有优雅退出链（app.quit()，单次语义不变）；同型信号
 * 第二次到达直接走硬退出口（先 killNow 同步对在途 server child 发 kill——复用
 * server-manager killNow，与 main.ts uncaughtException 处理器 R0912-3 #35「先 kill
 * 再硬退」同口径，防 utilityProcess 孤儿——再 process.exit(1)）+ error 留痕。
 * 异型信号不互触发（SIGINT 后 SIGTERM 仍是各自首例，各走一次优雅链——app.quit
 * 幂等无害）。
 */
import { log } from '../log/index.js'

export interface RepeatedSignalExitDeps {
  /** 首次信号：走既有优雅退出链（app.quit()——幂等门防重入，单次优雅语义不变） */
  requestGracefulQuit: () => void
  /** 硬退前置：同步对在途 server child 发 kill（serverManager.killNow；失败不影响退出） */
  killNow: () => void
  /** 硬退出（process.exit） */
  exit: (code: number) => void
}

/**
 * 创建信号处理器：返回可直接挂 `process.on(sig, () => h(sig))` 的响应函数。
 * 计数按信号名分槽（同型第二次才硬退）。
 */
export function createRepeatedSignalExit(deps: RepeatedSignalExitDeps): (signal: string) => void {
  const seen = new Set<string>()
  return (signal: string): void => {
    if (seen.has(signal)) {
      log.error('desktop', `信号 ${signal} 在优雅停机在途时重复到达——跳过优雅链直接硬退出（在途 server child 已同步 kill）`)
      deps.killNow()
      deps.exit(1)
      return
    }
    seen.add(signal)
    deps.requestGracefulQuit()
  }
}
