/**
 * SSE 端点：GUI 订阅事件流 + 触发生成。
 *
 * GET  /api/books/:name/stream     → SSE（订阅 driver.stream，持续推送 DriverEvent）
 * POST /api/books/:name/spawn      → 触发写稿（generateText + writerSystem，fire-and-forget + SSE 回流）
 * POST /api/books/:name/interrupt  → 中断生成 + 停自愈编排
 * POST /api/books/:name/auto-write → 全自动写章（写稿→机检→红则重写闭环，body {chapter}）
 *
 * SSE / interrupt / auto-write 经 driver session；/spawn 走 gen.ts generateText + provider 直连。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError, parseRequestUrl, urlPathOnly } from '../http.js'
import { log, errMsg } from '../../../log/index.js'
import { resolveBookOrReply } from '../book-context.js'
import { ensureSession, getDriver, getSession } from '../../../driver/index.js'
import type { DriverEvent, Session, StudioDriver } from '../../../driver/index.js'
// watchdog 二段强释放用生产命名导出 forceReleaseSelfHealRunning（= running.delete，幂等）——
// 不走测试命名导出 __setSelfHealRunningForTest：测试专用 API 不得进生产路径；
// __setSelfHealRunningForTest 仅供回归测试。
import { abortSelfHeal, isSelfHealRunning, runSelfHeal, forceReleaseSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { isChatRunning, abortChat } from '../../../ai/orchestrate/chat.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { streamSpec } from '../../../ai/tasks/specs.js'
import { readKind } from '../book-context.js'
import { redactSecret } from '../../../ai/provider/redact.js' // API 错误脱敏
import { resolveModelPricing, computeCallCost } from '../../../ai/pricing.js'
import { safeTokenCompare } from '../http.js'
import type { StreamTicketStore } from './stream-ticket.js'
// 忙闸判定单源——R0916-7-P3-12：本文件不再自写互斥矩阵，spawn/auto-write 两入口只调
// busyReason（含跨进程锁文件面的任务闸查询在 task-gate.ts 内合并：双进程形态下他进程
// 分钟级任务在途时纯进程内查询看不见，会照常放行写端点致产出互踩）。
// allHeldTaskGatesFor 同批迁回 task-gate.ts（原就近放 audit.ts），audit ↔ stream 的
// 互相 import 环随之解开。
import { busyReason } from './task-gate.js'
// chat 工具侧闸端口的注册端（见 registerStreamRoutes 头部注）与真实闸本体
import { registerTaskGateProvider } from '../../../ai/orchestrate/task-gate-port.js'
import { acquireTaskGate } from './task-gate.js'
// spawn 闸正本在 ai 层（turns.ts 的嵌套生成工具闸要查它，ai 层不得反向 import server
// 路由层）；此处再导出保持 books/audit/测试的导入面不变
import { isSpawnRunning, holdSpawnGate, releaseSpawnGate, __setSpawnRunning } from '../../../ai/orchestrate/spawn-registry.js'
// SSE 连接记账/写出器族在 stream-sse-writer.ts、静默挂死 watchdog 族在 stream-watchdog.ts
// ——此处 import 消费面：GET books.stream handler 的连接记账（sseConnections /
// MAX_SSE_PER_BOOK / SseConnHandle）与安全写（createSseWriter），
// runWriterSpawn / auto-write 的挂死兜底（startStallWatchdog）
import { sseConnections, MAX_SSE_PER_BOOK, createSseWriter } from './stream-sse-writer.js'
import type { SseConnHandle } from './stream-sse-writer.js'
import { startStallWatchdog } from './stream-watchdog.js'
import { trackInFlightWork } from './in-flight-work.js'

export { isSpawnRunning, __setSpawnRunning }

// 桥：拆出族的既有外部消费名逐名再导出——books.ts / chat.ts 的 forgetSseCount，
// index.ts 的 closeAllSseConnections，sse-count-cleanup / r0910-w 测试的
// __getSseConnections，sse-backpressure 测试的 createSseWriter，
// p37 测试的 ORCH_STALL_WATCHDOG_MS / ORCH_STALL_GRACE_MS——消费方 import 面零改动
export { forgetSseCount, closeAllSseConnections, __getSseConnections, createSseWriter } from './stream-sse-writer.js'
export { ORCH_STALL_WATCHDOG_MS, ORCH_STALL_GRACE_MS } from './stream-watchdog.js'

interface StreamCtx {
  workDir: string | null
  userDataPath: string | null
  /** GET SSE 端点 token 校验用（EventSource 不走 isWrite 拦截） */
  studioToken: string
  /** 本 server 实例的 ticket 库（与 /api/stream-ticket 签发侧同实例共享） */
  tickets: StreamTicketStore
}

// per-book spawn 运行闸（与 /auto-write 的 self-heal 闸同模式）——
// 双标签页时序窗口并发双 spawn 会互相覆写草稿回流。占位在首个 await 前同步完成
// （比 auto-write 的「检查→await→二次检查」更严，无 TOCTOU 窗口），终态 finally 释放。
// （闸本体在 ai/orchestrate/spawn-registry.ts）

