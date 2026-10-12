/**
 * 全自动写章（自愈闭环）一族——stream.ts 的 books.auto-write 三件（gate/parse/handler）
 * 下沉档。
 *
 * 为什么在独立档：handler 体是完整的自愈编排接线（二次忙闸复查 → watchdog 两段式兜底 →
 * runSelfHeal 起跑 + ctrl 登记/注销 + 在途工作登记 + 200 先回），与 stream.ts 的路由声明面
 * 分离后路由函数只剩 method/path/gate/parse 声明与一行转调。
 *
 * 行为不变量（纯下沉，逐字等价）：
 * - 执行序：找书 404（gate）→ 工目录 400（gate）→ 忙闸首查 409（gate）→ chapter/batchSize
 *   校验 400（parse）→ handler 内二次忙闸复查 409（readJson/ensureSession 的 await 窗口内
 *   新起的编排与分钟级任务闸在此拦截）→ 起跑 → 200。首查先于 chapter 校验的对外序不变
 *   （跨进程闸在持 + 空 body → 409 而非 400）。
 * - 起跑：ctrl 经 registerCtrl 登记（生成期 isRunning 真值、/interrupt 可直达 abort）、
 *   终态唯一注销点在本档 finally；编排经 trackInFlightWork 登记（close 收尾等待在途）；
 *   driver 原样直通（不包装 —— 包装曾把 registerCtrl 丢成 undefined）。
 * - 回包：batchSize > 1 才带 batchSize/chapters，形状与拆分前逐字一致。
 *
 * 依赖方向单向（无环）：本文件 → http / book-context / ai（自愈编排族 + 后台在途登记端口）
 * / 同目录 stream-watchdog（挂死兜底）与 stream-run-writer（共用错误兜底 emitSpawnError）；
 * stream.ts 单向 import 本文件（本文件对 stream.ts 只有 type 面回引 StreamCtx）。
 */
import type { ServerResponse } from 'node:http'
import { reply, replyError } from '../http.js'
import { resolveBookOrReply } from '../book-context.js'
import {
  abortSelfHeal,
  isSelfHealRunning,
  runSelfHeal,
  forceReleaseSelfHealRunning,
} from '../../../ai/orchestrate/self-heal.js'
import { startStallWatchdog } from './stream-watchdog.js'
import { trackInFlightWork } from './in-flight-work.js'
import { emitSpawnError } from './stream-run-writer.js'
import type { StreamCtx } from './stream.js'

/** auto-write 前置闸产出：bookRoot 供编排用（无 launched——本端点不占内存闸，
 *  互斥全由 busyReason 首查/复检承担）。 */
export interface AutoWriteGateState {
  bookRoot: string
}

/** /auto-write 前置闸——找书 404 → 工目录 400 → 忙闸首查 409（顺序即对外契约）。 */
export function autoWriteGate(
  ctx: StreamCtx,
  params: Record<string, string>,
  res: ServerResponse,
): false | { value: AutoWriteGateState } {
  const r = resolveBookOrReply(ctx.workDir, params['name'], res)
  if (!r) return false
  const bookName = params['name']!
  if (!ctx.userDataPath) {
    replyError(res, 400, 'NO_USERDATA', '未定位到用户数据目录')
    return false
  }
  // 忙闸首查：单调 busyReason('auto-write') 覆盖四面（前为四段手写 check，且
  // 同一句文案一处半角逗号一处全角——现单源全角）：
  // ① self-heal 自查——本闸是编排级内存锁，覆盖 self-heal 完整生命周期：机检/账本草稿
  //   等阶段无在途 LLM 请求，driver.isRunning 仍为 false，只有本闸拦得住重复触发（两个
  //   编排器会互相覆写草稿）。生成期与 driver.isRunning 重叠冗余，保留无害：登记受
  //   /interrupt 注销影响存在时序窗口，内存闸始终是可靠口径；
  // ② chat 在途（嵌套生成工具按章记账）会互覆预算章块并掐断在途对话；
  // ③ spawn 在途 = 双写手并发流式产出互覆草稿（saveDraft 与前端保存竞争）；
  // ④ 生成任务闸反向互斥——outline/lead-updates/onboard-ai/analyze 持闸（分钟级）期间
  // 启动 self-heal，其收尾覆盖写细纲.md/账本推进.md，后续章拿到混合态上下文（双费 +
  //   两端闭合误报红触发多余重写）；含跨进程锁文件面（双进程形态下他进程任务可见）。
  const busy = ctx.gate.busyReason(bookName, 'auto-write')
  if (busy) {
    replyError(res, 409, 'BUSY', busy)
    return false
  }
  return { value: { bookRoot: r.bookRoot } }
}

/** /auto-write body 形状（chapter 正整数 + batchSize 1-20 与连写章号序列）。 */
export function parseAutoWriteInput(raw: unknown): { chapter: number; batchSize: number; chapters?: number[] } {
  const body = (raw ?? {}) as Record<string, unknown>
  const chapter = Number(body['chapter'])
  if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 需为正整数')
  // 批量连写——batchSize 1-20，有值则生成连续章号序列（中途红项触顶停当前章，不续后续）
  const rawBatch = body['batchSize']
  const batchSize = rawBatch === undefined ? 1 : Number(rawBatch)
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
    throw new Error('batchSize 需为 1-20 的整数')
  }
  const chapters = batchSize > 1 ? Array.from({ length: batchSize }, (_, i) => chapter + i) : undefined
  return { chapter, batchSize, chapters }
}

