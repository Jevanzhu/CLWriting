/**
 * O-4（第十三轮）：bootstrap 生命周期 runner——原 main.ts 内联闭包抽出可测。
 *
 * 收编三段历史修复语义（行为零变更，main.ts 接线见调用处）：
 * - Y-P2-7 并发重入防护：进行中（bootstrapping）重复调用直接挡掉；完成/失败后可重试
 *   （保 activate 重建窗口语义）；
 * - 第九轮 L-3：上次 bootstrap 若在 startServer 之后失败（如 loadURL 抛错），重试会
 *   再起新 server 覆盖变量、旧 server 端口/SSE 计数滞留至进程退出——重试前先关旧的；
 * - 低-8（第十轮）：退出途中（shutdownStarted 已置位）不再重 bootstrap（before-quit
 *   的 2s 优雅退出窗口内 macOS dock 点击仍会触发 activate）。
 */

export interface BootstrapRunnerDeps {
  /** 当前主窗口（R-14（第十六轮）后不再是重试关旧 server 的判据——存在旧 server 即关；
   *  字段保留兼容 main.ts 接线） */
  getMainWindow: () => unknown
  /** 内嵌 server（startServer 之后失败的滞留清理对象） */
  getStudioServer: () => { close: () => void } | null
  setStudioServer: (server: { close: () => void } | null) => void
}

export interface BootstrapRunner {
  /** 入口：并发重入挡 + 重试前清旧 server + bootstrap 失败走 onError（完成后可再调） */
  runBootstrap(onError?: (e: unknown) => void): void
  /** before-quit 置位：置位后 runBootstrap 直通不再起 server/开窗；返回是否首次置位 */
  beginShutdown(): boolean
  /** 退出已开始（activate 守卫判据） */
  readonly shuttingDown: boolean
}

export function createBootstrapRunner(
  deps: BootstrapRunnerDeps,
  bootstrap: () => Promise<void>,
): BootstrapRunner {
  let bootstrapping = false
  let shutdownStarted = false
  return {
    runBootstrap(onError?: (e: unknown) => void): void {
      if (bootstrapping) return
      if (shutdownStarted) return
      // 第九轮 L-3：上次失败若发生在 startServer 之后，旧 server 滞留——重试前先关
      // R-14（第十六轮）：条件改为「存在旧 server 即关」——原叠加 mainWindow === null 的
      // 判据自相矛盾（getMainWindow 是「重试关旧 server 的判据」注释语义的残留）：重试
      // 本就要重建 bootstrap（含新 server/新窗口），旧 server 无论窗口在否都已被新一次
      // startServer 覆盖变量而泄漏端口/连接，不关才是不安全侧
      if (deps.getStudioServer() !== null) {
        deps.getStudioServer()!.close()
        deps.setStudioServer(null)
      }
      bootstrapping = true
      void bootstrap()
        .catch((e) => onError?.(e))
        .finally(() => {
          bootstrapping = false
        })
    },
    beginShutdown(): boolean {
      if (shutdownStarted) return false
      shutdownStarted = true
      return true
    },
    get shuttingDown(): boolean {
      return shutdownStarted
    },
  }
}