/**
 * fire-and-forget 写稿：产物经 runTask 统一编排（mock/provider/中断/错误文案），
 * text 增量经 driver.emit 推 SSE。
 * ctrl 经 registerCtrl 交给 driver——interrupt() 可 abort 真实请求，isRunning() 判在途。
 * 导出供单测直调 watchdog 行为（同 createSseWriter「导出供单测注入假 res」先例）。
 */
export async function runWriterSpawn(opts: {
  driver: StudioDriver
  mainSession: Session
  /** watchdog 判定/文案用书名（闸正本 isSpawnRunning 在 ai 层 spawn-registry） */
  bookName: string
  userDataPath: string | null
  bookRoot: string
  prompt: string
  role: string
  /** GET /draft-prompt 回传的注入源清单 → promptMeta.files 登记 */
  promptFiles: string[]
}): Promise<void> {
  // spawn 同款静默挂死兜底——闸正本在 ai 层 spawn-registry，其 hold/release
  // 是生产导出，强释放直接走 releaseSpawnGate（与 self-heal 借 __set 测试导出不同）。
  // 进度复位点 = 本地 emit 闭包（text 增量/usage/done/warning/error 全经此回流）。
  const wd = startStallWatchdog({
    bookName: opts.bookName,
    label: '手动写稿',
    gateHeld: () => isSpawnRunning(opts.bookName),
    // 一段：用户中止路径——必须对齐 /interrupt 的动作集（self-heal 分支同款 driver.interrupt
    // 链）：只 abort 不推 interrupted 事件则 /spawn 超时强停后前端状态机收不到终态（running
    // 卡死），与 /interrupt 路径语义分叉。driver.interrupt（cc 实现）= abort 全部在册 ctrl +
    // 推 interrupted；driver 未实现 interrupt（mock 系桩）时退回直 abort 在册
    // ctrl 保底（不回退既有中止能力，仅少事件面）。
    abortLikeUser: () => {
      if (opts.driver.interrupt) opts.driver.interrupt(opts.mainSession)
      else registeredCtrl?.abort()
    },
    // 二段：强释放——只放闸，不在此注销 ctrl：注销唯一落点在底层 run settle（本函数终态
    // finally）。在此注销则一段 abort 未触达底层 runTask 时（ctrl 尚未登记，或请求无视中止
    // 信号）ctrl 一经注销 isRunning 即假空闲，后续 /interrupt 对该在途请求永久失联；保留注册
    // 至 settle，/interrupt 仍可经 driver.isRunning 命中并 abort，同 owner 的新登记亦会
    // abort 旧 ctrl 防僵尸。
    forceRelease: () => {
      releaseSpawnGate(opts.bookName)
      opts.driver.emit?.(opts.mainSession, {
        type: 'warning',
        message: '手动写稿长时间无进展，疑似挂起，并发闸已被服务端强制释放（底层任务未中断，迟到结果按既有迟到覆盖口径处理）',
      })
    },
  })
  // 登记的 ctrl 在终态注销——isRunning 归 false（否则 done 后仍登记，SSE 快照假报「生成中」）
  let registeredCtrl: AbortController | null = null
  const emit = (ev: DriverEvent): void => {
    wd.touch() // 进度复位（text 增量/usage/done 等一切事件单点经此）
    opts.driver.emit?.(opts.mainSession, ev)
  }

  // 通知前端：生成开始（前端清空旧正文 + 设 running=true）
  emit({ type: 'role_spawn', role: opts.role, parentToolUseId: `tu-${Date.now()}` })

  // mock 快路：emit 模拟事件序列（runTask 的 mockText 只返回值、不透出事件流，故 mock 独立处理）
  if (process.env['CLWRITING_DRIVER'] === 'mock') {
    const mockText = `【mock · ${opts.role}】这是 mock 的模拟写稿产出。\n`
    for (let i = 0; i < mockText.length; i += 12) {
      emit({ type: 'text', text: mockText.slice(i, i + 12), role: opts.role })
    }
    emit({ type: 'usage', cost: 0.0001, tokens: 120 })
    emit({ type: 'done', cost: 0.0001, usage: 120, reason: 'success' })
    wd.cancel() // mock 快路终态撤 watchdog（无泄漏）
    return
  }

  const kind = readKind(opts.bookRoot)
  try {
    const out = await runSpec(streamSpec(opts.role, kind), {
      userDataPath: opts.userDataPath,
      bookRoot: opts.bookRoot,
      userPrompt: opts.prompt,
      // 注入源清单随 prompt 透传 → llm/call promptMeta.files
      promptFiles: opts.promptFiles,
      register: (ctrl) => {
        registeredCtrl = ctrl
        wd.touch() // ctrl 登记点亦复位
        opts.driver.registerCtrl?.(opts.mainSession, ctrl, 'spawn')
      },
      onReset: () => emit({ type: 'text_reset' }),
      onText: (delta) => emit({ type: 'text', text: delta, role: opts.role }),
      // spawn 链补接 onRetry——不接则重试对前端不可见（self-heal/chat/finish 均已接）；
      // 同款 warning 事件（对齐 self-heal.ts:876 文案与脱敏口径）
      onRetry: (attempt, error) =>
        emit({ type: 'warning', message: `AI 响应异常（${redactSecret(error)}），第 ${attempt + 1} 次重试中…` }),
    })

    if (out.ok) {
      // max_tokens 截断 → 警告（落盘保留，但让作者知道原因）
      if (out.data.stopReason === 'max_tokens') {
        emit({ type: 'warning', message: '产出达到长度上限被截断，建议调高单次输出上限' })
      }
      // 有价格表才算单次金额（input+output 按写稿模型四档分计），未配价省略 cost 字段——
      // 不发恒 0。计价用请求时刻的模型（TaskOk.model = resolve 时快照）：生成后二次
      // resolveTier 会让生成期间作者换档/改价按新价折旧调用。
      const model = out.model
      const pricing = model ? resolveModelPricing(opts.userDataPath, model) : null
      const cost = out.usage && pricing
        ? computeCallCost(pricing, {
            inputTokens: out.usage.inputTokens,
            outputTokens: out.usage.outputTokens,
            ...(out.usage.cacheReadTokens !== undefined ? { cacheReadTokens: out.usage.cacheReadTokens } : {}),
            ...(out.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: out.usage.cacheWriteTokens } : {}),
          })
        : null
      emit({ type: 'done', usage: out.usage?.outputTokens ?? 0, reason: 'success', ...(cost !== null ? { cost } : {}) })
    } else {
      // 失败分支消息过 redactSecret——out.error 是 provider/SDK 原始报错，可能携带 API Key
      // 痕迹，不经脱敏直接经 SSE 广播给前端即泄漏（emitSpawnError / SSE catch 分支同款）
      emit({ type: 'error', kind: 'provider', message: redactSecret(out.error), recoverable: false })
    }
  } finally {
    wd.cancel() // 终态撤 watchdog（成功/失败/中断统一，clearTimeout 无泄漏）
    // 底层 run settle 的注销点（唯一）——二段强释放不提前注销，
    // 强释放到 settle 之间 ctrl 留册，/interrupt 对在途请求不失联
    if (registeredCtrl) opts.driver.unregisterCtrl?.(opts.mainSession, registeredCtrl)
  }
}

