/**
 * 跨进程锁内的串行写原语（R0916-7-P3-3：自 ai/calls.ts 下沉 fs）——R-5 / J7 / R30-3 /
 * R61-7 / 复审-0914-优化修复批 C1 的沿革语义整体随迁，逐位不变。
 *
 * 起因：这两件（写链队列 + 跨进程真锁的写段执行）是**通用锁原语**，与「每章 AI 调用
 * 预算闸」的记账职责无关——原居记账模块 ai/calls.ts，被 ai/provider/store.ts 借用
 *（providers.json 保存同款写链），使记账模块被动承载 fs 层职责、设置域经记账模块取得
 * 锁原语（provider→记账 的跨层借用）。下沉 src/fs 后记账与设置在同一个中立原语上各取
 * 所需，ai/calls.ts 只留记账职责（预算判定/用量累计/落盘读写）。
 *
 * 本模块只依赖 fs 层（cross-process-lock）与 log——不引任何上层，任意层可引。
 */
import { errMsg, log } from '../log/index.js'
import { acquireCrossProcessLockAsync, tryAcquireCrossProcessLock } from './cross-process-lock.js'

/** 复审-0914-优化修复批（C1）：写链队列机制单源——ai/calls.ts serializedWrite 与
 *  provider/store.ts saveProviders 的同构「writeChains Map → 快路锁内直行 → 在途
 *  promise 入链 → cleanup 身份比对删 → 旁挂 warn 防 unhandled rejection」段收编于此
 *  （R-5 串行队列 / J7 跨进程真锁 / R30-3 锁等待异步化 / R73-2 providers 侧收口 /
 *  R61-7 旁挂留痕的沿革语义逐位不变，只收机械重复）。chains/键由调用方持有
 *  （两域各自独立链互不阻塞；store 侧测试钩子 __seedProvidersWriteChainForTest
 *  直写其 Map，收编后照旧生效）。 */
export interface SerializedLockedWriteOpts {
  /** 旁挂 warn 的 log tag */
  warnTag: string
  /** 快路在途段失败 warn 文案（已接 errMsg 的 message） */
  fastWarn: (msg: string) => string
  /** 排队段失败 warn 文案 */
  queuedWarn: (msg: string) => string
  /** 锁等待超时毫秒（getter：calls 侧经注入钩子读内部生效值，排队段执行时点取值口径不变）
   *  与超时错误文案（已带 lockPath 插值） */
  lockTimeoutMs: () => number
  lockTimeoutMsg: string
  /** 写段重入标志（calls 记账侧 inWriteSegment——doWrite 同步执行段两侧置/清；缺省无标志） */
  segmentFlag?: (on: boolean) => void
  /** 在途/排队 promise 是否随返回值交给调用方：providers 侧 true（R29-2：失败随 promise
   *  上抛，不吞）；calls 侧 false（历史口径恒 undefined，失败由旁挂 warn 承担） */
  returnInflight: boolean
}

export function serializedLockedWrite(
  chains: Map<string, Promise<unknown>>,
  key: string,
  lockPath: string,
  doWrite: () => void,
  opts: SerializedLockedWriteOpts,
): void | Promise<void> {
  const lockedWrite = (): void | Promise<void> =>
    crossProcessLockedWrite(lockPath, doWrite, {
      lockTimeoutMs: opts.lockTimeoutMs,
      lockTimeoutMsg: opts.lockTimeoutMsg,
      segmentFlag: opts.segmentFlag,
    })
  const prev = chains.get(key)
  if (prev === undefined) {
    // 空闲快路：无争用时同步原子完成（跨进程锁内执行——整段互斥，多进程同写不再交错
    // 覆盖；同步错误同步上抛，既有同步 try/catch 口径不变）。锁被占时
    // crossProcessLockedWrite 返回在途 promise（异步轮询等待）——此处临时入链让后续
    // 写者排队其后（保调用序 = 落盘序）。
    const r = lockedWrite()
    if (r === undefined) return
    chains.set(key, r)
    const cleanupInflight = (): void => {
      if (chains.get(key) === r) chains.delete(key)
    }
    // R61-7（第六十一轮）口径沿用：在途写段失败旁挂 warn 留痕（少记一次可从日志发现）；
    // 旁挂 rejection handler 同时向运行时标记「已处理」，防 unhandled rejection
    void r.then(cleanupInflight, (e: unknown) => {
      log.warn(opts.warnTag, opts.fastWarn(errMsg(e)))
      cleanupInflight()
    })
    return opts.returnInflight ? r : undefined
  }
  const next = prev.catch(() => {}).then(() => lockedWrite())
  chains.set(key, next)
  const cleanup = (): void => {
    if (chains.get(key) === next) chains.delete(key)
  }
  // R61-7（第六十一轮）：排队写段失败留痕对齐 runner recordUsageSafe 口径（旁挂分支只
  // 留痕 + 清链，是否吞拒绝由 returnInflight 定——providers 侧随返回 promise 上抛）
  void next.then(cleanup, (e: unknown) => {
    log.warn(opts.warnTag, opts.queuedWarn(errMsg(e)))
    cleanup()
  })
  return opts.returnInflight ? next : undefined
}

