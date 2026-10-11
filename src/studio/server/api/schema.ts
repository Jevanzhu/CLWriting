/**
 * route schema 单点声明。
 *
 * CLWriting 无 Electron IPC（纯 HTTP+SSE），此处等价物是「route schema 单点声明」：新路由必须
 * defineRoute 注册（带 input 解析 + 类型推导），禁止随手加裸 route——防「加裸路由不声明」的漂移。
 *
 * 三个传输层纪律：
 * 1. 错误信封统一：非 2xx 回复一律 { code: 机器码, error: 人话 }——经 http.ts replyError 单一出口
 *  （HttpError 自带 code；裸抛由 dispatch 兜底）；禁止再造 {ok:false,...}/{reason} 变体（200 业务
 *    结果体不在此列，按各端点自身契约）；
 * 2. input 形状由 parse 声明（handler 拿解析后的类型，不裸 JSON）——新路由（带请求体的）一律声明
 *    parse，不再内联 readJson + 手工校验。存量内联校验已迁一批：documents-crud 四站
 *    （words-diary.post/新建/PATCH/copy）+ documents-save 两站（content/batch-finalize）+ snapshots
 *    restore（早前）——一律「gate 承载 404/409 前置门 + parse 承载 body 400」，错误优先序逐位不变。
 *    其余站点保留内联并登记理由（同一 handler 内 readJson 与占闸/容错语义耦合，或测试面钉住，
 *    非纪律松弛；清单按全库扫描逐站核对）：
 *    ① 占闸先于读体（闸在 handler 内且读体是其后首个 await）：io.export（任务闸+全局导出槽）、
 *       draft-save / documents-structure×3（busyReason 先拦）、onboard-ai / rewrite / outline /
 *       analyze / lead-updates（runGatedGeneration 闸内回调）、chat.regenerate（chatEntryGateError
 *       直调；orchestrator-mutex-gates 钉「闸先于 body 400」）；
 *    ② 读体容错语义（无 body/坏 JSON 按空体继续，defineRoute 的 readJson 失败先于 parse 短路，
 *       容错路径不可表达）：providers.delete、providers.test、rag-providers.delete、
 *       settings.relations.mine（兼①：闸包装正本在 task-gate.ts）；
 *    ③ 直调 handler 测试面钉住（悬持 body 于 readJson 造确定性窗口）：prefs.put、config.put、
 *       learn-commit（srv-write-bookmoved-guard 直调）、review-verdict（读体后 409 重验先于形状
 *       400，序亦不可翻）；rewrite.ai-version 为本批外干净候选（序无翻转，待下批收编）。
 *    另有 gate（parse 前置闸）与 bodyLimit 两个声明位，「留而不迁」的理由见各端点处的注；
 * 3. Map 注册表天然防原型链注入（has/get 不走对象属性查找，__proto__/constructor 不会被解析成
 *    truthy 值）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { route, activeRouteTable, type RouteTable } from '../router.js'
import { readJson, HttpError, replyError, replyHttpError } from '../http.js'

/** defineRoute 的 handler 上下文：path 参数 + 解析后的 input + 前置闸产出 */
interface RouteContext<I, G = undefined> {
  params: Record<string, string>
  input: I
  /** 前置闸（RouteSchema.gate）的产出——未声明 gate 的路由恒 undefined */
  gate: G
}

/** 前置闸实参：与 handler 同源的 params/req/res（闸内自行 replyError 后返回 false 中止） */
interface GateArg {
  params: Record<string, string>
  req: IncomingMessage
  res: ServerResponse
}

/** 前置闸产出：false = 闸内已回复错误信封（parse/handler 都不进）；放行 = value 透传
 *  handler（ctx.gate），cleanup 在请求收尾（parse 失败或 handler settle 后）执行一次。 */
type GateOutcome<G> = false | { value: G; cleanup?: () => void }

