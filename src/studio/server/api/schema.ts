/**
 * E2（CS-14 按 HTTP 形态等价物）：route schema 单点声明。
 *
 * CLWriting 无 Electron IPC（纯 HTTP+SSE），cherry 的 defineRoute/IpcHandlersFor 等价物
 * 是「route schema 单点声明」：新路由必须 defineRoute 注册（带 input 解析 + 类型推导），
 * 禁止随手加裸 route()——未来 channel/端点增多时防「加裸路由不声明」的漂移。
 *
 * 三个传输层纪律（第8.3节）：
 * 1. 错误信封（hh §八-12 统一）：非 2xx 回复一律 { code: 机器码, error: 人话 }——
 *    经 http.ts replyError 单一出口（HttpError 自带 code；裸抛由 dispatch 兜底）；
 *    禁止再造 {ok:false,...}/{reason} 变体（200 业务结果体不在此列，按各端点自身契约）；
 * 2. input 形状由 parse 声明（handler 拿解析后的类型，不裸 JSON）；
 * 3. Map 注册表天然防原型链注入（has/get 不走对象属性查找，__proto__/constructor 不会
 *    被解析成 truthy 值——cherry 用裸对象 + Object.hasOwn 的原因，Map 更干净）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { route } from '../router.js'
import { readJson, HttpError, replyError, replyHttpError } from '../http.js'

/** defineRoute 的 handler 上下文：path 参数 + 解析后的 input */
export interface RouteContext<I> {
  params: Record<string, string>
  input: I
}

/** route schema：method + path + input 解析器 + handler（handler 的 input 类型由 parse 推导） */
export interface RouteSchema<I = unknown> {
  method: string
  path: string
  /** 输入解析器：POST 接 JSON body，GET 接 undefined；抛错 → 400 {code,error}。缺省透传 raw */
  parse?: (raw: unknown) => I
  handler: (ctx: RouteContext<I>, req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 注册表（Map：天然防原型链注入）——每个 startServer 实例独立（buildRoutes 建表时 reset，见 index.ts） */
let registered = new Map<string, RouteSchema<unknown>>()

/** 重置注册表：startServer 每次建路由表前调用（与 withRouteTable 生命周期对齐） */
export function resetRouteSchemas(): void {
  registered = new Map<string, RouteSchema<unknown>>()
}

/**
 * E2：route schema 单点声明。注册到 Map 并接线到现有分发器。
 * parse 失败 → 400 {code,error}（ii-3 补 code：统一信封单一出口）；handler 抛错由 dispatch 兜底。
 */
export function defineRoute<I>(name: string, schema: RouteSchema<I>): RouteSchema<I> {
  if (registered.has(name)) throw new Error(`route 重复声明: ${name}`)
  registered.set(name, schema as RouteSchema<unknown>)
  route(schema.method, schema.path, async (req, res, params) => {
    let input: I | undefined
    if (schema.parse) {
      try {
        input = schema.parse(req.method === 'GET' ? undefined : await readJson(req))
      } catch (e) {
        // dd-P2：HttpError（如 readJson 的 413 请求体过大）透传自身状态码——
        // 一律压 400 会让同一资源在裸 route / defineRoute 两种注册下状态码分叉
        if (e instanceof HttpError) return replyHttpError(res, e)
        replyError(res, 400, 'BAD_INPUT', e instanceof Error ? e.message : '请求体校验失败')
      }
    }
    await schema.handler({ params, input: input as I }, req, res)
  })
  return schema
}

/** 查 schema（防原型链注入：Map.has/get；未知名返回 null） */
export function getRouteSchema(name: string): RouteSchema<unknown> | null {
  return registered.has(name) ? (registered.get(name) as RouteSchema<unknown>) : null
}

