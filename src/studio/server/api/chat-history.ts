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
import { join } from 'node:path'
import { defineRoute } from './schema.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { openSessionStore, type SessionStore } from '../../../events/store.js'
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

/** 历史视图（纯函数——route 薄接线 + 单测直喂 store） */
export function buildChatHistoryView(
  store: SessionStore,
  bookName: string,
  branchId?: string,
): { messages: ChatHistoryMessage[]; seqs: number[][]; branchId: string | null } {
  const all = store.listEvents(bookName)
  // 实际采用的分支 id：给定 branchId ?? 默认分支；无分支元数据（线性书/空库）→ null
  const active = branchId ?? defaultBranchId(buildBranchTree(all))
  // 先过分支筛选再投影：?branch= 指定组 + 祖先链；缺省 = 默认分支（最新变体组）；
  // 线性书无分支元数据 → selectBranch 原样全量返回（旧书不丢消息）
  const events = selectBranch(all, branchId)
  // loadHistoryWithSeqs 已做遮蔽过滤 + 连续 tool-result 合成，输出即前端消息形状；
  // seqsPerMsg 与 msgs 平行透出（合成消息是多 seq 数组，分支 UI 锚点用）
  const { msgs, seqsPerMsg } = loadHistoryWithSeqs(events)
  return { messages: msgs, seqs: seqsPerMsg, branchId: active }
}

export function registerChatHistoryRoutes(ctx: ChatHistoryCtx): void {
  // E2 增量纪律（y 轮批 0 拍板）：新路由一律 defineRoute（存量裸 route 为 RC 后债务）；
  // GET 无 body，parse 省略（input 恒 undefined）
  defineRoute('chat.history', {
    method: 'GET',
    path: '/api/books/:name/chat/history',
    handler: ({ params }, req: IncomingMessage, res: ServerResponse) => {
      if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { error: '没有这本书：' + params['name'] })
      const bookName = params['name']!
      const bookRoot = join(ctx.workDir, entry.path)
      // userData 为空（无事件库）→ 空 messages，不报错（对话区留白可正常发起新对话）
      if (!ctx.userDataPath) return reply(res, 200, { messages: [], seqs: [], branchId: null })

      // GET query 自行解析（defineRoute 纪律：GET 无 body）；?branch= 缺省/空白 → 默认分支
      const branch = new URL(req.url ?? '/', 'http://localhost').searchParams.get('branch')?.trim() || undefined
      // userDataPath 非空已确认 → store 必建库（openSessionStore 非惰性）
      const store = openSessionStore(ctx.userDataPath, bookRoot)!
      try {
        reply(res, 200, buildChatHistoryView(store, bookName, branch))
      } finally {
        store.close()
      }
    },
  })
}