/** route schema：method + path + 前置闸 + input 解析器 + handler（input/gate 类型由 schema 推导） */
interface RouteSchema<I = unknown, G = undefined> {
  method: string
  path: string
  /**
   * parse 的前置闸——**在 parse 读体之前**执行，语义与 parse 一致
   * （handler 前执行；抛错同口径：HttpError 透传自身状态码，其余 400 BAD_INPUT +
   * message）。存在的理由：有些端点的错误优先级要求前置门（未找书 404 / 忙闸 409 /
   * 工作目录缺失 400）**早于** body 校验 400——parse 只在 handler 前、读体失败即
   * 短路，这些端点此前只能整个绕开 parse、在 handler 里内联 readJson + 手工校验
   * （同字段两套纪律的来源）。闸内自行回错误 + return false 即可保留原有优先级，
   * body 校验则回到 parse 统一表达。闸内登记的资源（如写稿并发闸）经 cleanup 释放，
   * 唯一收尾点在 defineRoute（parse 失败 / handler 抛错同样覆盖）。
   */
  gate?: (arg: GateArg) => GateOutcome<G> | Promise<GateOutcome<G>>
  /**
   * 输入解析器：POST 接 JSON body，GET 接 undefined；抛错 → 400 {code,error}。
   * 如实化（原注「缺省透传 raw」与实现相反）：parse 缺省时**不读
   * body**，handler 收到的 input 为 undefined——需要 body 的路由必须显式声明 parse
   * （或 handler 内自行 readJson）。未消费的请求体由 dispatch 侧 finish 排空兜底
   * （index.ts：req.resume()，keep-alive 连接不因残留 body 挂死）。
   */
  parse?: (raw: unknown) => I
  /** parse 读体的字节上限（缺省 readJson 的 1MB 档）——正文类大 body
   *  端点声明 parse 时用 CONTENT_BODY_LIMIT_BYTES，保持 413 阈值与内联 readJson 一致 */
  bodyLimit?: number
  handler: (ctx: RouteContext<I, G>, req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 注册表/自省读面（getRouteSchema 返回形）：泛型擦除为 unknown，gate 位可选——
 * 存量测试面（test/state、test/studio 多处直调 handler）按
 *  {params, input} 构造 ctx 调 handler，声明面 RouteContext 的 gate 必填位在自省面
 *  不可表达（getRouteSchema 只有名字、拿不到 G），故自省面按「无闸路由」形态给出。
 *  真 handler 侧不受影响：声明 gate 的路由在 RouteContext<I, G> 里 gate 仍非空。 */
interface RouteSchemaInfo {
  method: string
  path: string
  gate?: (arg: GateArg) => unknown
  parse?: (raw: unknown) => unknown
  bodyLimit?: number
  handler: (
    ctx: { params: Record<string, string>; input: unknown; gate?: unknown },
    req: IncomingMessage,
    res: ServerResponse,
  ) => void | Promise<void>
}

/** 注册表（Map：天然防原型链注入）。2--③（GLM-5.3）：
 *  原模块级单例 Map 在同进程第二实例 buildRoutes → resetRouteSchemas 时被整体
 *  换新——前一实例路由仍在自己的路由表里可分发，注册视图却被清空（getRouteSchema
 *  对前实例路由名返回 null 的自省面漂移）。现注册表按「当前活动路由表」隔离
 *  （WeakMap 键 = RouteTable，取表口 activeRouteTable 与 route 写入
 *  activeRoutes 同一闭包常驻语义）：每张路由表各持一份，实例间互不可见；同表内
 *  重复声明仍拒绝（防漂移守卫不变），跨实例重复声明天然合法（index.ts 原注
 *  「防跨 server 实例重复声明」的 reset 需求由隔离结构本身承担）。 */
const registries = new WeakMap<RouteTable, Map<string, RouteSchemaInfo>>()

function registryFor(table: RouteTable): Map<string, RouteSchemaInfo> {
  let m = registries.get(table)
  if (!m) {
    m = new Map<string, RouteSchemaInfo>()
    registries.set(table, m)
  }
  return m
}

/** 重置注册表：清当前活动路由表的注册表（与 withRouteTable 生命周期对齐）。
 *  2--③ 起按表隔离——本函数只影响调用时刻活动的那张表。 */
export function resetRouteSchemas(): void {
  registries.delete(activeRouteTable())
}

/**
 * route schema 单点声明。注册到当前活动路由表的注册表并接线到现有分发器。
 * 执行序（起四段）：gate（前置闸，闸内可自行回错误并中止）→ parse
 * （读体 + 校验，失败 → 400 {code,error}；ii-3 补 code：统一信封单一出口）→ handler
 * → 闸 cleanup（唯一收尾点）。handler 抛错由 dispatch 兜底。
 */
export function defineRoute<I, G = undefined>(name: string, schema: RouteSchema<I, G>): RouteSchema<I, G> {
  const registered = registryFor(activeRouteTable())
  if (registered.has(name)) throw new Error(`route 重复声明: ${name}`)
  registered.set(name, schema as RouteSchemaInfo)
  route(schema.method, schema.path, async (req, res, params) => {
    let gateValue: G | undefined
    let gateCleanup: (() => void) | undefined
    if (schema.gate) {
      try {
        const outcome = await schema.gate({ params, req, res })
        // 闸内已自行回复错误信封（忙闸 409 / 未找书 404 / 工目录缺失 400…）——
        // 中止请求，不由本层再补一条 400（双写已回复的连接）
        if (outcome === false) return
        gateValue = outcome.value
        gateCleanup = outcome.cleanup
      } catch (e) {
        // 与 parse 同口径：HttpError 透传自身状态码，其余 400 BAD_INPUT
        if (e instanceof HttpError) return replyHttpError(res, e)
        return replyError(res, 400, 'BAD_INPUT', e instanceof Error ? e.message : '前置闸校验失败')
      }
    }
    try {
      let input: I | undefined
      if (schema.parse) {
        try {
          input = schema.parse(req.method === 'GET' ? undefined : await readJson(req, schema.bodyLimit))
        } catch (e) {
          // dd-HttpError（如 readJson 的 413 请求体过大）透传自身状态码——
          // 一律压 400 会让同一资源在裸 route / defineRoute 两种注册下状态码分叉
          if (e instanceof HttpError) return replyHttpError(res, e)
          // 补 return——parse 失败回复 400 后不得继续进 handler（input 停留 undefined，
          // 旧实现对已回复的连接二次 write，且 handler 以未校验输入空跑一遍）
          return replyError(res, 400, 'BAD_INPUT', e instanceof Error ? e.message : '请求体校验失败')
        }
      }
      await schema.handler({ params, input: input as I, gate: gateValue as G }, req, res)
    } finally {
      // 闸内登记资源的唯一释放点——parse 失败 / handler 早退 / handler
      // 抛错 / handler 正常返回（后台任务另行持有者由闸自行判定是否可放）统一覆盖
      gateCleanup?.()
    }
  })
  return schema
}

/** 查 schema（防原型链注入：Map.has/get；未知名返回 null）——作用域为当前活动
 *  路由表的注册表（2--③ 起按表隔离；生产读面零调用，测试形态自省用）。
 *  返回形态 = RouteSchemaInfo（泛型擦除、gate 可选），与注册声明面 RouteSchema 的
 *  差别只在类型层。 */
export function getRouteSchema(name: string): RouteSchemaInfo | null {
  const registered = registryFor(activeRouteTable())
  return registered.has(name) ? (registered.get(name) as RouteSchemaInfo) : null
}
