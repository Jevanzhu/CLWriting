/** 前端 API JSON helper：统一错误体读取与 HTTP 状态报错。 */
export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  const data = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
  return data
}
