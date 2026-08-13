import { apiJson } from './client'

/** POST /chat {message, chapter?} —— 发送对话消息（fire-and-forget + SSE 回流） */
export async function sendChat(
  name: string,
  body: { message: string; chapter?: number },
): Promise<{ ok: boolean }> {
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