/** C1 单源底层：单次「跨进程锁内同步/异步执行写段」——无争用快路同步持锁直行
 *  （tryAcquire 即得，写段为文件 IO 级毫秒，同步原子完成后返回 undefined）；锁被占时
 *  改用 acquireCrossProcessLockAsync 异步轮询等待（setTimeout 微睡、事件循环不阻塞，
 *  R30-3：CLI+桌面双进程争用时承载 SSE/全部接口的服务进程不再被 Atomics.wait 同步微睡
 *  冻结至超时）。同步/异步获取对同一把锁互通互斥（fs/cross-process-lock.ts 同源
 *  tryAcquireCrossProcessLock）。返回 undefined = 已同步完成（含同步抛错）；Promise =
 *  在途写段（超时/写失败以 rejection 表达，由 serializedLockedWrite 旁挂留痕/上抛）。
 *  segmentFlag 在 doWrite 同步执行段两侧置/清——等待期（false）与执行段（true）对
 *  readRecord 的可观测口径与旧实现一致。
 *
 * 重审-05（2026-09-07 全量代码重审 §四P3/§六批2）记档（原 writeWithCrossProcessLock 注，
 * 随 C1 单源移位，两调用方同受）：快路 doWrite 为全同步写段（load→mutate→writeRecord，
 * atomicWriteFile 默认 fsync=true：文件内容 + 父目录两次 fsync）——慢盘/网络盘（SMB/NAS
 * 挂载）上单次毫秒~百毫秒级阻塞事件循环，承载 SSE 与全部接口的 studio 服务进程同步冻结，
 * 是**已知代价的既定取舍**，不按 bug 处理。权衡理由：①「记完即读」——recordTaskUsage/
 * recordAiCall 返回即账已落盘，checkAiCallBudget 的锁内快照读（self-heal 首稿/重写两道闸）
 * 与 review.ts effectiveRemainingCalls 等 A 域外读方无需任何等待协议就能读到刚记的账；
 * ②同步错误同步上抛——rag recordEmbedUsage / runner recordUsageSafe 的既有同步 try/catch
 * 降级口径零改动。未来异步化的前置条件（满足前不动）：a. 盘点「记完即读」消费者清单并
 * 逐一确认无「写返回后立即读必须见新值」依赖（或改等待句柄/版本号协议）；b. 全部写方
 * （recordTaskUsage / recordAiCall / readRecord 锁内迁移写）统一改返回 Promise 并上溯改造
 * runner/rag/self-heal 调用链的同步 catch 口径；c. R33-17 曾保留、R30-3 起已在役的
 * writeChains 排队代码即现成接管面。 */
function crossProcessLockedWrite(
  lockPath: string,
  doWrite: () => void,
  opts: { lockTimeoutMs: () => number; lockTimeoutMsg: string; segmentFlag?: (on: boolean) => void },
): void | Promise<void> {
  const fast = tryAcquireCrossProcessLock(lockPath)
  if (fast) {
    try {
      opts.segmentFlag?.(true)
      doWrite()
      return
    } finally {
      opts.segmentFlag?.(false)
      fast()
    }
  }
  // R43-5（四十三轮）：消费点改读内部生效值（导出常量只是默认档；getter 在等待发起
  // 时点取值，与原实现读 aiCallsLockTimeoutMs 的时点一致）
  return acquireCrossProcessLockAsync(lockPath, opts.lockTimeoutMs()).then((release) => {
    if (!release) {
      throw new Error(opts.lockTimeoutMsg)
    }
    try {
      opts.segmentFlag?.(true)
      doWrite()
    } finally {
      opts.segmentFlag?.(false)
      release()
    }
  })
}
