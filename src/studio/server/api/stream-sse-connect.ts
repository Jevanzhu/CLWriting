/**
 * SSE 建流 / 名额探测一族——stream.ts 的 books.stream（GET 建流）与 books.stream.probe
 * （HEAD 探测）两 handler 体下沉档。
 *
 * 为什么两 handler 同档：两者共享同一套闸口径与同一组回包单源（replySseBusy /
 * replySseForbidden），探测端点的全部存在理由就是「报给前端的忙/拒与建流真正拒的
 * 逐字同口径」——两处各写一份字符串会在改动时静默分叉（探测说忙、建流却放行）。
 * method/path 声明与 token 豁免模式（SSE_STREAM_PATH_PATTERN）留在 stream.ts。
 *
 * 行为不变量（纯下沉，逐字等价）：凭据两闸（ticket peek / x-studio-token 头）在全部书域
 * 判定（连接数 429 / workDir 400 / resolveBook 404）之前；ticket 预检不消费、消费点仅在
 * 全部书域校验通过之后（429/404 不烧票）；名额登记只在建流路径、探测只判定不登记
 * （不消费票/不登记句柄/不推快照/不建会话）；断连清理（句柄移除 + 生成器 return +
 * 后台继续语义）与错误事件的脱敏/留痕口径不变。
 *
 * 依赖方向单向（无环）：本文件 → http / book-context / log / ai 编排态（isChatRunning）
 * + 同目录 stream-sse-writer（连接记账与安全写）/ stream-watchdog 无引用；stream.ts
 * 单向 import 本文件（本文件对 stream.ts 只有 type 面回引 StreamCtx，编译期擦除）。
 * 顶层无求值常量，无 TDZ 面。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { reply, replyError, parseRequestUrl, urlPathOnly, safeTokenCompare } from '../http.js'
import { log, errMsg } from '../../../log/index.js'
import { resolveBookOrReply } from '../book-context.js'
import type { DriverEvent } from '../../../driver/index.js'
import { isChatRunning } from '../../../ai/orchestrate/chat.js'
import { redactSecret } from '../../../ai/provider/redact.js' // API 错误脱敏——SDK 报错 message 可能含 API Key 痕迹
import { sseConnections, MAX_SSE_PER_BOOK, createSseWriter } from './stream-sse-writer.js'
import type { SseConnHandle } from './stream-sse-writer.js'
import type { StreamCtx } from './stream.js'

/** SSE 闸门响应单源——GET 建流与 HEAD 探测共用一处。
 *  为什么：探测报给前端的「忙/拒」必须与建流真正拒的「忙/拒」逐字同口径（同状态码、
 *  同 code、同文案），两处各写一份字符串会在改动时静默分叉（探测说忙、建流却放行，
 *  或反之——前端 429 指引与真实成因失配）。 */
const replySseBusy = (res: ServerResponse): void =>
  replyError(res, 429, 'BUSY', '本书 SSE 连接数已达上限，请关闭多余的标签页/窗口')
const replySseForbidden = (res: ServerResponse): void => replyError(res, 403, 'FORBIDDEN', 'forbidden')

/** 进程级 SSE 总名额（跨书）——per-book 名额（stream-sse-writer.ts 的 MAX_SSE_PER_BOOK）
 *  只约束单书：多书库多窗口场景总连接数 = 每书上限 × 书数，FD 上限全靠 OS 兜底。
 *  判定只在本文件两处名额判点（GET 建流与不建流 HEAD 探测）消费，与每书名额同序同源
 *  （同一 replySseBusy 单源回包）；只读观测出口 = __getSseConnections（按书快照，求和
 *  即进程级总连接数）。 */
export const MAX_SSE_TOTAL = 20
let sseTotalMax = MAX_SSE_TOTAL

/** @internal 测试钩子：注入进程级总名额（构造「跨书总名额耗尽 → 429」臂）；恢复传 MAX_SSE_TOTAL。 */
export function __setSseTotalMaxForTest(n: number): void {
  sseTotalMax = n
}

function sseTotalExhausted(): boolean {
  let total = 0
  for (const conns of sseConnections.values()) total += conns.size
  return total >= sseTotalMax
}

