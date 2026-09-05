/**
 * Y-P2-5 对话历史只读端点：事件库投影 → 前端可渲染的消息列表。
 *
 * GET /api/books/:name/chat/history?branch=<branchId> →
 *   { messages: [{ role, content }], seqs: number[][], branchId: string | null }
 *
 * - 与服务端 runChat 恢复路径同源（loadHistoryWithSeqs）：未遮蔽 surface 节点
 *   投影 + 连续 tool-result 合成一条 user(tool_result blocks)，刷新后前端可重建对话；
 * - G1 分支支撑：视图先过 selectBranch 再投影（?branch= 切换；缺省 = 默认分支 =
 *   最新变体组 + 祖先链），修复重新生成后全量视图把各变体顺序堆叠的问题；
 *   线性书（无分支元数据）selectBranch 原样全量返回，行为不变；
 * - seqs 与 messages 平行（tool-result 合成消息是多 seq 数组），供分支 UI 定位锚点；
 * - userData 为空（无事件库）→ 返回空 messages，不报错；
 * - 纯只读（重放纯函数），不产生副作用。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError, parseRequestUrl } from '../http.js'
import { resolveBook } from '../book-context.js'
import { openSessionStoreAsync, type SessionStore } from '../../../events/store.js'
import { loadHistoryWithSeqs } from '../../../events/chat-bridge.js'
import { buildBranchTree, defaultBranchId, selectBranch } from '../../../events/branch-tree.js'

interface ChatHistoryCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 历史消息 content block（前端友好 JSON，与 src/ai/provider/types.ts ContentBlock 同构） */
export type ChatHistoryBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

/** 历史消息（user 纯文本 / assistant 文本+工具往返） */
export interface ChatHistoryMessage {
  role: 'user' | 'assistant'
  content: string | ChatHistoryBlock[]
}

/** 历史视图（纯函数——route 薄接线 + 单测直喂 store）。
 *  L-S2（第八轮）：可选 limit 尾窗——长书几万事件全量投影一次进 HTTP 响应（与 audit
 *  修 SV-2 前同病）。前端 messages 只做展示种子（模型上下文由服务端 restore 从事件库
 *  重建，不经此端点），尾部窗口即可；truncated 标记 + total 供前端提示。
 *
 *  PM-10（2026-09-05 性能与内存专项）核查：审查项记的「JSONL 事件日志 readFileSync
 *  全量读 + split + 逐行 JSON.parse 后才 slice(-limit) 截尾」是 F1 SQLite 化之前的旧
 *  形态——事件库现为 node:sqlite 每书一库，listEvents 走 SQL 游标流式 iterate + 逐行
 *  坏行降级（store.ts 内存闸 B1 / R65-20），statSync/末尾 64KB 窗/半行丢弃式字节尾读
 *  已无附着对象。带 limit 请求维持全量投影是响应契约的语义必需：total = 全量投影消息
 *  数、truncated = 截断标记，两者依赖全量事件的遮蔽/空壳跳过/连续 tool-result 合成语义
 *  （foldSurface），无法从尾部窗口便宜得出；且截尾只能发生在消息合成之后（事件级尾窗
 *  会把合成消息的 tool_result blocks 拆破）。真尾窗（seq 降序取尾 + 窗口翻倍前扩、不足
 *  退化全量）须 store 层先提供尾取 + 全量骨架计数通道，属后续独立改造，不在本函数内
 *  以复刻投影口径的方式实现（投影语义必须单源）。逐位等价性由
 *  test/ai/pm10-chat-history-tail.test.ts 以内嵌全量参照钉住。 */
