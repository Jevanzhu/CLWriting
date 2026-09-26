/**
 * 静默挂死 watchdog 族 —— 自 src/studio/server/api/stream.ts 缝 B 拆出。
 *
 * （⑤④产品巨件拆分波4）：stream.ts（879 行）缝 A+B 纯移动拆分。
 * 本文件承载缝 B（原 294-383 行整段）：编排长任务静默挂死兜底——
 * ORCH_STALL_WATCHDOG_MS（20min 静默判定）/ ORCH_STALL_GRACE_MS（60s 中止宽限）
 * 两阈值常量 + StallWatchdog 句柄 + startStallWatchdog 两段式处置（一段走既有
 * 用户中止路径，二段宽限期满强释放并发闸；进度复位式计时，范式参照 rag.ts）。
 * 消费方 = stream.ts 残核的 runWriterSpawn（/spawn）与 books.auto-write handler
 * （/auto-write self-heal），均留残核。
 * 原私有而残核消费的 startStallWatchdog 就此导出；两阈值常量维持原导出（p37 测试
 * 直引，残核逐名再导出作桥）。
 * 依赖方向单向（无环回引）：仅 import log（warn 留痕），不引用 stream.ts /
 * stream-sse-writer.ts 及任何 ai / studio 模块；stream.ts 残核自此 import。
 * 顶层求值常量仅数字字面量，单源本文件，无 TDZ 面。
 * 热路径注记：watchdog 静默计时 / 复位 / 两段处置时序逐字节保持，零行为变化。
 * 注释全部原样随迁；行为、断言、测试零改动。
 */
import { log } from '../../../log/index.js'

// -（全量代码）：/auto-write（self-heal）与 /spawn 长任务闸的静默
// 挂死兜底 watchdog——编排器内部 await 永不 settle 时 isSelfHealRunning / isSpawnRunning
// 永真 → 本书全部写端点 + 删书/改名（busyGate 同口径）永久 409，仅重启可解。范式参照
// rag.ts watchdog，但不照抄其固定 10min 总时长：self-heal 批量连写合法运行可持续
// 远超任何固定上限，改「进度复位式计时」——每个编排事件经广播/登记点复位计时，只有
// 「无任何事件推进的静默时长」超限才判挂起。
// 阈值推导：编排链静默上界 = 一次 runSpec 全链封套（runner.ts:103 DEFAULT_TIMEOUT_MS
// = 600_000，tier.timeoutMs 可覆盖；重试 3 次 + 1s→30s 退避全部在该封套内，不叠加），
// 流式另有 60s 首字节/流间隙超时（gen.ts）兜短，两次 runSpec 之间的本地工序（机检/
// 落盘）秒级——即默认最大合法静默 ≈ 10min。取 2 × 600s = 20min（≥ 最大静默上界 2 倍）。
// 作者把档位 timeoutMs 配到 >20min 且全程静默属配置面越界，误中止后果 = 等同作者主动
// 中断的正常收尾，不破坏互斥语义。
export const ORCH_STALL_WATCHDOG_MS = 20 * 60_000
/** 中止后宽限期——abort 是异步信号，正常编排会在此内 settle 收尾放闸（无副
 *  作用）；期满闸仍被占（中止也无法使其 settle，真挂死）才走二段强释放。60s ≫ 信号观察
 *  回路的微任务/IO 级收尾时延，足够宽。 */
export const ORCH_STALL_GRACE_MS = 60_000

/** watchdog 句柄——touch=进度推进复位（广播/登记点调用）；cancel=终态撤表
 *  （双 timer clear，无泄漏；幂等，迟到 settle 的二次 cancel 无害）。 */
interface StallWatchdog {
  touch(): void
  cancel(): void
}

/**
 * 静默挂死 watchdog（两段式，保互斥优先）。
 * 一段——静默超 ORCH_STALL_WATCHDOG_MS：走既有用户中止路径（等同作者点 /interrupt），
 *   log.warn 留痕「疑似挂起已自动中止」；宽限期内闸正常释放则收尾，无副作用。
 * 二段——宽限期满（ORCH_STALL_GRACE_MS）闸仍被占：rag 式强释放（放闸 + warn 留痕；
 *   底层任务未中断，迟到结果按既有迟到覆盖口径处理）。
 * 多次连续任务不叠加：每轮编排独立实例，终态 finally 统一 cancel；fire 时 gateHeld
 * 复核兜「已收尾但 finally 未跑」的竞态窗口。
 */
export function startStallWatchdog(o: {
  bookName: string
  /** 日志文案用编排名（「全自动写章」/「手动写稿」） */
  label: string
  /** 闸仍占判定（两段共用口径：isSelfHealRunning / isSpawnRunning） */
  gateHeld: () => boolean
  /** 一段：既有用户中止路径（调用方对齐 /interrupt 的动作集） */
  abortLikeUser: () => void
  /** 二段：强释放（放闸 + 注销 ctrl + 前端告知） */
  forceRelease: () => void
}): StallWatchdog {
  let stall: ReturnType<typeof setTimeout> | undefined
  let grace: ReturnType<typeof setTimeout> | undefined
  let aborted = false
  let done = false
  const clearStall = (): void => {
    if (stall !== undefined) {
      clearTimeout(stall)
      stall = undefined
    }
  }
  const arm = (): void => {
    clearStall()
    stall = setTimeout(() => {
      stall = undefined
      if (done || aborted || !o.gateHeld()) return // 已收尾/已中止（竞态兜底）
      aborted = true
      // -随批修正：宽限时长展示单位错配——ORCH_STALL_GRACE_MS(60s) 除以 60_000 却标
      // 「s」，日志误显「若 1s 内仍不收尾」（实际宽限 60s）；改按秒换算
      log.warn(
        'api',
        `「${o.bookName}」${o.label}超过 ${ORCH_STALL_WATCHDOG_MS / 60_000} 分钟无任何进度事件，疑似编排器挂起，已自动中止（等同作者中断）；若 ${ORCH_STALL_GRACE_MS / 1000}s 内仍不收尾将强制释放并发闸`,
      )
      o.abortLikeUser()
      grace = setTimeout(() => {
        grace = undefined
        if (done || !o.gateHeld()) return // 宽限内已收尾放闸 → 无副作用
        log.warn(
          'api',
          `「${o.bookName}」${o.label}自动中止后仍占用并发闸（疑似挂死），已强制释放——底层任务未中断，迟到结果按既有迟到覆盖口径处理`,
        )
        o.forceRelease()
      }, ORCH_STALL_GRACE_MS)
      grace.unref?.()
    }, ORCH_STALL_WATCHDOG_MS)
    stall.unref?.()
  }
  arm()
  return {
    touch: (): void => {
      if (!aborted && !done) arm() // 中止后事件不再复位（等正常收尾或宽限满强释放）
    },
    cancel: (): void => {
      done = true
      clearStall()
      if (grace !== undefined) {
        clearTimeout(grace)
        grace = undefined
      }
    },
  }
}
