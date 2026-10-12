/**
 * 写稿起跑与中断一族——stream.ts 的 /spawn（books.spawn）三件（gate/parse/handler）与
 * /interrupt（books.interrupt）handler 体下沉档，外加 fire-and-forget 写稿编排 runWriterSpawn
 * （原 stream.ts 顶层导出）与自愈/spawn 共用的错误兜底 emitSpawnError。
 *
 * 为什么在独立档：runWriterSpawn 是「编排体」（runSpec 统一编排 + SSE 回流 + watchdog 兜底），
 * 与 stream.ts 残核的路由声明面分离后，路由函数只剩 method/path/gate/parse 声明与一行转调。
 *
 * 行为不变量（纯下沉，逐字等价）：
 * - /spawn 执行序：找书 404/工目录 → 五道忙闸 409 → holdSpawnGate 同步占位 → 之后才读 body
 *   （gate 位）→ body 形状 400（parse 位）→ handler 起跑并置 launched；占位释放由 defineRoute
 *   的闸 cleanup（未起跑路径）与 handler 侧 finally（已起跑）分别承担，两边互补的现状不变。
 * - runWriterSpawn：mock 快路事件序列、text 增量回流、ctrl 登记/注销唯一落点、max_tokens
 *   警告、计价取请求时刻模型快照、失败走 redactSecret 脱敏——逐位不变；watchdog 的
 *   一段/二段处置与进度复位点（emit 闭包 + ctrl 登记点）不变。
 * - /interrupt：先 abort 自愈与对话编排 → 无在途直接 no-op（不 ensureSession，不推假事件）
 *   → ensureSession 后复检才下达中断；interrupted 字段如实回报判定结果。
 *
 * 依赖方向单向（无环）：本文件 → http / book-context / log / driver 契约 / ai（spec 运行、
 * 计费、spawn 闸、自愈与对话编排态）/ 同目录 stream-watchdog（挂死兜底）；stream.ts 单向
 * import 本文件（本文件对 stream.ts 只有 type 面回引 StreamCtx，编译期擦除）。
 */
import type { ServerResponse } from 'node:http'
import { reply, replyError } from '../http.js'
import { errMsg } from '../../../log/index.js'
import { resolveBookOrReply } from '../book-context.js'
import type { DriverEvent, Session, StudioDriver } from '../../../driver/index.js'
// watchdog 二段强释放用生产命名导出 forceReleaseSelfHealRunning 同族：本档的 spawn 闸
// 强释放直接走 spawn-registry 的生产导出 releaseSpawnGate（测试专用 API 不进生产路径）
import { abortSelfHeal, isSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { isChatRunning, abortChat } from '../../../ai/orchestrate/chat.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { streamSpec } from '../../../ai/tasks/specs.js'
import { readKind } from '../book-context.js'
import { redactSecret } from '../../../ai/provider/redact.js' // API 错误脱敏——SDK 报错 message 可能含 API Key 痕迹
import { resolveModelPricing, computeCallCost } from '../../../ai/pricing.js'
import { holdSpawnGate, releaseSpawnGate, isSpawnRunning } from '../../../ai/orchestrate/spawn-registry.js'
import { startStallWatchdog } from './stream-watchdog.js'
import type { StreamCtx } from './stream.js'

/** spawn 闸前置产出：bookRoot 供 runWriterSpawn 用，launched 由 handler 起跑后置真
 *  ——false 时 cleanup 释放占位（闸后段任一失败路径：读体/校验 400、ensureSession 抛错等）。 */
export interface SpawnGateState {
  bookRoot: string
  launched: boolean
}

/**
 * fire-and-forget 写稿：产物经 runTask 统一编排（mock/provider/中断/错误文案），
 * text 增量经 driver.emit 推 SSE。
 * ctrl 经 registerCtrl 交给 driver——interrupt 可 abort 真实请求，isRunning 判在途。
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
  /** mock 快路（组装根按 driver.kind 定的选择结果）——本函数不再读环境变量 */
  mock?: boolean
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
    // 推 interrupted。（driver 契约必需化）：interrupt 为 StudioDriver 必需
    // 成员（mock 显式 no-op 桩），可选性分支与保底 abort 删除，直调语义逐位不变。
    abortLikeUser: () => {
      opts.driver.interrupt(opts.mainSession)
    },
    // 二段：强释放——只放闸，不在此注销 ctrl：注销唯一落点在底层 run settle（本函数终态
    // finally）。在此注销则一段 abort 未触达底层 runTask 时（ctrl 尚未登记，或请求无视中止
    // 信号）ctrl 一经注销 isRunning 即假空闲，后续 /interrupt 对该在途请求永久失联；保留注册
    // 至 settle，/interrupt 仍可经 driver.isRunning 命中并 abort；同 owner 的新登记亦会
    // abort 旧 ctrl 防僵尸。
    forceRelease: () => {
      releaseSpawnGate(opts.bookName)
      opts.driver.emit(opts.mainSession, {
        type: 'warning',
        message:
          '手动写稿长时间无进展，疑似挂起，并发闸已被服务端强制释放（底层任务未中断，迟到结果按既有迟到覆盖口径处理）',
      })
    },
  })
  // 登记的 ctrl 在终态注销——isRunning 归 false（否则 done 后仍登记，SSE 快照假报「生成中」）
  let registeredCtrl: AbortController | null = null
  const emit = (ev: DriverEvent): void => {
    wd.touch() // 进度复位（text 增量/usage/done 等一切事件单点经此）
    opts.driver.emit(opts.mainSession, ev)
  }

  // 通知前端：生成开始（前端清空旧正文 + 设 running=true）
  emit({ type: 'role_spawn', role: opts.role, parentToolUseId: `tu-${Date.now()}` })

  // mock 快路：emit 模拟事件序列（runTask 的 mockText 只返回值、不透出事件流，故 mock 独立处理）
  if (opts.mock === true) {
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
        opts.driver.registerCtrl(opts.mainSession, ctrl, 'spawn')
      },
      onReset: () => emit({ type: 'text_reset' }),
      onText: (delta) => emit({ type: 'text', text: delta, role: opts.role }),
      // spawn 链补接 onRetry——不接则重试对前端不可见（self-heal/chat/finish 均已接）；
      // 同款 warning 事件（对齐 self-heal.ts 文案与脱敏口径）
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
      const cost =
        out.usage && pricing
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
    // 注销，强释放到 settle 之间 ctrl 留册，/interrupt 对在途请求不失联
    if (registeredCtrl) opts.driver.unregisterCtrl(opts.mainSession, registeredCtrl)
  }
}

