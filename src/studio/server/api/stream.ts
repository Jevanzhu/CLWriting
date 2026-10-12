/**
 * SSE 端点：GUI 订阅事件流 + 触发生成（路由声明面）。
 *
 * GET  /api/books/:name/stream     → SSE（订阅 driver.stream，持续推送 DriverEvent）
 * HEAD /api/books/:name/stream     → 名额探测（不建流）
 * POST /api/books/:name/spawn      → 触发写稿（generateText + writerSystem，fire-and-forget + SSE 回流）
 * POST /api/books/:name/interrupt  → 中断生成 + 停自愈编排
 * POST /api/books/:name/auto-write → 全自动写章（写稿→机检→红则重写闭环，body {chapter}）
 *
 * SSE / interrupt / auto-write 经 driver session；/spawn 走 gen.ts generateText + provider 直连。
 * 本文件只留 method/path/gate/parse 声明与一行转调：建流/探测体在 stream-sse-connect.ts，
 * /spawn 与 /interrupt 体（含 runWriterSpawn 编排）在 stream-run-writer.ts，
 * /auto-write 体在 stream-auto-write.ts——三档均不 import 本文件（仅 type 面回引 StreamCtx），
 * 模块图无环；既有外部消费名（isSpawnRunning / __setSpawnRunning / runWriterSpawn /
 * SSE_STREAM_PATH_PATTERN / closeAllSseConnections / forgetSseCount / __getSseConnections /
 * createSseWriter / ORCH_STALL_* 常量）经下方桥逐名再导出，消费方 import 面零改动。
 */
import { defineRoute } from './schema.js'
import type { TaskGateInjected } from './task-gate.js' // 闸实例经组装根注入
import type { DriverHost } from '../driver-port.js' // driver 经组装根注入
import type { StreamTicketStore } from './stream-ticket.js'
// chat 工具侧闸端口的注册端与真实闸本体（见 registerStreamRoutes 头部注）
import { registerTaskGateProvider } from '../../../ai/orchestrate/task-gate-port.js'
// spawn 闸正本在 ai 层（turns.ts 的嵌套生成工具闸要查它，ai 层不得反向 import server
// 路由层）；此处再导出保持 books/audit/测试的导入面不变
import { isSpawnRunning } from '../../../ai/orchestrate/spawn-registry.js'
import { handleBookStream, handleBookStreamProbe } from './stream-sse-connect.js'
import { handleBookAutoWrite, autoWriteGate, parseAutoWriteInput } from './stream-auto-write.js'
import { handleBookInterrupt, handleBookSpawn, parseSpawnInput, spawnGate } from './stream-run-writer.js'

export { isSpawnRunning }
// 测试夹具观测面：__setSpawnRunning 经本文件再导出（既有测试 import 面不变；
// 生产路径不用它——强释放走 spawn-registry 的 releaseSpawnGate）
export { __setSpawnRunning } from '../../../ai/orchestrate/spawn-registry.js'
export { runWriterSpawn, emitSpawnError } from './stream-run-writer.js'

// 桥：拆出族的既有外部消费名逐名再导出——books.ts / chat.ts 的 forgetSseCount，
// index.ts 的 closeAllSseConnections，sse-count-cleanup 测试的
// __getSseConnections，sse-backpressure 测试的 createSseWriter，
// write-stall-watchdog 测试的 ORCH_STALL_WATCHDOG_MS / ORCH_STALL_GRACE_MS——消费方
// import 面零改动
export { forgetSseCount, closeAllSseConnections, __getSseConnections, createSseWriter } from './stream-sse-writer.js'
export { ORCH_STALL_WATCHDOG_MS, ORCH_STALL_GRACE_MS } from './stream-watchdog.js'

