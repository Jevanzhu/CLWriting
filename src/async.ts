/** 事件循环让出原语（单源）：setImmediate 落到 libuv check 阶段，跨事件循环迭代
 *  （rAF 语义在服务端无意义；process.nextTick 微任务不让出事件循环，等于没让）。
 *  原五处同体拷贝（check/run、document/foreshadow、learn、metrics/style、
 *  studio/server/api/progress——后者 re-export 保持既有 import 面零改动）
 *  于 2026-09-11 精简批收敛于此；各域让出粒度常量（*_YIELD_EVERY）仍在各域原地。 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
