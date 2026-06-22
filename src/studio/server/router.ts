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

const routes: Route[] = []

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
  routes.push({ method, regex: new RegExp(`^${pattern}$`), keys, handler })
}

/** 分发：按注册顺序匹配 method+path，命中调 handler 并返回 true */
export async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  for (const r of routes) {
    if (r.method !== req.method) continue
    const m = r.regex.exec(pathname)
    if (!m) continue
    const params: Record<string, string> = {}
    r.keys.forEach((k, i) => {
      const v = m[i + 1]
      if (typeof v === 'string') params[k] = decodeURIComponent(v)
    })
    try {
      await r.handler(req, res, params)
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
      }
    }
    return true
  }
  return false
}