/** /auto-write handler——二次忙闸复查 → 起跑自愈编排（watchdog + ctrl 登记 + 在途登记）
 *  → 200 先回。 */
export async function handleBookAutoWrite(
  ctx: StreamCtx,
  routeCtx: {
    params: Record<string, string>
    input: { chapter: number; batchSize: number; chapters?: number[] }
    gate: AutoWriteGateState
  },
  res: ServerResponse,
): Promise<void> {
  const { params, input, gate } = routeCtx
  const bookName = params['name']!
  const mainSession = await ctx.driver.ensureSession(bookName, ctx.workDir!)
  // 二次检查（await 期间可能另一个请求已启动）——TOCTOU 收窄；chat/spawn 闸同款补查
  // 复检 = 同一单源再调一次（readJson + ensureSession 两个 await 的窗口
  // 内新起的编排/新 acquire 的分钟级任务闸在此拦截：self-heal 收尾覆盖写 细纲.md/账本
  // 推进.md 时与任务产出互踩）。首查与复检同表同序，不再各写一份手写闸。
  {
    const busyRecheck = ctx.gate.busyReason(bookName, 'auto-write')
    if (busyRecheck) {
      return replyError(res, 409, 'BUSY', busyRecheck)
    }
  }
  const driver = ctx.driver.driver
  // self-heal 的 ctrl 登记 driver（与 /spawn 的 runWriterSpawn 同款接线）——
  // 生成期 isRunning 真值（否则 SSE sync 快照假空闲，前端可误触 /spawn 互相覆写草稿），
  // /interrupt 的 driver.interrupt 也能直接 abort 在途请求（与 abortSelfHeal 双保险）。
  // 终态注销（finally）——防 done 后快照仍报「生成中」。
  let registered: AbortController | null = null
  // 静默挂死 watchdog（进度复位式 + 两段式处置，设计详见 startStallWatchdog）。
  const wd = startStallWatchdog({
    bookName,
    label: '全自动写章',
    gateHeld: () => isSelfHealRunning(bookName),
    // 一段：既有用户中止路径——/interrupt 的动作集同款（abortSelfHeal + driver.interrupt 双保险）
    abortLikeUser: () => {
      abortSelfHeal(bookName)
      const s = ctx.driver.getSession(bookName)
      if (s) driver.interrupt(s)
    },
    // 二段：强释放。运行登记正本在 ai 层 running Map——经生产命名导出
    // forceReleaseSelfHealRunning(name)（= running.delete，幂等）完成
    // 登记清理；迟到编排若日后 settle：其 finally 的 running.delete 同键幂等，
    // 迟到结果按既有迟到覆盖口径处理。
    // 不在此注销 ctrl——注销唯一落点留在底层 run settle（下方 finally）。
    // 在此注销则一段 abort 未触达底层 runTask 时（请求无视中止信号 / ctrl 尚未
    // 重新登记），ctrl 一经注销 isRunning 即假空闲，后续 /interrupt 对该在途请求永久
    // 失联；保留注册至 settle，/interrupt 仍可经 driver.isRunning 命中并 abort，同
    // owner 的新登记亦会 abort 旧 ctrl 防僵尸。
    forceRelease: () => {
      forceReleaseSelfHealRunning(bookName)
      driver.emit(mainSession, {
        type: 'warning',
        message:
          '全自动写章长时间无进展，疑似挂起，已被服务端强制收尾并释放并发闸（底层任务未中断，迟到结果按既有迟到覆盖口径处理）',
      })
    },
  })
  // 进度复位式计时——编排器一切事件经 onActivity 回调（self-heal generate 的 emit
  // 单点）复位 watchdog，下方 register 回调在 ctrl 登记点另行复位。driver 原样直通：
  // 端点不再包装它，中断能力（interrupt/isRunning/registerCtrl…）无转发面可漏——
  // 包装式曾把 registerCtrl 丢成 undefined，pass 后的后台账本草稿
  // （runRegisteredBgTask）登记落空、/interrupt 找不到 ctrl。
  // 本端点 200 先回、编排后台跑（fire-and-forget）——登记进 server 在途工作表：
  // close 收尾的裸 close 只等连接清空，编排仍持会话库（userData/session/*.db）与
  // 机检库句柄在写，调用方（e2e/集成测试）close 后立刻 rmSync 临时目录会在 Windows
  // 落 EPERM（同的 Worker 句柄族；rag 的 buildIndex 同款登记先例）。
  void trackInFlightWork(
    runSelfHeal({
      driver,
      mainSession,
      userDataPath: ctx.userDataPath!,
      cwd: ctx.workDir!,
      bookRoot: gate.bookRoot,
      bookName,
      chapter: input.chapter,
      ...(input.chapters ? { chapters: input.chapters } : {}),
      onActivity: () => wd.touch(),
      register: (c) => {
        registered = c
        wd.touch() // ctrl 登记点亦复位
        driver.registerCtrl(mainSession, c, 'self-heal')
      },
    })
      .catch((e) => emitSpawnError(driver, mainSession, e))
      .finally(() => {
        wd.cancel() // 终态撤 watchdog（正常完成/中止/失败统一，clearTimeout 无泄漏）
        // 底层 run settle 的注销点（唯一）——二段强释放不提前注销，
        // 强释放到 settle 之间 ctrl 留册，/interrupt 对在途请求不失联
        if (registered) driver.unregisterCtrl(mainSession, registered)
      }),
  )

  reply(res, 200, {
    ok: true,
    chapter: input.chapter,
    ...(input.batchSize > 1 ? { batchSize: input.batchSize, chapters: input.chapters } : {}),
  })
}
