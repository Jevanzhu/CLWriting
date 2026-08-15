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

/** GET /chat/history —— 事件库投影的对话历史（刷新后前端种子化用） */
export async function fetchChatHistory(bookName: string): Promise<{ messages: ChatHistoryMessage[] }> {
  return apiJson(`/api/books/${encodeURIComponent(bookName)}/chat/history`, undefined, 15_000)
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
