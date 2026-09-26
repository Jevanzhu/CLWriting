/**
 * SSE 连接记账族 + SSE 写出器族 —— 自 src/studio/server/api/stream.ts 缝 A 拆出。
 *
 * （⑤④产品巨件拆分波4）：stream.ts（879 行）缝 A+B 纯移动拆分。
 * 本文件承载缝 A：per-book SSE 连接记账族（SseConnHandle 句柄化 Set 账目、
 * MAX_SSE_PER_BOOK 上限、forgetSseCount / closeAllSseConnections 终态清账、
 * __getSseConnections 测试观测钩子）+ SSE 写出器族（createSseWriter
 * 安全写 + 背压双判死：滞留字节按 UTF-8 实际字节数累计 + 连续滞留次数闸）。
 * 实读取界记档（对普查口径的扩张）：普查口径为「sse-writer 写出器族」（原 97-151 行），
 * 实读确认其与前邻的连接记账族（原 55-95 行）物理连续、同属 SSE 连接级基础设施、
 * 均零 import 依赖（Buffer 为 Node 全局），合为同一缝随迁（原 55-151 行整段）——
 * 残核 GET books.stream handler 对 sseConnections / MAX_SSE_PER_BOOK / SseConnHandle
 * 的既有引用改经 import 解析，handler 本体逐字节不动。
 * 原私有而 stream.ts 残核跨模块消费项（sseConnections / MAX_SSE_PER_BOOK /
 * SseConnHandle）就此导出，其余保持私有；SSE_BACKPRESSURE_LIMIT 维持原导出
 * （全库引用面仅注释提及，无 import 消费）。
 * 依赖方向单向（无环回引）：本文件零 import，不引用 stream.ts / stream-watchdog.ts
 * 及任何 ai / studio 模块；stream.ts 残核自此 import，并对既有外部消费名
 * （forgetSseCount / closeAllSseConnections / __getSseConnections / createSseWriter）
 * 逐名再导出（桥，消费方 import 面零改动）。顶层求值可变状态（sseConnections Map）
 * 单源本文件，绝不经环回 re-export 链被引（TDZ 纪律）。
 * 热路径注记：本文件处在 SSE 长连接热路径——背压阈值（1MB / 240 次）、drain 复位
 * 时机、判死 destroy 动作逐字节保持，零行为变化。
 * 注释全部原样随迁；行为、断言、测试零改动。
 */

// per-book SSE 连接记账（防多标签页耗尽 FD）。
// 计数改按实际存活连接记账（Map<book, Set<句柄>>）——原裸数字计数
// 在 chat.clear 直接 delete 后，旧连接 close 回调仍会对新账目 -1（漂移为 0 下限），
// MAX_SSE 限制可被绕空。句柄登记于鉴权通过时、req close 时移除；forgetSseCount
// 销毁该书全部在途连接并同步清账（close 回调移除幂等）。
export interface SseConnHandle {
  /** 强制断开该连接（destroy → 触发 req close → 常规清理链） */
  destroy(): void
}
export const sseConnections = new Map<string, Set<SseConnHandle>>()
export const MAX_SSE_PER_BOOK = 5

/** 书级生命周期终态清 per-book SSE 计数——删书（books.delete）与
 *  清空对话（chat.clear）此前不清理，残留计数让同名重建书被旧计数顶到 429 上限
 *  （计数只在 req close 时递减，书删后连接早已散场无从归零）。命名对齐 books.ts
 *  的 forgetSession/forgetService 族。
 * 改销毁该书全部在途连接 + 同步清账——原裸 delete 不断连接，旧连接
 *  close 时对新账目 -1 造成漂移。 */
export function forgetSseCount(bookName: string): void {
  const conns = sseConnections.get(bookName)
  if (!conns) return
  sseConnections.delete(bookName) // 先清账：close 回调的移除幂等（get 不到即跳过）
  for (const h of conns) h.destroy()
}

