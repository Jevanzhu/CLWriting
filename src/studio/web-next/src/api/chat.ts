import { apiJson } from './client'

/** POST /chat {message, chapter?} —— 发送对话消息（fire-and-forget + SSE 回流） */
export interface SendChatResult {
  ok: boolean
  /** E1a（steer）：true = 对话运行中已入队，当前轮结束自动续链 */
  queued?: boolean
}

/** POST /chat {message, chapter?} —— 发送对话消息（fire-and-forget + SSE 回流；运行中入队） */
export async function sendChat(
  name: string,
  body: { message: string; chapter?: number },
): Promise<SendChatResult> {
  return apiJson(
    `/api/books/${encodeURIComponent(name)}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    30_000, // 后端应秒级确认；挂起则超时提示
  )
}

/** POST /chat/clear —— 清空后端对话历史（前端"清空对话"时调） */
export async function clearChatHistory(name: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/chat/clear`, { method: 'POST' }, 15_000)
}

// ── Y-P2-5：对话历史恢复（只读投影） ──────────────────

/** 历史消息 content block（服务端 ContentBlock 的 JSON 投影，同构透出） */
export type ChatHistoryBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

/** 历史消息：user 纯文本，或带 text/reasoning/tool_use/tool_result 块结构 */
export interface ChatHistoryMessage {
  role: 'user' | 'assistant'
  content: string | ChatHistoryBlock[]
}

/** GET /chat/history 响应 —— 事件库投影的对话历史（G1 扩展 seqs/branchId） */
export interface ChatHistoryResult {
  messages: ChatHistoryMessage[]
  /** 与 messages 平行的每条消息事件 seq（合成消息是多 seq 数组，气泡 seq 取首元素） */
  seqs?: number[][]
  /** 实际采用的分支（不带 branch 参数时 = 默认分支） */
  branchId?: string | null
  /** L-S2（第八轮）：limit 尾窗生效时 true（更早消息在事件库/审计视图可查） */
  truncated?: boolean
  /** 投影前该分支消息总数 */
  total?: number
}

/** GET /chat/history —— 事件库投影的对话历史（刷新后前端种子化用）。
 *  G1：可选 branchId 指定分支（缺省 = 默认分支：最新变体组 + 祖先链）。 */
export async function fetchChatHistory(bookName: string, branchId?: string): Promise<ChatHistoryResult> {
  // L-S2（第八轮）：尾窗 500——长书几万事件不再全量出网；messages 仅作展示种子
  //（模型上下文由服务端从事件库重建，不经此端点）
  const params = new URLSearchParams({ limit: '500' })
  // 低-1（第十轮）：branchId 交给 URLSearchParams.toString() 统一编码——此前手编
  // encodeURIComponent 后再进 toString 会被二次编码（% → %25），服务端解一层后拿到
  // 残缺分支号（'br 1' → 'br%201'），分支查询静默落空
  if (branchId) params.set('branch', branchId)
  return apiJson(`/api/books/${encodeURIComponent(bookName)}/chat/history?${params.toString()}`, undefined, 15_000)
}

/** POST /chat/confirm {callId, ok} —— 工具确认/取消 */
export async function confirmTool(
  name: string,
  body: { callId: string; ok: boolean },
): Promise<{ ok: boolean }> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/chat/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 15_000)
}

// ── G1：分支（变体）与重新生成 ──────────────────────

/** GET /chat/branches —— 分支（变体组）信息 */
export interface ChatBranchInfo {
  branchId: string
  /** 组内消息数 */
  messageCount: number
  /** 组内首条消息的事件 seq */
  rootSeq: number
  /** 组内最后一条消息的事件 seq */
  lastSeq: number
  /** 是否默认分支（最新变体组） */
  isDefault: boolean
  /** 触发 user 消息的事件 seq（无父级则 null） */
  parentSeq: number | null
}

/** GET /chat/branches —— 分支列表 + 当前激活分支（G1 变体切换器数据源） */
export async function fetchChatBranches(
  bookName: string,
): Promise<{ branches: ChatBranchInfo[]; activeBranchId: string | null }> {
  return apiJson(`/api/books/${encodeURIComponent(bookName)}/chat/branches`, undefined, 15_000)
}

/** POST /chat/regenerate —— 从指定 user 消息（parentSeq）重新生成回复（G1）。
 *  每次必须传前端新生成的 branchId；服务端从该 user 重建历史并把新回复以该分支落库，SSE 正常回流。 */
export async function regenerateChat(
  name: string,
  body: { parentSeq: number; branchId: string; chapter?: number },
): Promise<{ ok: boolean; queued?: boolean }> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/chat/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 15_000)
}
