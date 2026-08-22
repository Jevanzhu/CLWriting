// API 客户端：启动从 /api/boot 取 token，写方法（非 GET）自动注入 x-studio-token；
// 错误信封统一 {error, code?}（CC-P2-11）——非 2xx 一律抛 ApiError（error 人话 + code 机器码）。

// O-10（第十三轮）显式约束：token 为「每个渲染进程一份」的模块级变量——多窗口
//（主窗/书架/书库）各自 boot 独立取 token，互不共享；正确性依赖服务端多 token 并存
// 兼容（boot 签发不吊销旧 token），若未来改为单 token 轮换吊旧，此模块需改为跨窗口
// 共享存储，勿只改服务端。
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

/** JSON 封装：apiFetch + 解析 + 错误体抛 ApiError（error > code > HTTP 状态）。
 *  可选 timeoutMs：超时后 abort 并抛 ApiError(408)。未传则无超时（向后兼容）。*/
export async function apiJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const controller = timeoutMs ? new AbortController() : undefined
  // 低-6（第十轮）：外部 signal 的联动监听器引用——settle 后必须摘除，否则 once 监听器
  // 在请求结束后仍挂在调用方 signal 上（长期复用的 signal 会累积闭包引用的 controller）
  let unlinkExternalSignal: (() => void) | undefined
  if (controller) {
    timer = setTimeout(() => { timedOut = true; controller!.abort() }, timeoutMs)
    // 外部 signal 联动：外部 abort → 内部也 abort。第九轮 L-4：abort 事件只在 abort() 时刻
    // 派发一次——调用前已 abort 的 signal 不会再发，须预检补发，否则请求不超时也不取消
    if (init?.signal?.aborted) controller.abort()
    else if (init?.signal) {
      const external = init.signal
      const onExternalAbort = () => controller!.abort()
      external.addEventListener('abort', onExternalAbort, { once: true })
      unlinkExternalSignal = () => external.removeEventListener('abort', onExternalAbort)
    }
  }
  try {
    const r = await apiFetch(path, { ...init, signal: controller?.signal ?? init?.signal })
    // 错误信封判别（dv-01）：服务端错误统一走 {code, error} JSON 信封（error-envelope 门禁）。
    // 检出空体/裸文本 5xx（dev Vite proxy 在 7878 未起时返回 502 空体；反代口子同形态）——
    // 这类「本地 API 服务未连接」不是 AI 提供方故障，不能套 friendlyError 的 AI 文案
    // （否则裸 HTTP 5xx 被匹配成「AI 服务繁忙，请稍后重试」，掩盖真正原因）。
    let body: T & { error?: string; code?: string }
    let hasEnvelope = false
    try {
      const parsed = (await r.json()) as T & { error?: string; code?: string }
      body = parsed
      hasEnvelope =
        parsed !== null &&
        typeof parsed === 'object' &&
        (typeof parsed['error'] === 'string' || typeof parsed['code'] === 'string')
    } catch {
      body = {} as T & { error?: string; code?: string }
    }
    if (!r.ok) {
      // 有信封 → 沿用服务端人话/机器码；无信封 → 基础设施故障，给可行动提示（dev 提示先起 dev:api）
      const msg = hasEnvelope
        ? body.error ?? body.code ?? `HTTP ${r.status}`
        : `本地服务未连接，请确认 API 服务已启动（dev 开发请先运行 npm run dev:api）`
      throw new ApiError(msg, r.status, hasEnvelope ? body.code : 'LOCAL_API_DOWN')
    }
    return body
  } catch (e) {
    // 超时 abort 抛友好错误（timedOut 区分超时 abort 与外部 signal abort）
    if (e instanceof DOMException && e.name === 'AbortError' && timedOut) {
      throw new ApiError('请求超时，请稍后重试', 408, 'TIMEOUT')
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    // 低-6（第十轮）：settle（成功/失败/超时）后摘除外部 signal 监听器；外部 abort 触发
    // 路径的 AbortError 语义不变（上面 timedOut 区分，不伪装成超时）
    unlinkExternalSignal?.()
  }
}