export async function handleBookStream(
  ctx: StreamCtx,
  routeCtx: { params: Record<string, string> },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { params } = routeCtx
  // GET 端点凭据校验：EventSource 不走 isWrite 拦截，单独校凭据（一次性 ticket /
  // fetch 型客户端（429 探测）走 x-studio-token 头通道——token 不进 URL（进程列表/
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
  // `?token=` 旧通道（ticket 端点未上线期的过渡回退）已两端同删——
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
  if (conns >= MAX_SSE_PER_BOOK || sseTotalExhausted()) {
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
    // .return 触发生成器 finally 段，其内部抛错会让该 promise
    // reject——void 丢弃即 unhandledRejection（进程级崩溃），吞掉只留断连现场
    if (iter) {
      // 先唤醒 park 在内部 await 的生成器——iter.return 只能
      // 在 yield 边界生效，否则断开后生成器悬挂至该书下一 driver 事件才被推进回收
      // （consumer 闭包滞留，KB 级/个，事件到达即自愈）。
      // getDriver 就地调用：close 可能在下方 driver 赋值前触发（TDZ），此处只取实现无状态
      ctx.driver.driver.cancelStream(iter)
      void iter.return(undefined).catch(() => {
        /* 清理段异常不外抛 */
      })
    }
    // 后台继续（backgroundMode:'continue'）：最后一个客户端断开不再 abort 编排器——
    // 生成后台跑完，重连经 sync 快照 + ring buffer 迟到回放恢复现场。
    // 显式停止仍走 POST /interrupt（用户主动取消）。
  })
  const session = await ctx.driver.ensureSession(params['name']!, ctx.workDir)
  // ensureSession 的 await 窗口内客户端断开（页面刷新可触发）——close 回调
  // 跑空（heartbeat/iter 尚未赋值）。若照常挂载：30s 心跳 interval + channel consumer
  // 挂在 notify 上无人唤醒，泄漏到 session dispose。已断开（计数已由 close 回调减）
  // 则直接放弃建流。
  if (clientGone) return
  const driver = ctx.driver.driver

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
  // 复位；对话态由 chatRunning 单独承载。（driver 契约必需化）：
  // isWriterRunning 为必需成员（mock 显式 false 桩），可选链与回落 false 删除。
  // 与 isRunning 缺省同型。/interrupt 的 isRunning 消费点（全停语义）不动。
  safeWrite(
    `data: ${JSON.stringify({ type: 'sync', running: driver.isWriterRunning(session), chatRunning: isChatRunning(params['name']!) })}\n\n`,
  )

  // stream 工厂同步抛错兜底——此刻 writeHead(200) 已发出，
  // 异常直穿 handler 后 dispatch 兜底因 headersSent 不回错也不 end，连接悬挂至
  // 客户端自断（心跳也未建，无任何字节回流）。catch 中按本文件既有 SSE 错误事件
  // 格式（下方 for-await 的 catch 同款：type:'error'/kind:'stream' + redactSecret
  // 脱敏）写一条 error event 后 end，连接正常收束（close 回调走常规清理链）。
  // 心跳在此时尚未创建，无需清理；不继续走下方 for-await（iter 未建立）。
  try {
    iter = driver.stream(session) as AsyncGenerator<DriverEvent>
  } catch (e) {
    // 补诊断日志（对齐 router.ts 纪律——只进错误事件不留痕
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
    // 补诊断日志（对齐 router.ts 纪律；urlPathOnly 只记路径段，
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
}

/**
 * 不建流的 SSE 名额探测端点（HEAD，与 GET 同路径）的 handler 体。
 *
 * 为什么：前端 useSse.probeSseBusy 只为拿「连接为何被拒」的状态码，用 GET 真开流会占名额
 * ——200 路径在响应头之前即登记 connHandle（建流路径的登记点）、推 sync
 * 快照、ensureSession，客户端 abort 前该名额一直被占。与 fail-closed 首档 0ms 重连
 * 并发时探测会抢走最后一个名额（实测：4 条在途 + GET 探测 → 探测 200 计 5，紧随的
 * 正式流 429），正式连接被迫再等一档退避（4s）——探测本意是「解释断连」，反而
 * 制造了断连。HEAD 无响应体、不建流：本题只做鉴权 + 名额判定，判定完即回，名额
 * 对正式流始终可用。
 *
 * 不变量（改这条路由前先看）：
 * - 闸口径与 GET 建流逐条同源：同一套两凭据预检（ticket peek / x-studio-token 头，
 *   起 `?token=` 通道已删）→ 同一名额判定（replySseBusy 单源）→ 同序的
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
export async function handleBookStreamProbe(
  ctx: StreamCtx,
  routeCtx: { params: Record<string, string> },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { params } = routeCtx
  // 与 GET 同款统一解析：畸形 URL 回 400 BAD_INPUT 而非 500
  const url = parseRequestUrl(req)
  if (!url) {
    replyError(res, 400, 'BAD_INPUT', 'bad request')
    return
  }
  // 两凭据预检（只 peek 不 consume——探测不烧票；消费点唯一保留在 GET 建流侧），
  // 与 GET 建流闸同源（`?token=` 通道已删，见 GET 凭据闸注）
  if (
    !ctx.tickets.peek(url.searchParams.get('ticket') ?? undefined) &&
    !safeTokenCompare(req.headers['x-studio-token'], ctx.studioToken)
  ) {
    replySseForbidden(res)
    return
  }
  const sseName = params['name']!
  const conns = sseConnections.get(sseName)?.size ?? 0
  if (conns >= MAX_SSE_PER_BOOK || sseTotalExhausted()) {
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
}