/** fire-and-forget 兜底：编排器 try 外同步异常推 SSE error（防 unhandled rejection 崩进程致全部 SSE 断连） */
export function emitSpawnError(driver: StudioDriver, session: Session, e: unknown): void {
  driver.emit(session, {
    type: 'error',
    kind: 'provider',
    // API 错误脱敏——SDK 报错 message 可能含 API Key 痕迹
    message: redactSecret(errMsg(e)),
    recoverable: false,
  })
}

/** /spawn 前置闸——找书 404（resolveBook 成功 = workDir 非空，null 已在其 error 分支
 *  NO_WORKDIR 覆盖）→ 五道忙闸 409 → holdSpawnGate 同步占位；产出的 launched 由 handler
 *  起跑后置真，cleanup 据其决定是否释放占位（未起跑路径统一释放）。 */
export function spawnGate(
  ctx: StreamCtx,
  params: Record<string, string>,
  res: ServerResponse,
): false | { value: SpawnGateState; cleanup: () => void } {
  // resolveBook 成功 = workDir 非空（null 已在其 error 分支 NO_WORKDIR 覆盖）——
  // 本文件后续 ctx.workDir! 断言据此成立（ensureSession 的 session.cwd 用 workDir 而非 bookRoot）
  const r = resolveBookOrReply(ctx.workDir, params['name'], res)
  if (!r) return false

  // 忙闸：单调 busyReason('spawn') 覆盖五面（前为五段手写 check）——自身 spawn 闸
  //（同步占位，无 TOCTOU；未实际启动的路径 finally 释放）→ self-heal 全自动写章
  //（双向均已设闸：self-heal 运行中仍接受 /spawn = 两个写手并发流式产出、落盘互相覆写草稿）
  // → 对话编排（chat 在途含 rewrite/write_chapter 等嵌套生成工具，两路 runTask 以不同章号
  // 交替记账互覆预算章块）→ 生成任务闸反向互斥（outline/lead-updates/onboard-ai/analyze
  // 等分钟级任务在途时写手草稿与任务收尾的覆盖写互踩；含跨进程锁文件面）→ 三审运行闸
  //（三审分钟级在途时 /spawn 覆写正文，审稿单的 draft_hash 守卫必然失配）。
  // 判定顺序与文案单源见 task-gate.ts 的 BUSY_MATRIX 'spawn' 行。
  const bookName = params['name']!
  const busy = ctx.gate.busyReason(bookName, 'spawn')
  if (busy) {
    replyError(res, 409, 'BUSY', busy)
    return false
  }
  // 占位在 parse 读体前同步完成（防线时序）：五道 409 闸与占位都先于 body 在途窗口，
  // 客户端发完 headers 悬持 body 时同书第二次 /spawn 也拿 409 而非排队进 handler。
  holdSpawnGate(bookName)
  // launched 由 handler 在真正起跑（runWriterSpawn 已接盘）后置真——false 时 cleanup
  // 释放占位（闸后段任一失败路径：读体/校验 400、ensureSession 抛错等）
  const gateState: SpawnGateState = { bookRoot: r.bookRoot, launched: false }
  return {
    value: gateState,
    cleanup: () => {
      if (!gateState.launched) releaseSpawnGate(bookName)
    },
  }
}

