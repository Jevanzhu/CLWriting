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
 * 2. input 形状由 parse 声明（handler 拿解析后的类型，不裸 JSON）——M-5（第十一轮）增量
 *    纪律：新路由（带请求体的）一律声明 parse，不再内联 readJson+手工校验；存量 104 处
 *    内联校验列 RC 后迁移（基线 3/107 已声明 parse：book.rename /
 *    books.documents.check-false-positive / chat.send——校验本身仍存在，属纪律漂移非洞）；
 * 3. Map 注册表天然防原型链注入（has/get 不走对象属性查找，__proto__/constructor 不会
 *    被解析成 truthy 值——cherry 用裸对象 + Object.hasOwn 的原因，Map 更干净）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { route, activeRouteTable, type RouteTable } from '../router.js'
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
  /**
   * 输入解析器：POST 接 JSON body，GET 接 undefined；抛错 → 400 {code,error}。
   * R48-78（四十八轮）如实化（原注「缺省透传 raw」与实现相反）：parse 缺省时**不读
   * body**，handler 收到的 input 为 undefined——需要 body 的路由必须显式声明 parse
   * （或 handler 内自行 readJson）。未消费的请求体由 dispatch 侧 finish 排空兜底
   * （index.ts R64-28：req.resume()，keep-alive 连接不因残留 body 挂死）。
   */
  parse?: (raw: unknown) => I
  handler: (ctx: RouteContext<I>, req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 注册表（Map：天然防原型链注入）。重评2-P3-③（2026-09-09 全量重评 GLM-5.3）：
 *  原模块级单例 Map 在同进程第二实例 buildRoutes → resetRouteSchemas() 时被整体
 *  换新——前一实例路由仍在自己的路由表里可分发，注册视图却被清空（getRouteSchema
 *  对前实例路由名返回 null 的自省面漂移）。现注册表按「当前活动路由表」隔离
 *  （WeakMap 键 = RouteTable，取表口 activeRouteTable() 与 route() 写入
 *  activeRoutes 同一闭包常驻语义）：每张路由表各持一份，实例间互不可见；同表内
 *  重复声明仍拒绝（防漂移守卫不变），跨实例重复声明天然合法（index.ts 原注
 *  「防跨 server 实例重复声明」的 reset 需求由隔离结构本身承担）。 */
const registries = new WeakMap<RouteTable, Map<string, RouteSchema<unknown>>>()

function registryFor(table: RouteTable): Map<string, RouteSchema<unknown>> {
  let m = registries.get(table)
  if (!m) {
    m = new Map<string, RouteSchema<unknown>>()
    registries.set(table, m)
  }
  return m
}

/** 重置注册表：清当前活动路由表的注册表（与 withRouteTable 生命周期对齐）。
 *  重评2-P3-③ 起按表隔离——本函数只影响调用时刻活动的那张表。 */
export function resetRouteSchemas(): void {
  registries.delete(activeRouteTable())
}

/**
 * E2：route schema 单点声明。注册到当前活动路由表的注册表并接线到现有分发器。
 * parse 失败 → 400 {code,error}（ii-3 补 code：统一信封单一出口）；handler 抛错由 dispatch 兜底。
 */
export function defineRoute<I>(name: string, schema: RouteSchema<I>): RouteSchema<I> {
  const registered = registryFor(activeRouteTable())
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
        // M-5：补 return——parse 失败回复 400 后不得继续进 handler（input 停留 undefined，
        // 旧实现对已回复的连接二次 write，且 handler 以未校验输入空跑一遍）
        return replyError(res, 400, 'BAD_INPUT', e instanceof Error ? e.message : '请求体校验失败')
      }
    }
    await schema.handler({ params, input: input as I }, req, res)
  })
  return schema
}

/** 查 schema（防原型链注入：Map.has/get；未知名返回 null）——作用域为当前活动
 *  路由表的注册表（重评2-P3-③ 起按表隔离；生产读面零调用，测试形态自省用）。 */
export function getRouteSchema(name: string): RouteSchema<unknown> | null {
  const registered = registryFor(activeRouteTable())
  return registered.has(name) ? (registered.get(name) as RouteSchema<unknown>) : null
}

