/** 事件循环让出原语（单源）：setImmediate 落到 libuv check 阶段，跨事件循环迭代
 *  （rAF 语义在服务端无意义；process.nextTick 微任务不让出事件循环，等于没让）。
 *  原五处同体拷贝（check/run、document/foreshadow、learn、metrics/style、
 *  studio/server/api/progress——后者 re-export 保持既有 import 面零改动）
 *  于精简批收敛于此；各域让出粒度常量（*_YIELD_EVERY）仍在各域原地。 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 生成器核的同步驱动（阶段 52 批 1）：驱到尾、忽略纯悬停——净效果与切片前的纯同步
 *  执行逐位一致（同步版调用方零感知）。仅适用「纯悬停核」（yield 无值）；带效应让出
 *  档的核（yield 值 = 待办请求）由调用方自定义驱动回填（先例 process/book-search.ts
 *  driveSearchCoreSync、check/run-tree-issues.ts 两驱动）。 */
export function driveToEnd<T>(it: Generator<unknown, T, unknown>): T {
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}

/** 生成器核的 async 驱动（阶段 52 批 2）：与 driveToEnd 同一核，唯一差异 = 每个纯悬停
 *  等一拍事件循环（await setImmediate）——慢盘上单章机检链的长段自此可分割让出，其间
 *  SSE 心跳/其它请求照跑。净计算结果与同步驱动逐位一致（单源核，只换驱动的让出语义）。
 *  仅适用「纯悬停核」（yield 无值）；带效应让出档的核须由调用方自定义驱动回填（同
 *  driveToEnd 注）。 */
export async function driveToEndAsync<T>(it: Generator<unknown, T, unknown>): Promise<T> {
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
    await yieldToEventLoop()
  }
}