export interface StreamCtx extends TaskGateInjected {
  /** driver 宿主（会话面 + 能力面 + mock 选择结果）——组装根注入 */
  driver: DriverHost
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
 * SSE 端点路径模式单源声明——index.ts 的 GET token 豁免表
 * （GET_TOKEN_EXEMPT_PATHS）引用本常量。模式与被豁免端点（自带 ticket/?token=/x-studio-token
 * 三凭据闸，见该 handler）同居一文件：路由路径若改，豁免表跟着改，只动一处（此前两处各写
 * 等价正则会静默失闸或漏豁免）。:name 为单路径段（[^/]+），与 router.ts:param 捕获口径一致。
 */
export const SSE_STREAM_PATH_PATTERN = /^\/api\/books\/[^/]+\/stream$/

export function registerStreamRoutes(ctx: StreamCtx): void {
  // ai→studio 反向依赖收口的注册端——chat 工具侧
  //（turns.ts）经 ai/orchestrate/task-gate-port 端口取闸，真实闸在服务构造时注入。
  // 幂等（重注册覆盖）；未注册形态仅存在于纯 ai 层单测（端口放行，见端口头注）。
  registerTaskGateProvider((book, action) => ctx.gate.acquire(book, action))

  // SSE 订阅 driver 事件流（建流体见 stream-sse-connect.ts）
  defineRoute('books.stream', {
    method: 'GET',
    path: '/api/books/:name/stream',
    handler: (routeCtx, req, res) => handleBookStream(ctx, routeCtx, req, res),
  })

  // 不建流的 SSE 名额探测端点（HEAD，与 GET 同路径）——闸口径与建流逐条同源、
  // 只判定不登记（不变量清单见 stream-sse-connect.ts 的 handleBookStreamProbe 头注）
  defineRoute('books.stream.probe', {
    method: 'HEAD',
    path: '/api/books/:name/stream',
    handler: (routeCtx, req, res) => handleBookStreamProbe(ctx, routeCtx, req, res),
  })

  // 触发写稿：generateText + writerSystem，fire-and-forget + SSE 回流
  // 本端点原「不走 defineRoute parse：校验顺序依赖前置门」——现前置门
  //（找书 404 → 五道忙闸 409 → holdSpawnGate 同步占位 → 之后才读 body）落 gate 前置闸，
  // body 形状与 role/prompt 校验落 parse：执行序逐位不变（gate 先于 readJson），而占位
  // 的写稿闸改由 defineRoute 的闸 cleanup 释放（覆盖 parse 失败 / handler 早退两条原
  // 手工标记路径，取代 handler 内 try/finally 的 launched 双写）。
  defineRoute('books.spawn', {
    method: 'POST',
    path: '/api/books/:name/spawn',
    gate: ({ params, res }) => spawnGate(ctx, params, res),
    parse: (raw) => parseSpawnInput(raw),
    handler: (routeCtx, _req, res) => handleBookSpawn(ctx, routeCtx, res),
  })

  // 中断当前生成：AbortController.abort + 推 interrupted，session 保留可再 spawn
  defineRoute('books.interrupt', {
    method: 'POST',
    path: '/api/books/:name/interrupt',
    handler: (routeCtx, _req, res) => handleBookInterrupt(ctx, routeCtx, res),
  })

  // 全自动写章(红项自愈闭环):AI 写稿 → 机检 → 红则自动退回重写 → 全绿或触顶交作者。
  // fire-and-forget(与 /spawn 同风格):编排最长可跑十几分钟,进度全程经主 session SSE 回流。
  // 原「不走 defineRoute parse：校验顺序依赖前置门」的第二个绕开点——现
  // 前置门（找书 404 → 工目录 400 → 忙闸首查 409）落 gate、chapter/batchSize 校验落 parse，
  // 首检仍先于 chapter 校验（钉的「跨进程闸在持 + 空 body
  // → 409 非 400」逐位保持；parse 失败即 400，handler 不再吃非法 chapter）。
  defineRoute('books.auto-write', {
    method: 'POST',
    path: '/api/books/:name/auto-write',
    gate: ({ params, res }) => autoWriteGate(ctx, params, res),
    parse: (raw) => parseAutoWriteInput(raw),
    handler: (routeCtx, _req, res) => handleBookAutoWrite(ctx, routeCtx, res),
  })
}