/** fire-and-forget 兜底：编排器 try 外同步异常推 SSE error（防 unhandled rejection 崩进程致全部 SSE 断连） */
function emitSpawnError(driver: StudioDriver, session: Session, e: unknown): void {
  driver.emit?.(session, {
    type: 'error',
    kind: 'provider',
    // API 错误脱敏——SDK 报错 message 可能含 API Key 痕迹
    message: redactSecret(errMsg(e)),
    recoverable: false,
  })
}

/**
 * SSE 端点路径模式单源声明——index.ts 的 GET token 豁免表
 * （GET_TOKEN_EXEMPT_PATHS）引用本常量。模式与被豁免端点（自带 ticket/?token=/x-studio-token
 * 三凭据闸，见该 handler）同居一文件：路由路径若改，豁免表跟着改，只动一处（此前两处各写
 * 等价正则会静默失闸或漏豁免）。:name 为单路径段（[^/]+），与 router.ts :param 捕获口径一致。
 */
export const SSE_STREAM_PATH_PATTERN = /^\/api\/books\/[^/]+\/stream$/

/** SSE 闸门响应单源——GET 建流与 HEAD 探测共用一处。
 *  为什么：探测报给前端的「忙/拒」必须与建流真正拒的「忙/拒」逐字同口径（同状态码、
 *  同 code、同文案），两处各写一份字符串会在改动时静默分叉（探测说忙、建流却放行，
 *  或反之——前端 429 指引与真实成因失配）。 */
const replySseBusy = (res: ServerResponse): void =>
  replyError(res, 429, 'BUSY', '本书 SSE 连接数已达上限，请关闭多余的标签页/窗口')
const replySseForbidden = (res: ServerResponse): void =>
  replyError(res, 403, 'FORBIDDEN', 'forbidden')

