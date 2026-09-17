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
import { resolveBookOrReply } from '../book-context.js'
import { openSessionStoreAsync, type SessionStore } from '../../../events/store.js'
import { loadHistoryWithSeqs } from '../../../events/chat-bridge.js'
import { buildBranchTree, defaultBranchId, selectBranch } from '../../../events/branch-tree.js'
import { errMsg } from '../../../log/index.js' // errMsg 收编（复审-0914-优化修复批）：错误文案三目单源

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
 *  PM-10（2026-09-05 性能与内存专项）核查史：审查项记的「JSONL 全量读后才截尾」系
 *  SQLite 化前旧形态；彼时 listEvents 已是游标流式，但带 limit 请求仍维持全量投影——
 *  total/truncated 依赖全量语义、真尾窗须 store 层先供通道，判为「后续独立改造」。
 *
 *  0917清库修复批（台账「事件读链 O(N)」待拍板项转实施）：该独立改造随批落地——
 *  limit 截断态改走 store 真尾窗（listEventsTail seq 降序取尾 → 投影 → 不足/不安全
 *  则翻倍前扩 → tail 达全库行数退化为全量路径），不再全量投影后 slice。窗口投影与
 *  全量投影逐位等价的充分条件 = firstBranchMetaSeq 安全边界：窗口起点 ≤ 最早分支
 *  元数据 seq（或全书无分支元数据）⟺ 默认分支判定与顶替槽重建所需的全部键载体都在
 *  窗内（parentSeq 指向的窗外线性锚不受影响——槽区间按 seq 值判定，锚不必在窗内）。
 *
 *  total 契约分流（本批修订，前端提示语义）：未截断 = 全量投影消息数（原口径不变）；
 *  截断态 = store.countEvents 骨架事件行数（含无法解析行，O(1) SQL 计数）——全量
 *  投影消息数需全量 parse，与真尾窗 O(尾窗) 相抵，截断提示「共约多少条」由事件行数
 *  承担。messages/seqs/branchId/truncated 的逐位等价仍由
 *  test/ai/pm10-chat-history-tail.test.ts 以内嵌全量参照钉住，total 分流口径同件守护。 */
export function buildChatHistoryView(
  store: SessionStore,
  bookName: string,
  branchId?: string,
  limit?: number,
): { messages: ChatHistoryMessage[]; seqs: number[][]; branchId: string | null; truncated: boolean; total: number } {
  const totalEvents = store.countEvents(bookName)
  if (totalEvents === 0) return { messages: [], seqs: [], branchId: null, truncated: false, total: 0 }
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    // 全量路径（契约不变）：total = 全量投影消息数；分支树定位需全量组结构
    const all = store.listEvents(bookName)
    const active = branchId ?? defaultBranchId(buildBranchTree(all))
    const { msgs, seqsPerMsg } = loadHistoryWithSeqs(selectBranch(all, branchId))
    return { messages: msgs, seqs: seqsPerMsg, branchId: active, truncated: false, total: msgs.length }
  }
  // 真尾窗（0917清库修复批）：初始窗口 ≈ limit×4 事件（每回合 2-4 事件的经验比，下限
  // 32）；投影消息不足 limit 或安全边界未满足则翻倍前扩，tail 达全库行数即触底退化
  // 全量路径（小库/触底时与旧实现逐位一致，含 total 原契约）。
  const branchFloor = store.firstBranchMetaSeq(bookName)
  let tail = Math.min(Math.max(limit * 4, 32), totalEvents)
  for (;;) {
    const events = store.listEventsTail(bookName, tail)
    const covered = tail >= totalEvents || events.length < tail
    const active = branchId ?? defaultBranchId(buildBranchTree(events))
    const { msgs, seqsPerMsg } = loadHistoryWithSeqs(selectBranch(events, branchId))
    if (covered) {
      // 触底退化：事件全量在手，messages/seqs/branchId 与旧「全量投影 + slice」逐位一致；
      // 截断态 total 同样走骨架行数（契约单义：截断 ⟺ total = 骨架事件行数，不分路径）
      if (msgs.length <= limit) {
        return { messages: msgs, seqs: seqsPerMsg, branchId: active, truncated: false, total: msgs.length }
      }
      return {
        messages: msgs.slice(-limit),
        seqs: seqsPerMsg.slice(-limit),
        branchId: active,
        truncated: true,
        total: totalEvents,
      }
    }
    // 安全边界：窗口起点 ≤ 最早分支元数据（或全书无分支元数据）→ 窗内投影 ≡ 全量投影 ∩ 窗口
    const safe = branchFloor === null || (events[0] !== undefined && events[0]!.seq <= branchFloor)
    if (safe && msgs.length >= limit) {
      // 截断态 total = 骨架事件行数（契约修订，见头注）
      return {
        messages: msgs.slice(-limit),
        seqs: seqsPerMsg.slice(-limit),
        branchId: active,
        truncated: true,
        total: totalEvents,
      }
    }
    tail = Math.min(tail * 2, totalEvents)
  }
}

export function registerChatHistoryRoutes(ctx: ChatHistoryCtx): void {
  // E2 增量纪律（y 轮批 0 拍板）：新路由一律 defineRoute（存量裸 route 为 RC 后债务）；
  // GET 无 body，parse 省略（input 恒 undefined）
  defineRoute('chat.history', {
    method: 'GET',
    path: '/api/books/:name/chat/history',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
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
          `事件库不可用（无法打开会话存储）：${errMsg(e)}`,
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