/** 退出收尾——销毁并清账**全部**在途 SSE 连接（不限书）。
 *  此前 server.close 只停接新请求，SSE 长连接仍挂在 server 上（响应未 end，非
 *  closeIdleConnections 可摘的空闲连接），close 回调被拖满调用方超时才放行；且
 *  集成测试/调用方 close 后立刻 rmSync 时残留 socket 句柄。destroy → req close →
 *  既有常规清理链（心跳/生成器/计数移除均幂等），并同步清账，防同名重建书读陈计数。
 *  接线点：server/index.ts 的 close 路径（本模块生命周期终态）。 */
export function closeAllSseConnections(): void {
  for (const bookName of [...sseConnections.keys()]) forgetSseCount(bookName)
}

/** 测试观测钩子（对齐 __setSpawnRunning 风格）——按句柄集合重算只读快照断言计数。 */
export function __getSseConnections(): ReadonlyMap<string, number> {
  const snapshot = new Map<string, number>()
  for (const [name, conns] of sseConnections) snapshot.set(name, conns.size)
  return snapshot
}

/** SSE 写背压判死阈值——res.write() 返回 false 起（假死客户端 TCP
 *  接收窗口关死），滞留 Node writable 队列的字节累计超此值即 destroy 断连（1MB ≈
 *  数十条章节级事件；受 MAX_SSE_PER_BOOK 与事件量约束，正常客户端远达不到）。 */
export const SSE_BACKPRESSURE_LIMIT = 1_000_000

/** 连续滞留写判死阈值——write() 连续返回 false 的次数（drain/成功
 * 写复位）。字节闸对「仅心跳存活」的假死连接几乎失效（心跳 ~14B/30s，1MB 需约 25
 * 天累计）；次数闸补位：240 次 × 30s = 2 小时无一次 drain 即判死。数据突发场景由
 * 字节闸先行（1MB 远早于 240 次到达），本闸只兜心跳型假死。 */
const SSE_STUCK_WRITES_LIMIT = 240

/** 背压守卫所需的 res 最小面（结构化收窄——不用 Pick<ServerResponse,...>，
 *  真实 ServerResponse.on 返回 this，假 res/单测桩返回 void 无法满足该签名）。 */
interface SseWritable {
  writableEnded: boolean
  destroyed: boolean
  write(chunk: string): boolean
  on(event: 'drain', listener: () => void): unknown
  destroy(): void
}

/**
 * SSE 安全写 + 背压判死。
 * - 已断开（writableEnded / destroyed）静默丢弃（既有守卫语义不变）；
 * - write 返回 false 自此累计滞留字节、drain 事件复位、成功写复位；
 * - 累计超 limit 判死 res.destroy——假死连接不再让服务端内存无界缓冲（走既有
 *   close 清理链：channel 计数 / 心跳清理 / iter.return）。导出供单测注入假 res。
 */
export function createSseWriter(
  res: SseWritable,
  limit: number = SSE_BACKPRESSURE_LIMIT,
  stuckLimit: number = SSE_STUCK_WRITES_LIMIT,
): (chunk: string) => void {
  let pendingBytes = 0
  let stuckWrites = 0
  res.on('drain', () => {
    pendingBytes = 0
    stuckWrites = 0
  })
  return (chunk: string): void => {
    if (res.writableEnded || res.destroyed) return
    if (res.write(chunk) === false) {
      // 滞留字节按 UTF-8 实际字节数计——原 chunk.length 是
      // UTF-16 码元数，中文事件实际滞留约为计数 3 倍（1MB 阈值实际放行 ~3MB，
      // 背压判死闸对中文流形同放宽 3 倍）
      pendingBytes += Buffer.byteLength(chunk, 'utf8')
      stuckWrites += 1
      // 字节闸 + 连续次数双判死——次数闸兜「仅心跳存活」的假死连接
      if (pendingBytes > limit || stuckWrites > stuckLimit) res.destroy()
    } else {
      pendingBytes = 0
      stuckWrites = 0
    }
  }
}
