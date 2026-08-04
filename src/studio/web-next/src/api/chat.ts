import { apiJson } from './client'

/** POST /chat {message, chapter?} —— 发送对话消息（fire-and-forget + SSE 回流） */
export async function sendChat(
  name: string,
  body: { message: string; chapter?: number },
): Promise<{ ok: boolean }> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
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
  })
}