export function buildChatHistoryView(
  store: SessionStore,
  bookName: string,
  branchId?: string,
  limit?: number,
): { messages: ChatHistoryMessage[]; seqs: number[][]; branchId: string | null; truncated: boolean; total: number } {
  // PM-10（2026-09-05）核查：全量取数非「JSONL 全量读」残留——listEvents 已是流式游标；
  // 全量是 total/truncated 契约与分支树定位（defaultBranchId 需全量组结构）的语义必需
  const all = store.listEvents(bookName)
  // 实际采用的分支 id：给定 branchId ?? 默认分支；无分支元数据（线性书/空库）→ null
  const active = branchId ?? defaultBranchId(buildBranchTree(all))
  // 先过分支筛选再投影：?branch= 指定组 + 祖先链；缺省 = 默认分支（最新变体组）；
  // 线性书无分支元数据 → selectBranch 原样全量返回（旧书不丢消息）
  const events = selectBranch(all, branchId)
  // loadHistoryWithSeqs 已做遮蔽过滤 + 连续 tool-result 合成，输出即前端消息形状；
  // seqsPerMsg 与 msgs 平行透出（合成消息是多 seq 数组，分支 UI 锚点用）
  const { msgs, seqsPerMsg } = loadHistoryWithSeqs(events)
  if (limit === undefined || !Number.isFinite(limit) || limit < 1 || msgs.length <= limit) {
    return { messages: msgs, seqs: seqsPerMsg, branchId: active, truncated: false, total: msgs.length }
  }
  // PM-10：截尾收口在消息合成之后——slice 作用于合成完的 msgs（连续 tool-result 已合成
  // 一条 user，blocks 不可拆），事件级截尾会拆破合成消息；与「全量投影 + slice」参照的
  // 逐位一致性（含恰 limit/不足 limit/坏行/分支视图边界）由 test/ai/pm10-chat-history-tail.test.ts 守护
  return {
    messages: msgs.slice(-limit),
    seqs: seqsPerMsg.slice(-limit),
    branchId: active,
    truncated: true,
    total: msgs.length,
  }
}

export function registerChatHistoryRoutes(ctx: ChatHistoryCtx): void {
  // E2 增量纪律（y 轮批 0 拍板）：新路由一律 defineRoute（存量裸 route 为 RC 后债务）；
  // GET 无 body，parse 省略（input 恒 undefined）
  defineRoute('chat.history', {
    method: 'GET',
    path: '/api/books/:name/chat/history',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const bookName = params['name']!
      const bookRoot = r.bookRoot
      // userData 为空（无事件库）→ 空 messages，不报错（对话区留白可正常发起新对话）
      if (!ctx.userDataPath) return reply(res, 200, { messages: [], seqs: [], branchId: null })

      // GET query 自行解析（defineRoute 纪律：GET 无 body）；?branch= 缺省/空白 → 默认分支
      // R-19（第十六轮）：parseRequestUrl 统一解析（Q-1/N-3 口径）——畸形 URL → 400 BAD_INPUT
      const url = parseRequestUrl(req)
      if (!url) return replyError(res, 400, 'BAD_INPUT', 'bad request')
      const branch = url.searchParams.get('branch')?.trim() || undefined
      // L-S2（第八轮）：?limit= 尾窗（正整数，上限 1000）——防长书全量投影出网
      const rawLimit = Number(url.searchParams.get('limit'))
      const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 1000) : undefined
      // userDataPath 非空已确认 → store 必建库（openSessionStoreAsync 非惰性）
      // R62-43：userDataPath 空返回 null（上方已分流）；极端下仍可能 null → 显式错误
      // 信封（不再 ! 断言，此前静默 TypeError 崩路由）
      // IR-8（独立重评 2026-09-02）勘误：库损坏/权限等首开失败是**抛错**不是返回 null
      //（原注释失实，裸抛落 defineRoute 兜底 500 泛化文案）→ 显式收编结构化 500，
      // e.message 人话透传（含 IR-2 损坏分类的可行动指引；经统一脱敏出口）
      // R34D-19（三十四轮）：开库走异步孪生（首开锁等待不阻塞服务事件循环）
      let store: SessionStore | null
      try {
        store = await openSessionStoreAsync(ctx.userDataPath, bookRoot)
      } catch (e) {
        return replyError(
          res,
          500,
          'STORE_UNAVAILABLE',
          `事件库不可用（无法打开会话存储）：${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (!store) return replyError(res, 500, 'STORE_UNAVAILABLE', '事件库不可用（无法打开会话存储）')
      try {
        reply(res, 200, buildChatHistoryView(store, bookName, branch, limit))
      } finally {
        store.close()
      }
    },
  })
}
