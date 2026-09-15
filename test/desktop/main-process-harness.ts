/**
 * R0916-5b（2026-09-16，main.test.ts 拆分批）：④批 P2 监听器治理 harness 共享件。
 *
 * 来源：test/desktop/main.test.ts 文件级 process 监听器治理（R0915-P2，2026-09-15
 * 四轮重评处置批）原样抽取——本域测试 39 处 `vi.resetModules() + await import` 每次
 * 都在真实 process 上注册 6 个监听器（main.ts 的 SIGINT/SIGBREAK/SIGTERM/
 * uncaughtException/unhandledRejection + app-instance-guard.ts 的 exit），闭包把整张
 * 旧模块图钉死不可 GC；负载下全量并发时堆耗尽（四轮报告 §三：4/4 worker OOM、空载
 * 可过 = 累积底噪失稳而非慢漏）。处置 = 包装 process.on/once 透传注册并记账（注册
 * 行为逐字节不变，不吞不换），afterEach 拆除本用例窗口内的注册——监听器寿命收敛到
 * 单用例、旧模块图随用例脱钉；禁 removeAllListeners（会误伤 vitest/工夹具自有监听器）。
 *
 * 使用契约（凡动态重导入 src/desktop/main.js 的 main-*.test.ts 拆分件必须齐全，与
 * 原单体文件同时机/同顺序）：
 *   1. 模块顶层（先于一切用例与 vi.spyOn(process,'on') 竞态用例）调
 *      installMainProcessListenerHarness()——等价原文件模块级包装；
 *   2. afterEach 调 removeTrackedProcessListeners()（拆除本用例窗口内注册）；
 *   3. afterAll 调 restoreMainProcessListenerHarness()（兜底拆除 + 还原包装方法，
 *      零残留出文件）。
 * 与 vi.spyOn(process,'on') 竞态用例共存语义不变：spy 期间注册走 spy 不进记账（也未
 * 真注册），mockRestore 还原本包装（spy 捕获的当前值即本包装）。
 */
const prevProcessOn = process.on.bind(process)
const prevProcessOnce = process.once.bind(process)
const trackedProcessListeners: Array<{ name: string | symbol; fn: (...args: unknown[]) => void }> = []

/** 模块顶层调用：包装 process.on/once 透传注册并记账（R0915-P2 原语义） */
export function installMainProcessListenerHarness(): void {
  process.on = ((name: string | symbol, fn: (...args: unknown[]) => void) => {
    trackedProcessListeners.push({ name, fn })
    return prevProcessOn(name as never, fn as never)
  }) as typeof process.on
  process.once = ((name: string | symbol, fn: (...args: unknown[]) => void) => {
    trackedProcessListeners.push({ name, fn })
    return prevProcessOnce(name as never, fn as never)
  }) as typeof process.once
}

/** afterEach 调用：拆除本用例窗口内经包装注册的监听器 + 记账清空（幂等无害） */
export function removeTrackedProcessListeners(): void {
  for (const { name, fn } of trackedProcessListeners) process.removeListener(name, fn)
  trackedProcessListeners.length = 0
}

/** afterAll 兜底：末用例异步尾迟到注册拆除 + 还原包装方法（零残留出文件） */
export function restoreMainProcessListenerHarness(): void {
  removeTrackedProcessListeners()
  process.on = prevProcessOn as unknown as typeof process.on
  process.once = prevProcessOnce as unknown as typeof process.once
}
