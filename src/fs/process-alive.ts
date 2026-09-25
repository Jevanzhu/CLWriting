/**
 * 进程存活探测单源（R0916-7-P3-3：自 fs/cross-process-lock.ts 拆出）。
 *
 * 起因：存活探测是**通用底座纯函数**（跨进程锁的 stale 判定、events 句柄标记、
 * atomic 的崩溃残留清扫、task-gate 的跨进程占用查询共用同一口径），却与锁实现同处
 * 一模块——fs/atomic.ts 只为取它而 import cross-process-lock.ts，而后者又 import
 * atomic 的重试原语（rm/rename 退避），两文件互引成环（ESM 环初始化顺序敏感）。
 * 拆成零依赖叶子模块后 atomic / cross-process-lock 各自引它，环消除。
 *
 * 本模块零内部依赖（仅 node 内置），任意层可引——后续新增存活探测消费方直引此处，
 * 不再经锁模块转运。
 */

/** 进程存活探测：process.kill(pid, 0) 不发信号只做权限/存在性检查；ESRCH = 不存在
 *  （stale）。EPERM（存在但属他人）按存活处理——保守不接管。
 *  pid ≤ 0 / 非整数显式判死：POSIX 上 process.kill(≤0, 0) 是「可信号进程组」探测、
 *  对本进程恒成功，残留文件里的垃圾 pid 会被误判为活（libuv/Windows 则抛 ESRCH）；
 *  消费方读到的合法 pid 恒为正整数。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
