/**
 * R9-P2-2（2026-09-09 修复批）：公共轮询等待助手（单源）。
 *
 * 背景：test/ 下 waitFor 重复实现 ≥4 份（评审 R9-P2-2 记录在案）——chat 域 9 文件
 * 近乎逐字克隆（20ms 轮询 + 3000ms 缺省超时），独立 server 域另有 waitForStatus 族
 * 异步取值变体。统一后：布尔谓词用 waitFor；异步取值用 waitForAsync。轮询循环与
 * 超时抛错唯此一处；文件级特殊参数（更紧/更宽的超时窗）经一行适配壳传入，不再
 * 复制实现体。pm12 waitFor（文件存在性轮询，超时返回布尔供分支）、r27 waitForLock
 *（计数形态）、r57 waitForCond 为专名专用形态，维持本地定义（见各文件注释）。
 *
 * 语义约定：超时**抛错**（测试红）而非返回——负窗口依赖靠轮询消除：断言从
 * 「固定毫秒实睡后查一次」改为「轮询到状态翻转」，慢机/共享 runner 不 flake。
 */
export async function waitFor(
  fn: () => boolean,
  timeoutMs = 3000,
  intervalMs = 20,
  label = 'waitFor',
): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timeout after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 异步取值轮询：fn 返回非 undefined 即收口返回该值；超时抛错（waitForStatus 族形态单源）。 */
export async function waitForAsync<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 4000,
  intervalMs = 50,
  label = 'waitForAsync',
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`${label} 超时`)
}