/** /spawn body 形状（role 白名单 + prompt 非空/长度 + 注入源清单轻校验）。 */
export function parseSpawnInput(raw: unknown): { role: string; prompt: string; promptFiles: string[] } {
  const body = (raw ?? {}) as Record<string, unknown>
  // role 白名单——不校验则任意字符串直进 streamSpec（未知 role
  // 静默落 error 事件路径）；客户端仅用 'writer'（WorkbenchView 唯一调用点），
  // 白名单收敛入口，扩角色时同步补表。
  const SPAWN_ROLES = new Set(['writer'])
  const rawRole = typeof body['role'] === 'string' ? body['role'] : 'writer'
  if (!SPAWN_ROLES.has(rawRole)) {
    throw new Error(`未知角色 role=${rawRole}（可用：${[...SPAWN_ROLES].join('、')}）`)
  }
  const prompt = typeof body['prompt'] === 'string' ? body['prompt'] : ''
  // 拒空 prompt——空包只有 system prompt，产出与本书无关；调用方应先拉 /draft-prompt
  if (!prompt.trim()) throw new Error('prompt 不能为空（请先拉取 /draft-prompt 组写稿上下文）')
  if (prompt.length > 100_000) throw new Error('prompt 过长（上限 10 万字符）')
  // GET /draft-prompt 回传的注入源清单——只作登记字符串（promptMeta.files）
  // 不再读盘，服务端仍轻校验形状（串数组、条数/长度封顶）防事件库被灌垃圾
  const promptFiles = Array.isArray(body['files'])
    ? (body['files'] as unknown[])
        .filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= 200)
        .slice(0, 64)
    : []
  return { role: rawRole, prompt, promptFiles }
}

/** /spawn handler——起跑标记置真（释放责任移交 runWriterSpawn 链的 finally），
 *  fire-and-forget 起跑并即时回 200。 */
export async function handleBookSpawn(
  ctx: StreamCtx,
  routeCtx: {
    params: Record<string, string>
    input: { role: string; prompt: string; promptFiles: string[] }
    gate: SpawnGateState
  },
  res: ServerResponse,
): Promise<void> {
  const { params, input, gate } = routeCtx
  const bookName = params['name']!
  const mainSession = await ctx.driver.ensureSession(bookName, ctx.workDir!)
  const driver = ctx.driver.driver
  // 起跑标记：闸 cleanup 据此不再释放（释放责任移交下方 finally——终态含失败/中断）
  gate.launched = true
  // fire-and-forget：generateText 期间 text 增量经 driver.emit → SSE 回流；
  // 终态（含失败/中断）释放并发闸
  void runWriterSpawn({
    driver,
    mainSession,
    bookName,
    userDataPath: ctx.userDataPath,
    bookRoot: gate.bookRoot,
    prompt: input.prompt,
    role: input.role,
    promptFiles: input.promptFiles,
    mock: ctx.driver.kind === 'mock',
  })
    .catch((e) => emitSpawnError(driver, mainSession, e))
    .finally(() => releaseSpawnGate(bookName))

  reply(res, 200, { ok: true, role: input.role })
}

/** /interrupt handler——停自愈/对话编排 + 有在途才下达中断（含 await 后复检）。 */
export async function handleBookInterrupt(
  ctx: StreamCtx,
  routeCtx: { params: Record<string, string> },
  res: ServerResponse,
): Promise<void> {
  const { params } = routeCtx
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
  const driver0 = ctx.driver.driver
  const session0 = ctx.driver.getSession(bookName)
  const anyRunning =
    isSelfHealRunning(bookName) ||
    isChatRunning(bookName) ||
    isSpawnRunning(bookName) ||
    // isRunning 为必需成员（mock 显式 false 桩）——与下方复检同口径，不写可选链
    (session0 !== null && driver0.isRunning(session0))
  // 返回值如实附 interrupted——true = 在途任务确被下达中断动作；false =
  // 判定时刻本就无在途（含已注册 ctrl 的 outline/review/analysis 等端点——其
  // ctrl 经 driver.isRunning 判真走真实中断路径），不做无差别 {ok:true} 假成功。
  if (!anyRunning) return reply(res, 200, { ok: true, interrupted: false })
  const session = await ctx.driver.ensureSession(bookName, ctx.workDir!)
  const driver = ctx.driver.driver
  // await 后复检——anyRunning 判定与 ensureSession await 之间任务可能
  // 自然收尾，不复查就 interrupt 会向零消费者 push 假 interrupted 事件（重连客户端错认
  // 刚被中断）。复检仍真值才下达中断；driver.isRunning 对已注册 ctrl 的任务同样
  // 生效（cc.isRunning 覆盖全部 owner 槽位的在册 ctrl）。
  const stillRunning =
    isSelfHealRunning(bookName) ||
    isChatRunning(bookName) ||
    isSpawnRunning(bookName) ||
    // （driver 契约必需化）：isRunning 为必需成员（mock 显式 false 桩），
    // 可选链 + ?? false 冗余删除
    driver.isRunning(session)
  if (stillRunning) driver.interrupt(session)
  reply(res, 200, { ok: true, interrupted: stillRunning })
}
