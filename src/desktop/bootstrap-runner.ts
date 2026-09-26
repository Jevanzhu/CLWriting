/**
 * bootstrap 生命周期 runner——原 main.ts 内联闭包抽出可测。
 *
 * 收编三段历史修复语义（行为零变更，main.ts 接线见调用处）：
 * 并发重入防护：进行中（bootstrapping）重复调用直接挡掉；完成/失败后可重试
 *   （保 activate 重建窗口语义）；
 * -：上次 bootstrap 若在 startServer 之后失败（如 loadURL 抛错），重试会
 *   再起新 server 覆盖变量、旧 server 端口/SSE 计数滞留至进程退出——重试前先关旧的；
 * - 低-8：退出途中（shutdownStarted 已置位）不再重 bootstrap（before-quit
 *   的 2s 优雅退出窗口内 macOS dock 点击仍会触发 activate）。
 */

interface BootstrapRunnerDeps {
  /** 「重试前关旧 server」的清理对象。拆分后语义换轨：main 接线
   *  传 server-manager 的停旧 child 适配器（close = kill + 等退出，下一次 start 先等
   *  旧 child 退出再 fork）；server 生命周期归 manager 自持。
   * （打包）：close 允许返回 Promise——runner 会等其落定再开跑新 bootstrap，
   *  消除原 fire-and-forget（关旧未收口即 fork 新 child 的竞态缝）。
   * setStudioServer 成员删除——child 生命周期归
   *  serverManager 自持后该成员生产恒 no-op（main 恒传 ` => undefined`，runner 旧
   *  实现 close 后调 `deps.setStudioServer(null)` 写 nowhere），属死接口面；随调用点
   *  一并移除（行为零变化——no-op 调用本无副作用）。 */
  getStudioServer: () => { close: () => void | Promise<void> } | null
}

interface BootstrapRunner {
  /** 入口：并发重入挡 + 重试前清旧 server + bootstrap 失败走 onError（完成后可再调） */
  runBootstrap(onError?: (e: unknown) => void): void
  /** before-quit 置位：置位后 runBootstrap 直通不再起 server/开窗；返回是否首次置位 */
  beginShutdown(): boolean
  /** 退出已开始（activate 守卫判据） */
  readonly shuttingDown: boolean
}

export function createBootstrapRunner(deps: BootstrapRunnerDeps, bootstrap: () => Promise<void>): BootstrapRunner {
  let bootstrapping = false
  let shutdownStarted = false
  return {
    runBootstrap(onError?: (e: unknown) => void): void {
      if (bootstrapping) return
      if (shutdownStarted) return
      bootstrapping = true // 先占重入门再进异步体：关旧 server 的 await 期间并发调用同样被挡
      void (async () => {
        try {
          // 上次失败若发生在 startServer 之后，旧 server 滞留——重试前先关
          // 条件改为「存在旧 server 即关」——原叠加 mainWindow === null 的
          // 判据自相矛盾（deps.getMainWindow 原是「重试关旧 server 的判据」注释语义的残留，
          // 随死接线一并删除）：重试
          // 本就要重建 bootstrap（含新 server/新窗口），旧 server 无论窗口在否都已被新一次
          // startServer 覆盖变量而泄漏端口/连接，不关才是不安全侧
          // （打包）：close() 同步先调（兼容旧口径），若返回 Promise 则等其
          // 落定再开跑——原 fire-and-forget 会在旧 server 未收口（端口/连接未清）时就
          // fork 新 child，重开「重试前关旧」要堵的正是这个缝
          // 原 `deps.setStudioServer(null)` 随死接口面删除
          const old = deps.getStudioServer()
          if (old !== null) {
            const closing = old.close()
            if (closing) await closing
          }
          await bootstrap()
        } catch (e) {
          onError?.(e)
        } finally {
          bootstrapping = false
        }
      })()
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
