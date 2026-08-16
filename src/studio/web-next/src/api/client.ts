// API 客户端：启动从 /api/boot 取 token，写方法（非 GET）自动注入 x-studio-token；
// {error}/{reason}/{code} 统一抛 ApiError。对齐细案 §5（不学旧版 monkey-patch fetch）。

let token: string | null = null
let initialBook: string | null = null

export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** 启动初始化：GET /api/boot 取 token + initialBook。应用挂载前调一次；失败容错不阻塞（离线态挂载）。
 *  RB-FE-P2-2：5s 超时 + 有限重试（指数退避）——API 慢于 web 就绪（dev 启动竞态）时不再
 *  永久 401；重试仍失败不抛出（token 留 null，离线态挂载），console.warn 留痕。 */
const BOOT_TIMEOUT_MS = 5_000
const BOOT_RETRIES = 3
const BOOT_RETRY_BASE_MS = 300

export async function boot(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (attempt > BOOT_RETRIES) {
      console.warn(`[boot] /api/boot ${BOOT_RETRIES + 1} 次尝试均失败，应用以离线态启动（写请求将持续 401）`)
      return
    }
    if (attempt > 0) await new Promise((r) => setTimeout(r, BOOT_RETRY_BASE_MS * 2 ** (attempt - 1)))
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), BOOT_TIMEOUT_MS)
      try {
        const r = await fetch('/api/boot', { signal: ctrl.signal })
        const data = (await r.json().catch(() => ({}))) as { token?: string; initialBook?: string }
        if (r.ok && data.token) {
          token = data.token
          initialBook = data.initialBook ?? null
          return
        }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      /* 网络未起/超时 abort：退避后重试 */
    }
  }
}

export function getLastInitialBook(): string | null {
  return initialBook
}

/** 供 SSE EventSource URL 携带 token（EventSource API 不支持自定义 header） */
export function getToken(): string | null {
  return token
}

/** 带 token 注入的 fetch：写方法（非 GET）自动注入 x-studio-token。init.signal 透传，调用方可用于取消。*/
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (method !== 'GET' && token) headers.set('x-studio-token', token)
  return fetch(path, { ...init, method, headers })
}

/** JSON 封装：apiFetch + 解析 + 错误体抛 ApiError（reason > error > code > HTTP 状态）。
 *  可选 timeoutMs：超时后 abort 并抛 ApiError(408)。未传则无超时（向后兼容）。*/
export async function apiJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const controller = timeoutMs ? new AbortController() : undefined
  if (controller) {
    timer = setTimeout(() => { timedOut = true; controller!.abort() }, timeoutMs)
    // 外部 signal 联动：外部 abort → 内部也 abort
    init?.signal?.addEventListener('abort', () => controller!.abort(), { once: true })
  }
  try {
    const r = await apiFetch(path, { ...init, signal: controller?.signal ?? init?.signal })
    const data = (await r.json().catch(() => ({}))) as T & {
      error?: string
      reason?: string
      code?: string
    }
    if (!r.ok) {
      throw new ApiError(data.reason ?? data.error ?? data.code ?? `HTTP ${r.status}`, r.status, data.code)
    }
    return data
  } catch (e) {
    // 超时 abort 抛友好错误（timedOut 区分超时 abort 与外部 signal abort）
    if (e instanceof DOMException && e.name === 'AbortError' && timedOut) {
      throw new ApiError('请求超时，请稍后重试', 408, 'TIMEOUT')
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}
