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

/** 启动初始化：GET /api/boot 取 token + initialBook。应用挂载前调一次；失败容错不阻塞（离线态挂载）。*/
export async function boot(): Promise<void> {
  try {
    const r = await fetch('/api/boot')
    const data = (await r.json().catch(() => ({}))) as { token?: string; initialBook?: string }
    if (r.ok && data.token) {
      token = data.token
      initialBook = data.initialBook ?? null
    }
  } catch {
    /* 后端未起：token 留 null，应用以离线态挂载（书架/状态栏提示）*/
  }
}

export function getLastInitialBook(): string | null {
  return initialBook
}

/** 带 token 注入的 fetch：写方法（非 GET）自动注入 x-studio-token。*/
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (method !== 'GET' && token) headers.set('x-studio-token', token)
  return fetch(path, { ...init, method, headers })
}

/** JSON 封装：apiFetch + 解析 + 错误体抛 ApiError（reason > error > code > HTTP 状态）。*/
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(path, init)
  const data = (await r.json().catch(() => ({}))) as T & {
    error?: string
    reason?: string
    code?: string
  }
  if (!r.ok) {
    throw new ApiError(data.reason ?? data.error ?? data.code ?? `HTTP ${r.status}`, r.status, data.code)
  }
  return data
}
