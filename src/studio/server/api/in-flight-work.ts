/**
 * R0910-W：server 层在途外部工作登记（Worker 线程 / SQLite 写收尾）。
 *
 * 动因：重建（runRebuildAsync）/ 导出（runExportBookAsync）/ 文风扫描（runStyleScanAsync）
 * 的 Worker 线程此前不受 server 生命周期约束——请求连接可先被客户端断开（页面关闭/
 * 刷新），handler 仍在 await worker，`server.close()` 只等连接清空即回调，worker 仍持
 * `.cache/index.db` 句柄在写盘；调用方（集成测试/e2e）close 后立刻 rmSync 在 Windows
 * 上落 ENOTEMPTY。本表把这类跨线程工作在 server 侧登记，close 收尾（index.ts）与
 * graceful-shutdown 在有界预算内等它 settle（超时放行，与既有 settle 超时同口径）。
 *
 * 纪律：登记不改变 fire-and-forget 语义（promise 原样返回，各调用点仍自留痕降级）；
 * 等待必有界（deadline + 外层 race 兜底），绝不无限期阻塞退出。
 */
const inFlight = new Set<Promise<unknown>>()

/** 登记一个在途外部工作 promise（原样返回；settle 即从表移除，rejection 自吞不外抛）。 */
export function trackInFlightWork<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p)
  const done = (): void => {
    inFlight.delete(p)
  }
  void p.then(done, done)
  return p
}

/** R0910-W：测试观测钩子——断言登记/清理。 */
export function __getInFlightWorkCount(): number {
  return inFlight.size
}

/** R0910-W：有界等全部在途外部工作 settle（无在途立即返回；超时放行）。 */
export async function waitInFlightWorkSettled(timeoutMs: number): Promise<void> {
  if (inFlight.size === 0) return
  const deadline = Date.now() + timeoutMs
  while (inFlight.size > 0 && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise<void>((r) => {
        setTimeout(r, Math.min(50, remaining)).unref()
      }),
    ])
  }
}
