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
import { readJson, reply, replyError, parseRequestUrl } from '../http.js'
import { resolveBook } from '../book-context.js'
import { ensureSession, getDriver, getSession } from '../../../driver/index.js'
import type { DriverEvent, Session, StudioDriver } from '../../../driver/index.js'
import { abortSelfHeal, isSelfHealRunning, isChatEmbeddedSelfHealRunning, runSelfHeal } from '../../../ai/orchestrate/self-heal.js'
import { hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { isChatRunning, abortChat, resolveChatConfirm, clearChatHistory, sendChatMessage } from '../../../ai/orchestrate/chat.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { streamSpec } from '../../../ai/tasks/specs.js'
import { readKind } from '../book-context.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏
import { resolveModelPricing, computeCallCost } from '../../../ai/pricing.js'
import { safeTokenCompare } from '../http.js'
import type { StreamTicketStore } from './stream-ticket.js'
import { heldTaskGatesFor } from './task-gate.js'
import { isReviewRunningForBook } from './review.js'
// M-2（第八轮）：spawn 闸移驻 ai 层（turns.ts 的嵌套生成工具闸要查它，ai 层不得反向
// import server 路由层）；此处再导出保持 books/audit/测试的既有导入不变
import { isSpawnRunning, holdSpawnGate, releaseSpawnGate, __setSpawnRunning } from '../../../ai/orchestrate/spawn-registry.js'

export { isSpawnRunning, __setSpawnRunning }

interface StreamCtx {
  workDir: string | null
  userDataPath: string | null
  /** GET SSE 端点 token 校验用（EventSource 不走 isWrite 拦截） */
  studioToken: string
  /** R73-49（二十一轮）：本 server 实例的 ticket 库（与 /api/stream-ticket 签发侧同实例共享） */
  tickets: StreamTicketStore
}

// P2-2：per-book SSE 连接记账（防多标签页耗尽 FD）。
// S2（五十九轮）：计数改按实际存活连接记账（Map<book, Set<句柄>>）——原裸数字计数
// 在 chat.clear 直接 delete 后，旧连接 close 回调仍会对新账目 -1（漂移为 0 下限），
// MAX_SSE 限制可被绕空。句柄登记于鉴权通过时、req close 时移除；forgetSseCount
// 销毁该书全部在途连接并同步清账（close 回调移除幂等）。
interface SseConnHandle {
  /** 强制断开该连接（destroy → 触发 req close → 常规清理链） */
  destroy(): void
}
const sseConnections = new Map<string, Set<SseConnHandle>>()
const MAX_SSE_PER_BOOK = 5

/** R-18（第十六轮）：书级生命周期终态清 per-book SSE 计数——删书（books.delete）与
 *  清空对话（chat.clear）此前不清理，残留计数让同名重建书被旧计数顶到 429 上限
 *  （计数只在 req close 时递减，书删后连接早已散场无从归零）。命名对齐 books.ts
 *  的 forgetSession/forgetService 族。
 *  S2（五十九轮）：改销毁该书全部在途连接 + 同步清账——原裸 delete 不断连接，旧连接
 *  close 时对新账目 -1 造成漂移。 */
export function forgetSseCount(bookName: string): void {
  const conns = sseConnections.get(bookName)
  if (!conns) return
  sseConnections.delete(bookName) // 先清账：close 回调的移除幂等（get 不到即跳过）
  for (const h of conns) h.destroy()
}

/** R-18：测试观测钩子（对齐 __setSpawnRunning 风格）——按句柄集合重算只读快照断言计数。 */
export function __getSseConnections(): ReadonlyMap<string, number> {
  const snapshot = new Map<string, number>()
  for (const [name, conns] of sseConnections) snapshot.set(name, conns.size)
  return snapshot
}

/** P-8（第十四轮）：SSE 写背压判死阈值——res.write() 返回 false 起（假死客户端 TCP
 *  接收窗口关死），滞留 Node writable 队列的字节累计超此值即 destroy 断连（1MB ≈
 *  数十条章节级事件；受 MAX_SSE_PER_BOOK 与事件量约束，正常客户端远达不到）。 */
export const SSE_BACKPRESSURE_LIMIT = 1_000_000

/** R64-26（十二轮）：连续滞留写判死阈值——write() 连续返回 false 的次数（drain/成功
 * 写复位）。字节闸对「仅心跳存活」的假死连接几乎失效（心跳 ~14B/30s，1MB 需约 25
 * 天累计）；次数闸补位：240 次 × 30s = 2 小时无一次 drain 即判死。数据突发场景由
 * 字节闸先行（1MB 远早于 240 次到达），本闸只兜心跳型假死。 */
export const SSE_STUCK_WRITES_LIMIT = 240

/** P-8：背压守卫所需的 res 最小面（结构化收窄——不用 Pick<ServerResponse,...>，
 *  真实 ServerResponse.on 返回 this，假 res/单测桩返回 void 无法满足该签名）。 */
interface SseWritable {
  writableEnded: boolean
  destroyed: boolean
  write(chunk: string): boolean
  on(event: 'drain', listener: () => void): unknown
  destroy(): void
}

/**
 * P-8（第十四轮）：SSE 安全写 + 背压判死。
 * - 已断开（writableEnded / destroyed）静默丢弃（既有守卫语义不变）；
 * - write() 返回 false 自此累计滞留字节、drain 事件复位、成功写复位；
 * - 累计超 limit 判死 res.destroy()——假死连接不再让服务端内存无界缓冲（走既有
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
      // R65-42（总六十五轮）：滞留字节按 UTF-8 实际字节数计——原 chunk.length 是
      // UTF-16 码元数，中文事件实际滞留约为计数 3 倍（1MB 阈值实际放行 ~3MB，
      // 背压判死闸对中文流形同放宽 3 倍）
      pendingBytes += Buffer.byteLength(chunk, 'utf8')
      stuckWrites += 1
      // R64-26（十二轮）：字节闸 + 连续次数双判死——次数闸兜「仅心跳存活」的假死连接
      if (pendingBytes > limit || stuckWrites > stuckLimit) res.destroy()
    } else {
      pendingBytes = 0
      stuckWrites = 0
    }
  }
}

// RB-SV-P2-1：per-book spawn 运行闸（与 /auto-write 的 self-heal 闸同模式）——
// 双标签页时序窗口并发双 spawn 会互相覆写草稿回流。占位在首个 await 前同步完成
// （比 auto-write 的「检查→await→二次检查」更严，无 TOCTOU 窗口），终态 finally 释放。
// （闸本体在 ai/orchestrate/spawn-registry.ts，M-2·第八轮移驻）

/**
 * fire-and-forget 写稿：产物经 runTask 统一编排（mock/provider/中断/错误文案），
 * text 增量经 driver.emit 推 SSE。替代旧 driver.spawnRole 路径。
 * P1-2：ctrl 经 registerCtrl 交给 driver——interrupt() 可 abort 真实请求，isRunning() 判在途。
 */
async function runWriterSpawn(opts: {
  driver: StudioDriver
  mainSession: Session
  userDataPath: string | null
  bookRoot: string
  prompt: string
  role: string
  /** Q-5（第十五轮）：GET /draft-prompt 回传的注入源清单 → promptMeta.files 登记 */
  promptFiles: string[]
}): Promise<void> {
  const emit = (ev: DriverEvent): void => {
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
    return
  }

  const kind = readKind(opts.bookRoot)
  // X-P2-11：登记的 ctrl 在终态注销——isRunning 归 false（此前 done 后仍登记，SSE 快照假报「生成中」）
  let registered: AbortController | null = null
  try {
    const out = await runSpec(streamSpec(opts.role, kind), {
      userDataPath: opts.userDataPath,
      bookRoot: opts.bookRoot,
      userPrompt: opts.prompt,
      // Q-5（第十五轮）：注入源清单随 prompt 透传 → llm/call promptMeta.files
      promptFiles: opts.promptFiles,
      register: (ctrl) => {
        registered = ctrl
        opts.driver.registerCtrl?.(opts.mainSession, ctrl, 'spawn')
      },
      onReset: () => emit({ type: 'text_reset' }),
      onText: (delta) => emit({ type: 'text', text: delta, role: opts.role }),
    })

    if (out.ok) {
      // B-3：max_tokens 截断 → 警告（落盘保留，但让作者知道原因）
      if (out.data.stopReason === 'max_tokens') {
        emit({ type: 'warning', message: '产出达到长度上限被截断，建议调高单次输出上限' })
      }
      // D2（批 5）：有价格表算单次金额（input+output 按写稿模型四档分计），
      // 未配价省略 cost 字段——不再发恒 0（mock 遗留口径修正）
      // R70-11（十八轮）：计价用请求时刻的模型（TaskOk.model = resolve 时快照，Y-15 同
      // 口径）——此前生成后二次 resolveTier，生成期间作者换档/改价会按新价折旧调用。
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
      // R26-8（二十六轮）：失败分支消息过 redactSecret——runSpec 失败的 out.error 是
      // provider/SDK 原始报错，可能携带 API Key 痕迹，此前未脱敏直接经 SSE 广播给
      // 前端（emitSpawnError / SSE catch 分支均有同款先例）
      emit({ type: 'error', kind: 'provider', message: redactSecret(out.error), recoverable: false })
    }
  } finally {
    if (registered) opts.driver.unregisterCtrl?.(opts.mainSession, registered)
  }
}

/** fire-and-forget 兜底：编排器 try 外同步异常推 SSE error（防 unhandled rejection 崩进程致全部 SSE 断连） */
function emitSpawnError(driver: StudioDriver, session: Session, e: unknown): void {
  driver.emit?.(session, {
    type: 'error',
    kind: 'provider',
    // P2-4：API 错误脱敏——SDK 报错 message 可能含 API Key 痕迹
    message: redactSecret(e instanceof Error ? e.message : String(e)),
    recoverable: false,
  })
}

export function registerStreamRoutes(ctx: StreamCtx): void {
  // SSE 订阅 driver 事件流
  defineRoute('books.stream', {
    method: 'GET',
    path: '/api/books/:name/stream',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    // GET 端点 token 校验：EventSource 不走 isWrite 拦截，单独校 query token。
    // ee-P2-12 口径修正（2026-08-17 拍板）：本机进程=同信任域——本地进程 GET /boot 即可拿
    // token，此处不承诺防本机进程；token 的实际作用是把 SSE 可订阅面收敛到拿到 boot 的
    // 客户端，配合 Host/Origin 校验（server/index.ts）防远端网页窃听创作内容。
    // E-5（第五十三轮）：SSE 端点改用 R-19（第十六轮）parseRequestUrl 统一解析
    // （Q-1/N-3 口径）——畸形 URL（如 `GET http://[bad`）原在 handler 内抛
    // TypeError 经 dispatch 变 500，现与六处 API 裸调同款回 400 BAD_INPUT。
    const url = parseRequestUrl(req)
    if (!url) {
      replyError(res, 400, 'BAD_INPUT', 'bad request')
      return
    }
    // T2 批：优先一次性 ticket（POST /api/stream-ticket 换取，短时效+一次性消费）——
    // token 不再进 URL（进程列表/代理日志信道收敛）。`?token=` 旧通道保留为兼容期
    // 通道（e2e 及未升级客户端），两凭据任一过闸即放行。
    const queryTicket = url.searchParams.get('ticket') ?? undefined
    const queryToken = url.searchParams.get('token') ?? undefined
    // R64-27（十二轮）：鉴权前移到全部书域判定（连接数闸 429 / resolveBook 404）之前
    // ——原顺序让未持凭据者借差异响应探测书名存在性。攻击面窄（Host 闸 + 本机同
    // 信任域），统一 403 消除信道零成本。
    // R65-43（总六十五轮）：此处只「预检」不消费 ticket——原 consumeStreamTicket 在
    // 闸首即烧掉一次性 ticket，429/404 时票被白白作废，EventSource 自动重连带废票
    // 反复 403 成无诊断风暴；消费移至全部书域校验通过之后（见下方 R65-43 消费点）。
    if (!ctx.tickets.peek(queryTicket) && !safeTokenCompare(queryToken, ctx.studioToken)) {
      replyError(res, 403, 'FORBIDDEN', 'forbidden')
      return
    }
    // P2-2：per-book 连接数限制（S2：按句柄集合实际存活数判定）
    const sseName = params['name']!
    const conns = sseConnections.get(sseName)?.size ?? 0
    if (conns >= MAX_SSE_PER_BOOK) {
      // hh §八-12：SSE 错误路径也走统一 JSON 信封（原裸文本 'too many connections'）——
      // EventSource API 不暴露 body 不受影响，curl/测试可见 code 机器码
      replyError(res, 429, 'BUSY', '本书 SSE 连接数已达上限，请关闭多余的标签页/窗口')
      return
    }
    if (!ctx.workDir) {
      replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
      return
    }
    const bookR = resolveBook(ctx.workDir, params['name'])
    if ('error' in bookR) {
      replyError(res, bookR.status, bookR.code, bookR.error)
      return
    }
    // R65-43（总六十五轮）：全部书域校验（429 连接数 / workDir / resolveBook 404）
    // 通过后才消费一次性 ticket、建流——429/404 不再烧票。鉴权顺序语义不变：
    // 先凭据预检（上方闸）、后书域判定、最后消费；token 过闸者无需 ticket。
    // 竞态兜底：预检与消费之间被并发连接抢先消费 → 票已作废，403（一次性语义）。
    if (!safeTokenCompare(queryToken, ctx.studioToken) && !ctx.tickets.consume(queryTicket)) {
      replyError(res, 403, 'FORBIDDEN', 'forbidden')
      return
    }
    // 校验通过后才登记连接句柄（P1-1：防 early return 路径泄漏计数器致 DoS；
    // S2：句柄化记账——close 移除与 forgetSseCount 清账幂等互不漂移）
    const handle: SseConnHandle = { destroy: () => res.destroy() }
    const bookConns = sseConnections.get(sseName) ?? new Set<SseConnHandle>()
    bookConns.add(handle)
    sseConnections.set(sseName, bookConns)
    // close 回调注册前移至 ensureSession 之前：ensureSession 可抛异常，
    // 若 close 回调在其后才注册 → 计数器泄漏（连遭 DoS 上限）
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let iter: AsyncGenerator<DriverEvent> | undefined
    let clientGone = false
    req.on('close', () => {
      clientGone = true
      if (heartbeat) clearInterval(heartbeat)
      // S2：按句柄移除（forgetSseCount 已清账时 get 不到即跳过——不对新账目 -1）
      const live = sseConnections.get(sseName)
      if (live) {
        live.delete(handle)
        if (live.size === 0) sseConnections.delete(sseName)
      }
      // 低级项（第六轮）：.return() 触发生成器 finally 段，其内部抛错会让该 promise
      // reject——void 丢弃即 unhandledRejection（进程级崩溃），吞掉只留断连现场
      if (iter) {
        // B-19（第六十轮补修）：先唤醒 park 在内部 await 的生成器——iter.return 只能
        // 在 yield 边界生效，此前断开后生成器悬挂至该书下一 driver 事件才被推进回收
        // （consumer 闭包滞留，KB 级/个、事件到达即自愈，登记维持项本次补修）。
        // getDriver() 就地调用：close 可能在下方 driver 赋值前触发（TDZ），此处只取实现无状态
        getDriver().cancelStream?.(iter)
        void iter.return(undefined).catch(() => { /* 清理段异常不外抛 */ })
      }
      // E1c（后台继续，cherry backgroundMode:'continue'）：最后一个客户端断开不再 abort 编排器——
      // 生成后台跑完，重连经 sync 快照 + ring buffer 迟到回放（E1b）恢复现场。
      // 显式停止仍走 POST /interrupt（用户主动取消）。
    })
    // session.cwd = workDir(角色 agents 在 workDir/.claude/agents,init generateRoleShells 生成处)
    const session = await ensureSession(params['name']!, ctx.workDir)
    // 第五轮：ensureSession 的 await 窗口内客户端断开（页面刷新可触发）——close 回调
    // 跑空（heartbeat/iter 尚未赋值）。若照常挂载：30s 心跳 interval + channel consumer
    // 挂在 notify 上无人唤醒，泄漏到 session dispose。已断开（计数已由 close 回调减）
    // 则直接放弃建流。
    if (clientGone) return
    const driver = getDriver()

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // ACAO 由全局 CORS 白名单统一设置(index.ts);不再覆写为 *,防跨站订阅 driver 流(创作内容泄露)
    })
    // P-8：写统一走 createSseWriter（覆盖写背压判死——假死客户端不再无界缓冲）；
    // B-20（第六十轮）：safeWrite 创建前移到初始 sync 快照之前——此前首帧裸 res.write，
    // 断连边沿对已死连接裸写一次，与全链守卫口径不一致
    const safeWrite = createSseWriter(res)

    // 连接建立即补发运行态快照:刷新/新标签会错过 init 事件(channel 消费即弃),
    // 无快照则前端 running 假空闲 → 生成中误显「可生成」可再触发 spawn
    safeWrite(
      `data: ${JSON.stringify({ type: 'sync', running: driver.isRunning?.(session) ?? false, chatRunning: isChatRunning(params['name']!) })}\n\n`,
    )

    // driver.stream 实现为 async generator（mock / cc 均从 channel 推事件）
    iter = driver.stream(session) as AsyncGenerator<DriverEvent>
    // K5：心跳保活（防代理/浏览器 30-60s 无数据超时断连）
    heartbeat = setInterval(() => safeWrite(': heartbeat\n\n'), 30_000)
    try {
      for await (const ev of iter) {
        safeWrite(`data: ${JSON.stringify(ev)}\n\n`)
      }
    } catch (e) {
      safeWrite(
        `data: ${JSON.stringify({
          type: 'error',
          kind: 'stream',
          message: redactSecret(e instanceof Error ? e.message : String(e)),
          recoverable: false,
        })}\n\n`,
      )
    }
    clearInterval(heartbeat)
    if (!res.writableEnded) res.end()
  },
  })

  // 触发写稿：generateText + writerSystem，fire-and-forget + SSE 回流
  defineRoute('books.spawn', {
    method: 'POST',
    path: '/api/books/:name/spawn',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    // resolveBook 成功 = workDir 非空（null 已在其 error 分支 NO_WORKDIR 覆盖）——
    // 本文件后续 ctx.workDir! 断言据此成立（ensureSession 的 session.cwd 用 workDir 而非 bookRoot）
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)

    // RB-SV-P2-1：并发闸——同步占位（无 TOCTOU），未实际启动的路径 finally 释放防泄漏
    const bookName = params['name']!
    if (isSpawnRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在生成，先等它跑完或中断')
    }
    // dd-P2：与全自动写章互斥——双向均已设闸（/auto-write 侧 M-2·第八轮补齐 spawnRunning
    // 检查；此前该注释宣称「/auto-write 已查 spawnRunning」但该检查从未存在，git 考古
    // c0b82be 起即失实）：self-heal 运行中仍接受 /spawn = 两个写手并发流式产出、落盘互相覆写草稿
    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断')
    }
    // AI-1（第七轮）：与对话编排互斥——M-1（第六轮）只修了 chat→self-heal 单向，反向
    // 此前缺失：chat 在途（含 rewrite/write_chapter 等嵌套生成工具）时再启动 /spawn，
    // 两路 runTask 以不同章号交替记账互覆预算章块；跨编排 ctrl 并存虽已不互相 abort
    // （M-1·第八轮 owner 分槽），但写手并发互覆草稿的根矛盾仍在，入口闸是正解
    if (isChatRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书对话进行中，先等它结束或中断再手动写稿')
    }
    // R71-1（总七十一轮）：生成任务闸反向互斥——对齐 /chat（R70-5）与删书/改名 busyGate
    // 口径：outline/lead-updates/onboard-ai/analyze 等分钟级任务在途时再 /spawn，写手
    // 草稿与任务收尾的覆盖写（细纲.md/账本推进.md 等上下文注入源）互相踩踏
    {
      const held = heldTaskGatesFor(bookName)
      if (held.length > 0) {
        return replyError(res, 409, 'BUSY', `本书有任务在跑（${held.join('、')}），先等它完成或中断再手动写稿`)
      }
    }
    // R71-1：三审运行闸反向互斥（isReviewRunningForBook，同 busyGate 引用）——三审分钟级
    // 在途时 /spawn 覆写正文，审稿单的 draft_hash 守卫（R61-13）必然失配
    if (isReviewRunningForBook(bookName)) {
      return replyError(res, 409, 'BUSY', '本书三审进行中，先等它完成后再手动写稿')
    }
    holdSpawnGate(bookName)
    let launched = false
    try {
      const body = await readJson(req)
      // R33-68（三十三轮）：role 白名单——此前任意字符串直进 streamSpec（未知 role
      // 静默落 error 事件路径）；现客户端仅用 'writer'（WorkbenchView 唯一调用点），
      // 白名单收敛入口，扩角色时同步补表。
      const SPAWN_ROLES = new Set(['writer'])
      const rawRole = typeof body['role'] === 'string' ? (body['role'] as string) : 'writer'
      if (!SPAWN_ROLES.has(rawRole)) {
        return replyError(res, 400, 'BAD_INPUT', `未知角色 role=${rawRole}（可用：${[...SPAWN_ROLES].join('、')}）`)
      }
      const role = rawRole
      const prompt = typeof body['prompt'] === 'string' ? (body['prompt'] as string) : ''
      // P0-3：拒空 prompt——空包只有 system prompt，产出与本书无关；调用方应先拉 /draft-prompt
      if (!prompt.trim()) {
        return replyError(res, 400, 'BAD_INPUT', 'prompt 不能为空（请先拉取 /draft-prompt 组写稿上下文）')
      }
      if (prompt.length > 100_000) {
        return replyError(res, 400, 'BAD_INPUT', 'prompt 过长（上限 10 万字符）')
      }
      // Q-5（第十五轮）：GET /draft-prompt 回传的注入源清单——只作登记字符串（promptMeta.files）
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
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookName = params['name']!
    // 先停自愈编排 + 对话编排（幂等：未运行时为 no-op）
    abortSelfHeal(bookName)
    abortChat(bookName)
    // S5（五十九轮）：无运行直接返回成功 no-op——原实现无条件 ensureSession，对无会话
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
    if (!anyRunning) return reply(res, 200, { ok: true })
    const session = await ensureSession(bookName, ctx.workDir!)
    const driver = getDriver()
    if (driver.interrupt) driver.interrupt(session)
    reply(res, 200, { ok: true })
  },
  })

  // 全自动写章(红项自愈闭环):AI 写稿 → 机检 → 红则自动退回重写 → 全绿或触顶交作者。
  // fire-and-forget(与 /spawn 同风格):编排最长可跑十几分钟,进度全程经主 session SSE 回流。
  defineRoute('books.auto-write', {
    method: 'POST',
    path: '/api/books/:name/auto-write',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookName = params['name']!
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到用户数据目录')
    // 并发保护（防御双闸之一，Z-P2-5 起与 driver.isRunning 并存）：本闸是编排级内存锁，
    // 覆盖 self-heal 完整生命周期——机检/账本草稿等阶段无在途 LLM 请求，driver.isRunning
    // 仍为 false，只有本闸拦得住重复触发（两个编排器会互相覆写草稿）。生成期两闸重叠冗余，
    // 保留无害：登记受 /interrupt 注销影响存在时序窗口，内存闸始终是可靠口径。
    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章,先等它跑完或中断')
    }
    // AI-1（第七轮）：chat 在途（嵌套生成工具按章记账）时启动 self-heal 会互覆预算
    // 章块并掐断在途对话——与 /spawn 入口同款反向闸（M-1 的另一半）
    if (isChatRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书对话进行中，先等它结束或中断再自动写章')
    }
    // M-2（第八轮）：与手动写稿互斥——互斥矩阵此前缺的最后一角（/spawn 侧 dd-P2 注释
    // 自 c0b82be 起即失实地宣称此处已查 spawnRunning）。spawn 在途时启动 self-heal：
    // 双写手并发流式产出互覆草稿（saveDraft 与前端保存竞争），正是本闸要防的场景
    if (isSpawnRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在手动写稿，先等它跑完或中断再自动写章')
    }
    // R70-5（十八轮）：生成任务闸反向互斥——R67-13 只修了「写稿在途→拒收生成任务」
    // 方向；outline/lead-updates/onboard-ai/analyze 持闸（分钟级）期间启动 self-heal，
    // 其收尾覆盖写 细纲.md/账本推进.md，后续章拿到混合态上下文（双费 + 两端闭合误报
    // 红触发多余重写）。与删书/改名 busyGate 同口径。
    {
      const held = heldTaskGatesFor(bookName)
      if (held.length > 0) {
        return replyError(res, 409, 'BUSY', `本书有任务在跑（${held.join('、')}），先等它完成或中断再自动写章`)
      }
    }

    const body = await readJson(req)
    const chapter = Number(body['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) {
      return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')
    }
    // P2-3：批量连写——batchSize 1-20，有值则生成连续章号序列（中途红项触顶停当前章，不续后续）
    const rawBatch = body['batchSize']
    const batchSize = rawBatch === undefined ? 1 : Number(rawBatch)
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
      return replyError(res, 400, 'BAD_INPUT', 'batchSize 需为 1-20 的整数')
    }
    const chapters = batchSize > 1 ? Array.from({ length: batchSize }, (_, i) => chapter + i) : undefined

    // session.cwd = workDir(角色 agents 在 workDir/.claude/agents)
    const mainSession = await ensureSession(bookName, ctx.workDir!)
    // 二次检查（await 期间可能另一个请求已启动）——N4 TOCTOU 收窄；chat/spawn 闸同款补查
    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断')
    }
    if (isChatRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书对话进行中，先等它结束或中断再自动写章')
    }
    if (isSpawnRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在手动写稿，先等它跑完或中断再自动写章')
    }
    // R71-2（总七十一轮）：任务闸复检（对齐 /chat 的 R70-5 复检口径）——readJson +
    // ensureSession 两个 await 的窗口内新 acquire 的生成任务闸（分钟级）在此拦截，
    // 否则 self-heal 收尾覆盖写 细纲.md/账本推进.md 时与任务产出互踩
    {
      const held = heldTaskGatesFor(bookName)
      if (held.length > 0) {
        return replyError(res, 409, 'BUSY', `本书有任务在跑（${held.join('、')}），先等它完成或中断再自动写章`)
      }
    }
    const driver = getDriver()
    // Z-P2-5：self-heal 的 ctrl 登记 driver（与 /spawn 的 runWriterSpawn 同款接线）——
    // 生成期 isRunning() 真值（SSE sync 快照此前假空闲，前端可误触 /spawn 互相覆写草稿），
    // /interrupt 的 driver.interrupt() 也能直接 abort 在途请求（与 abortSelfHeal 双保险）。
    // X-P2-11：终态注销（finally）——防 done 后快照仍报「生成中」。
    let registered: AbortController | null = null
    void runSelfHeal({
      driver,
      mainSession,
      userDataPath: ctx.userDataPath!,
      cwd: ctx.workDir!,
      bookRoot: r.bookRoot,
      bookName,
      chapter,
      ...(chapters ? { chapters } : {}),
      register: (c) => {
        registered = c
        driver.registerCtrl?.(mainSession, c, 'self-heal')
      },
    })
      .catch((e) => emitSpawnError(driver, mainSession, e))
      .finally(() => {
        if (registered) driver.unregisterCtrl?.(mainSession, registered)
      })

    reply(res, 200, { ok: true, chapter, ...(batchSize > 1 ? { batchSize, chapters } : {}) })
  },
  })

  // 对话助手：fire-and-forget + SSE 回流（与 /spawn 同模式）
  // E2 示范：route schema 单点声明（defineRoute）——input 形状由 parse 声明，handler 拿类型化 input；
  // 校验失败统一 400 {error} 信封；新路由一律走 defineRoute，禁止加裸 route()。
  // 数据归属（E3 归类规则）：S2 事件子系统——会话写入经 events/store（chat-bridge 构造事件），本端点只触发编排。
  defineRoute('chat.send', {
    method: 'POST',
    path: '/api/books/:name/chat',
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      // R72-10（二十轮 D-5）：message 须为非空 string——原 String() 强转把数字/对象
      // 静默变串流入对话（掩盖调用方类型错误，与 documents 端点 typeof 口径不一致）
      const rawMessage = body['message']
      if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
        throw new Error('message 必填（须为非空字符串）')
      }
      const message = rawMessage.trim()
      if (message.length > 50_000) throw new Error('消息过长（上限 5 万字符）')
      // X-P2-12：chapter 非法值（如 "abc" → NaN）不放进 opts——下游 buildChatContext/工具
      // 会拿 NaN 找章，报错面目全非；入口即校验
      const rawChapter = body['chapter']
      const chapter = rawChapter === undefined || rawChapter === null ? undefined : Number(rawChapter)
      if (chapter !== undefined && (!Number.isInteger(chapter) || chapter < 1)) {
        throw new Error('chapter 需为正整数')
      }
      return { message, chapter }
    },
    handler: async ({ params, input }, _req, res) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const bookName = params['name']!
      if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到用户数据目录')
      // R-9（第十六轮）：chat 入口补 spawn/self-heal 反向互斥——互斥矩阵（AI-1/M-2）
      // 此前只补了 spawn/auto-write 侧的 isChatRunning 检查，chat 侧反向缺失：
      // 写手在途时发对话（含 rewrite/write_chapter 嵌套生成工具），两路 runTask 以不同
      // 章号交替记账互覆预算章块、写手互覆草稿。注：chat 自身 running 的 steer 入队
      // 语义只针对 chat 自己，与这两闸不冲突（sendChatMessage 内原子判定）。
      // R76-12（二十四轮 A 域）：对话嵌套写章豁免——chat 的 write_chapter 工具在途时
      // isSelfHealRunning 为真且 'rewrite' 任务闸被本会话工具持有，原样 409 会把作者
      // 的 steer 追加话拒之门外（写章是 chat 自己发起的，结束后续链正是 E1a 入队
      // 语义）。嵌套标记（isChatEmbeddedSelfHealRunning）时放行两闸，交 sendChatMessage
      // 原子判定入队；独立写稿（非嵌套）维持 409 不变。
      const chatEmbeddedWrite = isChatEmbeddedSelfHealRunning(bookName)
      if (isSelfHealRunning(bookName) && !chatEmbeddedWrite) {
        return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断再对话')
      }
      if (isSpawnRunning(bookName)) {
        return replyError(res, 409, 'BUSY', '本书正在手动写稿，先等它跑完或中断再对话')
      }
      // R70-5（十八轮）：生成任务闸反向互斥（同 /auto-write 口径，见彼处注释）；
      // R76-12：嵌套写章时豁免（held 的 'rewrite' 是本会话工具所持）
      if (!chatEmbeddedWrite) {
        const held = heldTaskGatesFor(bookName)
        if (held.length > 0) {
          return replyError(res, 409, 'BUSY', `本书有任务在跑（${held.join('、')}），先等它完成或中断再对话`)
        }
      }

      const mainSession = await ensureSession(bookName, ctx.workDir!)
      // R-9：ensureSession await 后二次检查（对齐 /auto-write 的 N4 TOCTOU 收窄口径；
      // R76-12 嵌套豁免同首检口径——嵌套标记可能在 await 期间才落下）
      const chatEmbeddedWrite2 = isChatEmbeddedSelfHealRunning(bookName)
      if (isSelfHealRunning(bookName) && !chatEmbeddedWrite2) {
        return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断再对话')
      }
      if (isSpawnRunning(bookName)) {
        return replyError(res, 409, 'BUSY', '本书正在手动写稿，先等它跑完或中断再对话')
      }
      // R70-5：复检（同首检口径；R76-12 嵌套豁免同上）
      if (!chatEmbeddedWrite2) {
        const held = heldTaskGatesFor(bookName)
        if (held.length > 0) {
          return replyError(res, 409, 'BUSY', `本书有任务在跑（${held.join('、')}），先等它完成或中断再对话`)
        }
      }
      // E1a（steer）：对话运行中不再 409 拒绝，改为入队（当前轮结束自动续链）。
      // 二次检查（await 期间可能另一个请求已启动）在 sendChatMessage 内原子完成——running 判定与入队同临界区。
      const driver = getDriver()
      const outcome = sendChatMessage({
        driver,
        mainSession,
        userDataPath: ctx.userDataPath!,
        bookRoot: r.bookRoot,
        bookName,
        message: input.message,
        ...(input.chapter !== undefined ? { chapter: input.chapter } : {}),
      })

      reply(res, 200, { ok: true, queued: outcome === 'queued' })
    },
  })

  // 工具确认：作者点了确认/取消
  defineRoute('books.chat.confirm', {
    method: 'POST',
    path: '/api/books/:name/chat/confirm',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
    const bookName = params['name']!
    // R27-64（二十七轮）：补 resolveBook——chat 族（send/regenerate）都有书存在性
    // 校验，唯本端点漏挂：书名打错/书已删时落到下方 404「未找到待确认的工具调用」，
    // 语义误导排障（书不存在 ≠ 调用不存在）
    const r = resolveBook(ctx.workDir, bookName)
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const body = await readJson(req)
    const callId = String(body['callId'] ?? '')
    // R26-60（二十六轮）：确认旗标严格判定——原 Boolean() 强转把字符串 'false' / 0 以外
    // 的任意真值（如 'false'、'0'）都判成作者确认，前端序列化偏差即误放行工具调用
    const ok = body['ok'] === true
    if (!callId) return replyError(res, 400, 'BAD_INPUT', 'callId 必填')

    const found = resolveChatConfirm(bookName, callId, ok)
    if (!found) return replyError(res, 404, 'NOT_FOUND', '未找到待确认的工具调用（已超时或已取消）')
    reply(res, 200, { ok: true })
  },
  })

  // F1-P4：重新生成上一条回复——parentSeq = 触发 user 的全局 seq，branchId = 变体组
  defineRoute('books.chat.regenerate', {
    method: 'POST',
    path: '/api/books/:name/chat/regenerate',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookName = params['name']!
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到用户数据目录')
    // R-9（第十六轮）：regenerate 同款 spawn/self-heal 反向互斥（与 chat.send 口径一致）
    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断再对话')
    }
    if (isSpawnRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在手动写稿，先等它跑完或中断再对话')
    }
    // R70-5（十八轮）：生成任务闸反向互斥（同 chat.send 口径，见彼处注释）
    {
      const held = heldTaskGatesFor(bookName)
      if (held.length > 0) {
        return replyError(res, 409, 'BUSY', `本书有任务在跑（${held.join('、')}），先等它完成或中断再对话`)
      }
    }
    const body = await readJson(req)
    const rawParentSeq = Number(body['parentSeq'])
    if (!Number.isInteger(rawParentSeq) || rawParentSeq < 1) return replyError(res, 400, 'BAD_INPUT', 'parentSeq 需为正整数')
    const branchId = String(body['branchId'] ?? '').trim()
    if (!branchId) return replyError(res, 400, 'BAD_INPUT', 'branchId 必填')
    const rawChapter = body['chapter']
    const chapter = rawChapter === undefined || rawChapter === null ? undefined : Number(rawChapter)
    if (chapter !== undefined && (!Number.isInteger(chapter) || chapter < 1)) return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')

    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断再对话')
    }
    if (isSpawnRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在手动写稿，先等它跑完或中断再对话')
    }
    const mainSession = await ensureSession(bookName, ctx.workDir!)
    // Z-3（第五十八轮）：二次检查移到 ensureSession 之后（与 chat.send 完全同序）——
    // 此前排在 await 之前（注释却宣称「await 后二次检查」），让出窗口内他标签页 /spawn
    // 占闸启动写手，regenerate 续体无复查直接 sendChatMessage（内含嵌套生成工具）→
    // 双写手互覆草稿/预算章块（R-9 互斥矩阵要防的场景）
    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断再对话')
    }
    if (isSpawnRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在手动写稿，先等它跑完或中断再对话')
    }
    // R70-5（十八轮）：复检（同 chat.send 口径）
    {
      const held = heldTaskGatesFor(bookName)
      if (held.length > 0) {
        return replyError(res, 409, 'BUSY', `本书有任务在跑（${held.join('、')}），先等它完成或中断再对话`)
      }
    }
    const driver = getDriver()
    const outcome = sendChatMessage({
      driver,
      mainSession,
      userDataPath: ctx.userDataPath!,
      bookRoot: r.bookRoot,
      bookName,
      regenerate: { parentSeq: rawParentSeq, branchId },
      ...(chapter !== undefined ? { chapter } : {}),
    })
    reply(res, 200, { ok: true, queued: outcome === 'queued' })
  },
  })

  // 清空本书对话历史（前端"清空对话"时调）
  defineRoute('books.chat.clear', {
    method: 'POST',
    path: '/api/books/:name/chat/clear',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
    const bookName = params['name']!
    if (isChatRunning(bookName)) return replyError(res, 409, 'BUSY', '对话进行中，请先停止再清空')
    // M-2（第六轮）：clearChatHistory 与 audit DELETE 同为双键清理（bookName + bookHash
    // 工作流会话），audit 侧五闸（dd-P3/hh-P1/第五轮）已收口，此处此前只配两道——
    // spawn 手动写稿 / self-heal 批量写稿 / task-gate 分钟级任务在途时清空同样清不彻底，
    // 且任务收尾的 step/llm-call 事件追加到已被删 session 的行上成孤儿。对齐补三闸。
    const held = heldTaskGatesFor(bookName)
    if (held.length > 0) {
      return replyError(res, 409, 'BUSY', `本书有任务在跑（${held.join('、')}），先等它完成后再清空对话`)
    }
    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在自动写稿，先等它完成或中断后再清空对话')
    }
    if (isSpawnRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在生成（手动写稿），先等它完成或中断后再清空对话')
    }
    // 第九轮 M-1（对齐 audit DELETE 五闸收口）：三审在途时经 runSpec 向工作流会话追加
    // llm-call 事件——在途清空同样清不彻底，补同口径闸
    if (isReviewRunningForBook(bookName)) {
      return replyError(res, 409, 'BUSY', '本书三审进行中，先等它完成后再清空对话')
    }
    // 第五轮：fire-and-forget 后台任务（定稿摘要等）持 workspace 会话续写事件——
    // clearChatHistory 双键同清工作流侧，在途清空同样清不彻底，补同口径闸
    if (hasBackgroundTasks(bookName)) {
      return replyError(res, 409, 'BUSY', '本书有后台任务收尾中（如定稿摘要），稍等片刻再清空对话')
    }
    // 二轮复审（低级）：resolveBook 统一解析——旧 readBooks().find() 对不存在的书
    // 静默落「只清内存」假成功（200），事件库原样残留；现与全文件其余路由同 404 口径
    const r = resolveBook(ctx.workDir, bookName)
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    // F1-P1：清内存 + 清事件库
    clearChatHistory(bookName, ctx.userDataPath ?? undefined, r.bookRoot)
    // R-18（第十六轮）：清空对话 = 本书对话上下文整体销毁 → per-book SSE 计数一并清理
    forgetSseCount(bookName)
    reply(res, 200, { ok: true })
  },
  })
}
