/**
 * 极简 REST 分发器（零依赖手写，#12.3 通信契约）。
 *
 * 注册 route(method, path, handler)，path 支持 :param 占位
 * （如 /api/books/:id）。dispatch 按注册顺序匹配，命中调 handler；
 * 未命中返回 false（由调用方决定 404）。
 *
 * 不引框架的理由见方案 12.1：CLWriting 内核「无构建无依赖」，
 * GUI 后端同构；端点不多，手写分发器比引框架干净。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError, replyError, replyHttpError } from './http.js'

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>

interface Route {
  method: string
  regex: RegExp
  keys: string[]
  handler: Handler
}

export type RouteTable = Route[]

const defaultRoutes: RouteTable = []
let activeRoutes: RouteTable = defaultRoutes

/** 创建独立路由表，供每个 startServer 实例隔离 workDir/token 闭包。 */
export function createRouteTable(): RouteTable {
  return []
}

/** 在指定路由表内执行注册；注册函数仍可直接调用 route()。 */
export function withRouteTable<T>(routes: RouteTable, fn: () => T): T {
  const prev = activeRoutes
  activeRoutes = routes
  try {
    return fn()
  } finally {
    activeRoutes = prev
  }
}

/** 注册路由：path 如 '/api/books/:id/state'，:xxx 作为参数捕获 */
export function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = []
  // 按 / 分段：:param → 捕获组，其余字符转义防正则注入
  const pattern = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1))
        return '([^/]+)'
      }
      return seg.replace(/[.*+?^${}|[\]\\]/g, '\\$&')
    })
    .join('/')
  activeRoutes.push({ method, regex: new RegExp(`^${pattern}$`), keys, handler })
}

/** 分发：按注册顺序匹配 method+path，命中调 handler 并返回 true */
export async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  routes: RouteTable = defaultRoutes,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  for (const r of routes) {
    if (r.method !== req.method) continue
    const m = r.regex.exec(pathname)
    if (!m) continue
    // E2：null-prototype 对象组装 path 参数——防 __proto__/constructor 原型链注入
    // （防御纵深：key 虽来自开发者定义的 path 模板，但 value 是外部 URL 解码，零原型保险）
    const params: Record<string, string> = Object.create(null) as Record<string, string>
    // AA-P3-10：decode 入 try——路径参数含损坏 % 编码（如 /api/books/%E4%）时
    // decodeURIComponent 抛 URIError；此前在 handler try 外抛出 → 外层 500。
    // 参数解析失败是客户端请求问题 → 归 400（不泄漏内部细节）。
    try {
      r.keys.forEach((k, i) => {
        const v = m[i + 1]
        if (typeof v === 'string') params[k] = decodeURIComponent(v)
      })
    } catch {
      console.error('[api] bad path encoding:', req.method, req.url)
      if (!res.headersSent) replyError(res, 400, 'BAD_PATH', '路径参数编码无效')
      return true
    }
    try {
      await r.handler(req, res, params)
    } catch (e) {
      // Z-P2-9：异常在 dispatch 内兜底后外层 try 接不到，必须在此留诊断日志，
      // 否则 500「内部错误」无从排障（前缀风格对齐 index.ts 的 '[api] unhandled error'）
      console.error('[api] handler error:', req.method, req.url, e)
      if (!res.headersSent) {
        // hh §八-12：错误信封统一 {code,error}——HttpError 自带 code（readJson 413/400 等），
        // 原始异常 message 可能含 API Key 等敏感信息 → 不透传，500 'ERROR' 兜底
        if (e instanceof HttpError) replyHttpError(res, e)
        else replyError(res, 500, 'ERROR', '内部错误')
      }
    }
    return true
  }
  return false
}