export function registerStreamRoutes(ctx: StreamCtx): void {
  // ai→studio 反向依赖收口的注册端——chat 工具侧
  //（turns.ts）经 ai/orchestrate/task-gate-port 端口取闸，真实闸在服务构造时注入。
  // 幂等（重注册覆盖）；未注册形态仅存在于纯 ai 层单测（端口放行，见端口头注）。
  registerTaskGateProvider(acquireTaskGate)
  // SSE 订阅 driver 事件流
  defineRoute('books.stream', {
    method: 'GET',
    path: '/api/books/:name/stream',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    // GET 端点凭据校验：EventSource 不走 isWrite 拦截，单独校凭据（一次性 ticket /
    // x-studio-token 头）。
    // 口径：本机进程=同信任域——本地进程 GET /boot 即可拿 token，此处不承诺防本机进程；
    // token 的实际作用是把 SSE 可订阅面收敛到拿到 boot 的客户端，配合 Host/Origin 校验
    // （server/index.ts）防远端网页窃听创作内容。
    // URL 用 parseRequestUrl 统一解析：畸形 URL（如 `GET http://[bad`）在 handler 内抛
    // TypeError 会经 dispatch 变 500，统一回 400 BAD_INPUT 而非 500。
    const url = parseRequestUrl(req)
    if (!url) {
      replyError(res, 400, 'BAD_INPUT', 'bad request')
      return
    }
    // 一次性 ticket（POST /api/stream-ticket 换取，短时效+一次性消费）——token 不进
    // URL（进程列表/代理日志信道收敛）。
    // R0916-7-P3-19：`?token=` 旧通道（ticket 端点未上线期的过渡回退）已两端同删——
    // 前后端同包同版发布，不存在「服务端未就绪」的错配兼容对象；EventSource 侧凭据
    // 仅 ?ticket= 一条（前端换票失败即入既有退避重连，不再拼长期 token 进 URL）。
    const queryTicket = url.searchParams.get('ticket') ?? undefined
    // fetch 型客户端（429 探测）走 x-studio-token 头通道——token 不进 URL（进程列表/
    // 代理日志信道收敛）；EventSource 无法带头，凭据 = 一次性 ticket。
    const headerToken = req.headers['x-studio-token']
    // 鉴权必须在全部书域判定（连接数闸 429 / resolveBook 404）之前——否则未持凭据者可借
    // 差异响应探测书名存在性。攻击面窄（Host 闸 + 本机同信任域），统一 403 消除信道零成本。
    // 此处只「预检」不消费 ticket——在闸首烧票会让 429/404 时票被白白作废，EventSource
    // 自动重连带废票反复 403 成无诊断风暴；消费移至全部书域校验通过之后（见下方消费点）。
    if (!ctx.tickets.peek(queryTicket) && !safeTokenCompare(headerToken, ctx.studioToken)) {
      replySseForbidden(res)
      return
    }
    // per-book 连接数限制（SSE 名额上限；按句柄集合实际存活数判定）
    const sseName = params['name']!
    const conns = sseConnections.get(sseName)?.size ?? 0
    if (conns >= MAX_SSE_PER_BOOK) {
      // SSE 错误路径也走统一 JSON 信封（不再裸文本）——
      // EventSource API 不暴露 body 不受影响，curl/测试可见 code 机器码
      replySseBusy(res)
      return
    }
    if (!ctx.workDir) {
      replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
      return
    }
    // resolveBook 双行样板收编单源
    const bookR = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!bookR) return
    // 全部书域校验（429 连接数 / workDir / resolveBook 404）
    // 通过后才消费一次性 ticket、建流——429/404 不再烧票。鉴权顺序语义不变：
    // 先凭据预检（上方闸）、后书域判定、最后消费；header token 过闸者无需 ticket。
    // 竞态兜底：预检与消费之间被并发连接抢先消费 → 票已作废，403（一次性语义）。
    // 消费点必须同认 x-studio-token 头——预检认两凭据（ticket/header）任一放行，消费
    // 只认 ticket 则 header-only 请求通过全部书域校验后在建流前必 403（头通道契约只在
    // 预检半边落地即零覆盖死路）。票抢消费语义不变。
    if (!safeTokenCompare(headerToken, ctx.studioToken) && !ctx.tickets.consume(queryTicket)) {
      replyError(res, 403, 'FORBIDDEN', 'forbidden')
      return
    }
    // 校验通过后才登记连接句柄（防 early return 路径泄漏计数器致 DoS；
    // 句柄化记账——close 移除与 forgetSseCount 清账幂等互不漂移）
    const handle: SseConnHandle = { destroy: () => res.destroy() }
    const bookConns = sseConnections.get(sseName) ?? new Set<SseConnHandle>()
    bookConns.add(handle)
    sseConnections.set(sseName, bookConns)
    // close 回调注册前移至 ensureSession 之前：ensureSession 可抛异常，
    // 若 close 回调在其后才注册 → 计数器泄漏（连遭 DoS 上限）
    let heartbeat: ReturnType<typeof setInterval> | undefined = undefined
    let iter: AsyncGenerator<DriverEvent> | undefined
    let clientGone = false
    req.on('close', () => {
      clientGone = true
      if (heartbeat) clearInterval(heartbeat)
      // 按句柄移除（forgetSseCount 已清账时 get 不到即跳过——不对新账目 -1）
      const live = sseConnections.get(sseName)
      if (live) {
        live.delete(handle)
        if (live.size === 0) sseConnections.delete(sseName)
      }
      // .return() 触发生成器 finally 段，其内部抛错会让该 promise
      // reject——void 丢弃即 unhandledRejection（进程级崩溃），吞掉只留断连现场
      if (iter) {
        // 先唤醒 park 在内部 await 的生成器——iter.return 只能
        // 在 yield 边界生效，否则断开后生成器悬挂至该书下一 driver 事件才被推进回收
        // （consumer 闭包滞留，KB 级/个，事件到达即自愈）。
        // getDriver() 就地调用：close 可能在下方 driver 赋值前触发（TDZ），此处只取实现无状态
        getDriver().cancelStream?.(iter)
        void iter.return(undefined).catch(() => { /* 清理段异常不外抛 */ })
      }
      // 后台继续（backgroundMode:'continue'）：最后一个客户端断开不再 abort 编排器——
      // 生成后台跑完，重连经 sync 快照 + ring buffer 迟到回放恢复现场。
      // 显式停止仍走 POST /interrupt（用户主动取消）。
    })
    const session = await ensureSession(params['name']!, ctx.workDir)
    // ensureSession 的 await 窗口内客户端断开（页面刷新可触发）——close 回调
    // 跑空（heartbeat/iter 尚未赋值）。若照常挂载：30s 心跳 interval + channel consumer
    // 挂在 notify 上无人唤醒，泄漏到 session dispose。已断开（计数已由 close 回调减）
    // 则直接放弃建流。
    if (clientGone) return
    const driver = getDriver()

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      // SSE 流响应必须带 nosniff——与 JSON API 面同口径
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // ACAO 由全局 CORS 白名单统一设置(index.ts);不再覆写为 *,防跨站订阅 driver 流(创作内容泄露)
    })
    // 写统一走 createSseWriter（覆盖写背压判死——假死客户端不再无界缓冲）；
    // safeWrite 必须在初始 sync 快照之前创建——否则首帧裸 res.write，
    // 断连边沿对已死连接裸写一次，与全链守卫口径不一致
    const safeWrite = createSseWriter(res)

    // 连接建立即补发运行态快照:刷新/新标签会错过 init 事件(channel 消费即弃),
    // 无快照则前端 running 假空闲 → 生成中误显「可生成」可再触发 spawn
    // running 收窄为写手腿（isWriterRunning）——chat 腿
    // ctrl 以 `chat:<book>` owner 全程在册至 finish 注销，isRunning 对话期间恒真且
    // chat 终态（chat_done/chat_error 走 chat 族）不达 workbench.running，前端永不
    // 复位；对话态由 chatRunning 单独承载。driver 未实现新接口（旧桩）时回落 false，
    // 与 isRunning 缺省同型。/interrupt 的 isRunning 消费点（全停语义）不动。
    safeWrite(
      `data: ${JSON.stringify({ type: 'sync', running: driver.isWriterRunning?.(session) ?? false, chatRunning: isChatRunning(params['name']!) })}\n\n`,
    )

    // stream() 工厂同步抛错兜底——此刻 writeHead(200) 已发出，
    // 异常直穿 handler 后 dispatch 兜底因 headersSent 不回错也不 end，连接悬挂至
    // 客户端自断（心跳也未建，无任何字节回流）。catch 中按本文件既有 SSE 错误事件
    // 格式（下方 for-await 的 catch 同款：type:'error'/kind:'stream' + redactSecret
    // 脱敏）写一条 error event 后 end()，连接正常收束（close 回调走常规清理链）。
    // 心跳在此时尚未创建，无需清理；不继续走下方 for-await（iter 未建立）。
    try {
      iter = driver.stream(session) as AsyncGenerator<DriverEvent>
    } catch (e) {
      // 补诊断日志（对齐 router.ts:104 纪律——只进错误事件不留痕
      // 时排障无从下手；urlPathOnly 只记路径段，SSE token 走 query 不落日志）
      log.error('api', 'sse stream error: ' + urlPathOnly(req.url), e)
      safeWrite(
        `data: ${JSON.stringify({
          type: 'error',
          kind: 'stream',
          message: redactSecret(errMsg(e)),
          recoverable: false,
        })}\n\n`,
      )
      if (!res.writableEnded) res.end()
      return
    }
    // 心跳保活（防代理/浏览器 30-60s 无数据超时断连）
    heartbeat = setInterval(() => safeWrite(': heartbeat\n\n'), 30_000)
    try {
      for await (const ev of iter) {
        safeWrite(`data: ${JSON.stringify(ev)}\n\n`)
      }
    } catch (e) {
      // 补诊断日志（对齐 router.ts:104 纪律；urlPathOnly 只记路径段，
      // SSE token 走 query 不落日志）——流中断只进错误事件时排障无从下手
      log.error('api', 'sse stream error: ' + urlPathOnly(req.url), e)
      safeWrite(
        `data: ${JSON.stringify({
          type: 'error',
          kind: 'stream',
          message: redactSecret(errMsg(e)),
          recoverable: false,
        })}\n\n`,
      )
    }
    clearInterval(heartbeat)
    if (!res.writableEnded) res.end()
  },
  })

  /**
   * 不建流的 SSE 名额探测端点（HEAD，与 GET 同路径）。
   *
   * 为什么：前端 useSse.probeSseBusy 只为拿「连接为何被拒」的状态码，用 GET 真开流会占名额
   * ——200 路径在响应头之前即登记 connHandle（上方 books.stream 的登记点）、推 sync
   * 快照、ensureSession，客户端 abort 前该名额一直被占。与 fail-closed 首档 0ms 重连
   * 并发时探测会抢走最后一个名额（实测：4 条在途 + GET 探测 → 探测 200 计 5，紧随的
   * 正式流 429），正式连接被迫再等一档退避（4s）——探测本意是「解释断连」，反而
   * 制造了断连。HEAD 无响应体、不建流：本题只做鉴权 + 名额判定，判定完即回，名额
   * 对正式流始终可用。
   *
   * 不变量（改这条路由前先看）：
   * - 闸口径与 GET 建流逐条同源：同一套两凭据预检（ticket peek / x-studio-token 头，
   *   R0916-7-P3-19 起 `?token=` 通道已删）→ 同一名额判定（replySseBusy 单源）→ 同序的
   *   书域判定（鉴权在全部书域判定之前，未持凭据者不借差异响应探测书名存在性）。
   * - 只判定不登记：不消费 ticket（只 peek，消费点仍只在 GET）、不登记
   *   connHandle、不推 sync 快照、不 ensureSession——重复探测对名额/连接账目/会话零影响。
   * - 路由层：router.ts 按 method 精确匹配，HEAD 必须显式注册（不注册即落 404）；路径与
   *   GET 完全相同，故仍在 index.ts GET_TOKEN_EXEMPT_PATHS（SSE_STREAM_PATH_PATTERN）
   *   豁免面内，token 校验由本 handler 自带的凭据闸接管——与 GET 同一条链，无旁路。
   * - CORS：dev 跨源探测（Vite 5173 → DEV_API_BASE 7878）带 x-studio-token 头必触发预检，
   *   index.ts 的 access-control-allow-methods 必须含 HEAD（服务端放行口径
   *   与预检清单失配即浏览器侧静默失效，429 指引在 dev 丢失）。
   */
  defineRoute('books.stream.probe', {
    method: 'HEAD',
    path: '/api/books/:name/stream',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    // 与 GET 同款统一解析：畸形 URL 回 400 BAD_INPUT 而非 500
    const url = parseRequestUrl(req)
    if (!url) {
      replyError(res, 400, 'BAD_INPUT', 'bad request')
      return
    }
    // 两凭据预检（只 peek 不 consume——探测不烧票；消费点唯一保留在 GET 建流侧），
    // 与 GET 建流闸同源（`?token=` 通道已删，见上方 GET 凭据闸注）
    if (
      !ctx.tickets.peek(url.searchParams.get('ticket') ?? undefined) &&
      !safeTokenCompare(req.headers['x-studio-token'], ctx.studioToken)
    ) {
      replySseForbidden(res)
      return
    }
    const sseName = params['name']!
    const conns = sseConnections.get(sseName)?.size ?? 0
    if (conns >= MAX_SSE_PER_BOOK) {
      replySseBusy(res)
      return
    }
    if (!ctx.workDir) {
      replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
      return
    }
    if (!resolveBookOrReply(ctx.workDir, params['name'], res)) return
    // 200 = 「现在可以建流」（名额有余）——客户端只取状态码（EventSource 不暴露状态码，
    // 故这条状态码即断连成因的全部可得信息）。HEAD 无响应体：Node 对 HEAD 丢弃 body。
    reply(res, 200, { ok: true })
  },
  })

  // 触发写稿：generateText + writerSystem，fire-and-forget + SSE 回流
  defineRoute('books.spawn', {
    method: 'POST',
    path: '/api/books/:name/spawn',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    // resolveBook 成功 = workDir 非空（null 已在其 error 分支 NO_WORKDIR 覆盖）——
    // 本文件后续 ctx.workDir! 断言据此成立（ensureSession 的 session.cwd 用 workDir 而非 bookRoot）
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return

    // 忙闸：单调 busyReason('spawn') 覆盖五面（P3-12 前为五段手写 check）——自身 spawn 闸
    // （同步占位，无 TOCTOU；未实际启动的路径 finally 释放）→ self-heal 全自动写章
    //（双向均已设闸：self-heal 运行中仍接受 /spawn = 两个写手并发流式产出、落盘互相覆写草稿）
    // → 对话编排（chat 在途含 rewrite/write_chapter 等嵌套生成工具，两路 runTask 以不同章号
    // 交替记账互覆预算章块）→ 生成任务闸反向互斥（outline/lead-updates/onboard-ai/analyze
    // 等分钟级任务在途时写手草稿与任务收尾的覆盖写互踩；含跨进程锁文件面）→ 三审运行闸
    //（三审分钟级在途时 /spawn 覆写正文，审稿单的 draft_hash 守卫必然失配）。
    // 判定顺序与文案单源见 task-gate.ts 的 BUSY_MATRIX 'spawn' 行。
    const bookName = params['name']!
    const busy = busyReason(bookName, 'spawn')
    if (busy) {
      return replyError(res, 409, 'BUSY', busy)
    }
    holdSpawnGate(bookName)
    let launched = false
    try {
      // 不走 defineRoute parse：校验顺序依赖前置门，parse 化会翻转错误优先级
      //（五道 409 闸 + holdSpawnGate 在 readJson 前同步占位覆盖 body 在途窗口——防线时序）
      const body = await readJson(req)
      // role 白名单——不校验则任意字符串直进 streamSpec（未知 role
      // 静默落 error 事件路径）；客户端仅用 'writer'（WorkbenchView 唯一调用点），
      // 白名单收敛入口，扩角色时同步补表。
      const SPAWN_ROLES = new Set(['writer'])
      const rawRole = typeof body['role'] === 'string' ? (body['role'] as string) : 'writer'
      if (!SPAWN_ROLES.has(rawRole)) {
        return replyError(res, 400, 'BAD_INPUT', `未知角色 role=${rawRole}（可用：${[...SPAWN_ROLES].join('、')}）`)
      }
      const role = rawRole
      const prompt = typeof body['prompt'] === 'string' ? (body['prompt'] as string) : ''
      // 拒空 prompt——空包只有 system prompt，产出与本书无关；调用方应先拉 /draft-prompt
      if (!prompt.trim()) {
        return replyError(res, 400, 'BAD_INPUT', 'prompt 不能为空（请先拉取 /draft-prompt 组写稿上下文）')
      }
      if (prompt.length > 100_000) {
        return replyError(res, 400, 'BAD_INPUT', 'prompt 过长（上限 10 万字符）')
      }
      // GET /draft-prompt 回传的注入源清单——只作登记字符串（promptMeta.files）
      // 不再读盘，服务端仍轻校验形状（串数组、条数/长度封顶）防事件库被灌垃圾
      const promptFiles = Array.isArray(body['files'])
        ? (body['files'] as unknown[])
            .filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= 200)
            .slice(0, 64)
        : []

      const mainSession = await ensureSession(bookName, ctx.workDir!)
      const driver = getDriver()
      launched = true
      // fire-and-forget：generateText 期间 text 增量经 driver.emit → SSE 回流；
      // 终态（含失败/中断）释放并发闸
      void runWriterSpawn({
        driver,
        mainSession,
        bookName,
        userDataPath: ctx.userDataPath,
        bookRoot: r.bookRoot,
        prompt,
        role,
        promptFiles,
      })
        .catch((e) => emitSpawnError(driver, mainSession, e))
        .finally(() => releaseSpawnGate(bookName))

      reply(res, 200, { ok: true, role })
    } finally {
      if (!launched) releaseSpawnGate(bookName)
    }
  },
  })

  // 中断当前生成：AbortController.abort() + 推 interrupted，session 保留可再 spawn
  defineRoute('books.interrupt', {
    method: 'POST',
    path: '/api/books/:name/interrupt',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
    const bookName = params['name']!
    // 先停自愈编排 + 对话编排（幂等：未运行时为 no-op）
    abortSelfHeal(bookName)
    abortChat(bookName)
    // 无运行直接返回成功 no-op——无条件 ensureSession 会对无会话
    // 的书静默新建 channel（永不 dispose，泄漏）并向零消费者 push 陈旧 interrupted
    // 事件（重连客户端错认刚被中断）。运行态判定 = 三编排闸任一在途 或 driver 会话
    // 在途（registerCtrl 登记）；全空闲则不 ensureSession、不 interrupt。
    const driver0 = getDriver()
    const session0 = getSession(bookName)
    const anyRunning =
      isSelfHealRunning(bookName) ||
      isChatRunning(bookName) ||
      isSpawnRunning(bookName) ||
      (session0 !== null && (driver0.isRunning?.(session0) ?? false))
    // 返回值如实附 interrupted——true = 在途任务确被下达中断动作；false =
    // 判定时刻本就无在途（含已注册 ctrl 的 outline/review/analysis 等端点——其
    // ctrl 经 driver.isRunning 判真走真实中断路径），不做无差别 {ok:true} 假成功。
    if (!anyRunning) return reply(res, 200, { ok: true, interrupted: false })
    const session = await ensureSession(bookName, ctx.workDir!)
    const driver = getDriver()
    // await 后复检——anyRunning 判定与 ensureSession await 之间任务可能
    // 自然收尾，不复查就 interrupt 会向零消费者 push 假 interrupted 事件（重连客户端错认
    // 刚被中断）。复检仍真值才下达中断；driver.isRunning 对已注册 ctrl 的任务同样
    // 生效（cc.isRunning 覆盖全部 owner 槽位的在册 ctrl）。
    const stillRunning =
      isSelfHealRunning(bookName) ||
      isChatRunning(bookName) ||
      isSpawnRunning(bookName) ||
      (driver.isRunning?.(session) ?? false)
    if (stillRunning && driver.interrupt) driver.interrupt(session)
    reply(res, 200, { ok: true, interrupted: stillRunning })
  },
  })

  // 全自动写章(红项自愈闭环):AI 写稿 → 机检 → 红则自动退回重写 → 全绿或触顶交作者。
  // fire-and-forget(与 /spawn 同风格):编排最长可跑十几分钟,进度全程经主 session SSE 回流。
  defineRoute('books.auto-write', {
    method: 'POST',
    path: '/api/books/:name/auto-write',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
    const bookName = params['name']!
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到用户数据目录')
    // 忙闸首查：单调 busyReason('auto-write') 覆盖四面（P3-12 前为四段手写 check，且
    // 同一句文案一处半角逗号一处全角——现单源全角）：
    // ① self-heal 自查——本闸是编排级内存锁，覆盖 self-heal 完整生命周期：机检/账本草稿
    //   等阶段无在途 LLM 请求，driver.isRunning 仍为 false，只有本闸拦得住重复触发（两个
    //   编排器会互相覆写草稿）。生成期与 driver.isRunning 重叠冗余，保留无害：登记受
    //   /interrupt 注销影响存在时序窗口，内存闸始终是可靠口径；
    // ② chat 在途（嵌套生成工具按章记账）会互覆预算章块并掐断在途对话；
    // ③ spawn 在途 = 双写手并发流式产出互覆草稿（saveDraft 与前端保存竞争）；
    // ④ 生成任务闸反向互斥——outline/lead-updates/onboard-ai/analyze 持闸（分钟级）期间
    //   启动 self-heal，其收尾覆盖写细纲.md/账本推进.md，后续章拿到混合态上下文（双费 +
    //   两端闭合误报红触发多余重写）；含跨进程锁文件面（双进程形态下他进程任务可见）。
    {
      const busy = busyReason(bookName, 'auto-write')
      if (busy) {
        return replyError(res, 409, 'BUSY', busy)
      }
    }

    // 不走 defineRoute parse：校验顺序依赖前置门，parse 化会翻转错误优先级
    //（r0912-cross-process-write-gates 钉「首检即拦，不进 chapter 校验」：跨进程闸在持 + 空 body → 409 非 400）
    const body = await readJson(req)
    const chapter = Number(body['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) {
      return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')
    }
    // 批量连写——batchSize 1-20，有值则生成连续章号序列（中途红项触顶停当前章，不续后续）
    const rawBatch = body['batchSize']
    const batchSize = rawBatch === undefined ? 1 : Number(rawBatch)
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
      return replyError(res, 400, 'BAD_INPUT', 'batchSize 需为 1-20 的整数')
    }
    const chapters = batchSize > 1 ? Array.from({ length: batchSize }, (_, i) => chapter + i) : undefined

    const mainSession = await ensureSession(bookName, ctx.workDir!)
    // 二次检查（await 期间可能另一个请求已启动）——TOCTOU 收窄；chat/spawn 闸同款补查
    // R0916-7-P3-12：复检 = 同一单源再调一次（readJson + ensureSession 两个 await 的窗口
    // 内新起的编排/新 acquire 的分钟级任务闸在此拦截：self-heal 收尾覆盖写 细纲.md/账本
    // 推进.md 时与任务产出互踩）。首查与复检同表同序，不再各写一份手写闸。
    {
      const busyRecheck = busyReason(bookName, 'auto-write')
      if (busyRecheck) {
        return replyError(res, 409, 'BUSY', busyRecheck)
      }
    }
    const driver = getDriver()
    // self-heal 的 ctrl 登记 driver（与 /spawn 的 runWriterSpawn 同款接线）——
    // 生成期 isRunning() 真值（否则 SSE sync 快照假空闲，前端可误触 /spawn 互相覆写草稿），
    // /interrupt 的 driver.interrupt() 也能直接 abort 在途请求（与 abortSelfHeal 双保险）。
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
        const s = getSession(bookName)
        if (s) driver.interrupt?.(s)
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
        driver.emit?.(mainSession, {
          type: 'warning',
          message: '全自动写章长时间无进展，疑似挂起，已被服务端强制收尾并释放并发闸（底层任务未中断，迟到结果按既有迟到覆盖口径处理）',
        })
      },
    })
    // 进度复位式计时——编排器一切事件经 onActivity 回调（self-heal generate 的 emit
    // 单点）复位 watchdog，下方 register 回调在 ctrl 登记点另行复位。driver 原样直通：
    // 端点不再包装它，中断能力（interrupt/isRunning/registerCtrl…）无转发面可漏——
    // 包装式曾把 registerCtrl 丢成 undefined，pass 后的后台账本草稿
    //（runRegisteredBgTask）登记落空、/interrupt 找不到 ctrl（质量评审 P2-1）。
    // 本端点 200 先回、编排后台跑（fire-and-forget）——登记进 server 在途工作表：
    // close 收尾的裸 close 只等连接清空，编排仍持会话库（userData/session/*.db）与
    // 机检库句柄在写，调用方（e2e/集成测试）close 后立刻 rmSync 临时目录会在 Windows
    // 落 EPERM（同 R0910-W 的 Worker 句柄族；rag 的 buildIndex 同款登记先例）。
    void trackInFlightWork(
      runSelfHeal({
        driver,
        mainSession,
        userDataPath: ctx.userDataPath!,
        cwd: ctx.workDir!,
        bookRoot: r.bookRoot,
        bookName,
        chapter,
        ...(chapters ? { chapters } : {}),
        onActivity: () => wd.touch(),
        register: (c) => {
          registered = c
          wd.touch() // ctrl 登记点亦复位
          driver.registerCtrl?.(mainSession, c, 'self-heal')
        },
      })
        .catch((e) => emitSpawnError(driver, mainSession, e))
        .finally(() => {
          wd.cancel() // 终态撤 watchdog（正常完成/中止/失败统一，clearTimeout 无泄漏）
          // 底层 run settle 的注销点（唯一）——二段强释放不提前
          // 注销，强释放到 settle 之间 ctrl 留册，/interrupt 对在途请求不失联
          if (registered) driver.unregisterCtrl?.(mainSession, registered)
        }),
    )

    reply(res, 200, { ok: true, chapter, ...(batchSize > 1 ? { batchSize, chapters } : {}) })
  },
  })

}
