// API 客户端：启动从 /api/boot 取 token，所有 /api/* 请求（boot 自身除外）自动注入 x-studio-token；
// 错误信封统一 {error, code?}——非 2xx 一律抛 ApiError（error 人话 + code 机器码）。
import { bookUrl } from './url'

// 显式约束：token 为「每个渲染进程一份」的模块级变量——多窗口
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
 *  5s 超时 + 有限重试（指数退避）——API 慢于 web 就绪（dev 启动竞态）时不再永久 401；
 *  重试仍失败不抛出（token 留 null，离线态挂载），console.warn 留痕。 */
const BOOT_TIMEOUT_MS = 5_000
const BOOT_RETRIES = 3
const BOOT_RETRY_BASE_MS = 300

/** 退避注入点——测试用 vi.stubGlobal('setTimeout', ...) 太脆（连带伤及 AbortController
 *  计时）；显式可换睡眠函数，产线默认真实 setTimeout。 */
export const __testHooks = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
}

export async function boot(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (attempt > BOOT_RETRIES) {
      console.warn(`[boot] /api/boot ${BOOT_RETRIES + 1} 次尝试均失败，应用以离线态启动（写请求将持续 401）`)
      return
    }
    if (attempt > 0) await __testHooks.sleep(BOOT_RETRY_BASE_MS * 2 ** (attempt - 1))
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), BOOT_TIMEOUT_MS)
      try {
        const r = await fetch('/api/boot', { signal: ctrl.signal })
        const data = (await r.json().catch(() => ({}))) as { token?: string; initialBook?: string }
        if (r.ok && data.token) {
          token = data.token
          // initialBook 验型——非 string 脏值（服务端字段漂移/手改响应）按无值处理，
          // 否则未验直入 getLastInitialBook → App 启动路由拼接
          initialBook = typeof data.initialBook === 'string' ? data.initialBook : null
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

/** re-boot 的防抖/并发去重——多请求同时 401/403 时只触发一次 boot；settle 后置空，
 *  下次失败可再次尝试（不永久放弃恢复通道）。 */
let rebootstrapPromise: Promise<void> | null = null
/** 导出给 SSE 层复用：token null 时 EventSource 连接前也走此防抖通道 re-boot（勿在 SSE
 *  层另造重试风暴——去重/退避语义单源在此）。 */
export function rebootstrap(): Promise<void> {
  if (!rebootstrapPromise) {
    rebootstrapPromise = boot().finally(() => {
      rebootstrapPromise = null
    })
  }
  return rebootstrapPromise
}

/** 带 token 注入的 fetch：所有 /api/* 请求（/api/boot 自身免鉴权除外）自动注入
 *  x-studio-token。鉴权契约①（GET /api/* 同样要求 token）：GET/写全部注入——服务端逐步
 *  收口 GET 鉴权，提前带上头对旧服务端无害。init.signal 透传，调用方可用于取消。
 *  401/403 自愈：boot 失败后 token 永久 null、或 token 非空但失效（dev 重启 dev:api 换
 *  token），写请求都只能刷新页面——收到 401/403 时触发一次防抖去重的 re-boot 重取
 *  token，**token 变化**才重放原请求（同一请求最多重试一次，防死循环）。re-boot 失败、
 *  token 未变或重放仍 401/403 则原样透传错误。注意：init.body 须可重放（字符串/
 *  undefined；现有调用方均如此）。
 *  重放收敛幂等面——GET/HEAD 之外的请求由调用方以 init.replayable 显式声明才重发
 *  （判定见 isReplayable 注；re-boot 照常执行，新 token 供后续请求使用）。
 *  （全库源码质量评审修复批）：对外只剩 (path, init) 两参——
 *  递归重试标记与超时计量/重放出参原为对外形参（调用方可见的内部状态），现收进私有
 *  apiFetchCore，本函数只是薄壳。
 *  SSE 走 getToken 拼 URL（stream.ts），不经此路径，不受影响。 */
/** apiJson 超时计时的暂停/重启句柄——401/403 → rebootstrap 等待期（boot 自带 5s×3 次重试
 *  退避，最长可 ~16s）不计入本次超时预算；等待结束重启满额计时（重放是新的 fetch，不吃
 *  剩余预算），保持对外 TIMEOUT 语义：真实 fetch 阶段超时才报。仅本模块内部传参，apiFetch
 *  外部调用面（心跳等）不受影响。 */
interface TimeoutGauge {
  pause: () => void
  resume: () => void
}

/** 401/403 自动重放的幂等面判定——GET/HEAD 天然幂等直过；其余方法**只有调用方显式声明
 *  init.replayable 才重放**：判据不再从 body 里嗅探（原实现对 PUT 做 JSON.parse 找
 *  operationId——每请求多一次全量体解析，「键名落进 body = 幂等」还是条隐式契约，body
 *  形态一变就静默失效）。POST / DELETE / PUT 未声明即不自动重放——re-boot 等待窗后的
 *  盲目重发即双发（sendChat 双投递、删除类双删等）。re-boot 本身照常执行，非幂等面的
 *  401/403 响应原样透传调用方（新 token 已就位，用户重试/下一动作自然带上）。
 *  声明前须自证幂等（服务端有幂等键或语义可重复），误声明即双写——调用方自负。 */
function isReplayable(method: string, declared: boolean | undefined): boolean {
  if (method === 'GET' || method === 'HEAD') return true
  return declared === true
}

/** 请求级显式声明（叠在 RequestInit 上）：replayable = 本请求可安全重放。见 isReplayable 注。 */
export interface ApiFetchInit extends RequestInit {
  replayable?: boolean
}

/** 薄壳：对外只有 (path, init)——内部递归/计量/出参面见 apiFetchCore。 */
export async function apiFetch(path: string, init: ApiFetchInit = {}): Promise<Response> {
  return apiFetchCore(path, init)
}

/** apiFetch 实体：单次 fetch + 401/403 re-boot 自愈 + 一次重放（递归调用自身，_retried 封顶）。
 *  计时句柄 / 重放标记为模块内部管道，经 apiJson 单点注入，不对外暴露。 */
async function apiFetchCore(
  path: string,
  init: ApiFetchInit = {},
  _retried = false,
  _gauge?: TimeoutGauge,
  /** 「本响应来自重放」出参——apiJson 据此区分「重放仍 401/403」（登录态失效，换统一
   *  文案）与「不重放透传」（信封原样口径）。仅本模块内部传参，外部调用面不受影响。 */
  _replayed?: { yes: boolean },
): Promise<Response> {
  // replayable 是 api 层内部约定，不进 fetch init（避免把未知键透传给 fetch）
  const { replayable, ...rest } = init
  const method = (rest.method ?? 'GET').toUpperCase()
  const headers = new Headers(rest.headers)
  // 契约①：所有 /api/* 请求注入 token（boot 自身免鉴权——它就是取 token 的端点）；
  // 非 /api/* 路径（静态资源等）不注入。
  if (path.startsWith('/api/') && path !== '/api/boot' && token) {
    headers.set('x-studio-token', token)
  }
  const r = await fetch(path, { ...rest, method, headers })
  if ((r.status === 401 || r.status === 403) && !_retried) {
    // token 非空但失效（dev 重启 dev:api 换 token——生产靠持久化 token 规避）同样走
    // re-boot 恢复通道；**token 变化才重放**——re-boot 拿回同一枚说明 401/403 另有原因
    // （Origin/权限类），透传不空转（同一请求最多重试一次）
    const used = token
    _gauge?.pause() // 进 rebootstrap 等待先停表（等待期不计时）
    await rebootstrap()
    _gauge?.resume() // 等待结束重启满额计时（重放 fetch/读体同受保护）
    if (token !== null && token !== used) {
      // 重放仅限幂等面（判定见 isReplayable 注）——未声明的非幂等请求 re-boot 后不
      // 重发，401/403 响应原样透传（响应体完整留给调用方读信封，对齐下方「不重放不
      // cancel」口径）
      if (!isReplayable(method, replayable)) return r
      // 重放前取消首个响应的未读流——重放后旧响应体不再被消费，不 cancel 会占住连接
      // 直到 GC（浏览器每 host 连接数有限，re-boot 窗口内并发请求可能挤占连接池）；
      // cancel 拒绝（已锁定的流等）静默吞掉。
      // cancel 只放在**确定重放**的分支——不重放（token 未变/为 null）时响应体须原样
      // 返回调用方（apiJson 仍要读 {code,error} 信封）；无条件 cancel 会把响应体提前
      // 作废，信封解析失败被伪造成「本地服务未连接」，掩盖服务端真实错误。
      r.body?.cancel().catch(() => {})
      // 标记本请求发生过重放（出参带回 apiJson）
      if (_replayed) _replayed.yes = true
      return apiFetchCore(path, init, true, _gauge, _replayed)
    }
  }
  return r
}

/** JSON 封装：apiFetch + 解析 + 错误体抛 ApiError（error > code > HTTP 状态）。
 *  timeoutMs 缺省 = 30s 兜底档：不设默认则「未传即无超时」，documents/books/search 等
 *  几十处本地快端点漏配后请求挂死即 loading 永真。慢端点（AI 分析/收割/流式生成）均已
 *  显式配更大档（60s/120s/300s），显式值优先于默认；30s 对本地毫秒级操作是纯兜底，无误杀面。
 *  （-优化批）：导出为 api 层 30s 兜底档单源——chat/stream/documents/
 *  providers/onboard 此前旁路手写裸值 30_000 的调用点统一改 import（数值零变化）。 */
export const API_DEFAULT_TIMEOUT_MS = 30_000

/** 重放（re-boot 换新 token 后重发）仍 401/403 的统一友好文案——boot 重试与重放双失败
 *  说明登录态失效且自动恢复已尽力，不再透传服务端原始错误串（「token 无效」等工程口径），
 *  由 apiJson 单点统一出口（避免各调用方凭 friendlyError 分散兜底、文案不一）。 */
const AUTH_BROKEN_MESSAGE = '本地服务连接异常（登录态失效），请刷新页面或重启应用'

/** apiJson 的 JSON 快捷载荷约定——init.json 非 undefined 时自动补
 *  `Content-Type: application/json` 头并物化 `body: JSON.stringify(json)`，api/ 层
 *  「method + headers + body 三件套」成对样板（55 处）由此收敛为 `{ method, json }`。
 *  合并语义：json 与显式 headers 并用时只补缺（已有 Content-Type 不覆盖，其余头原样保留）；
 *  json 与显式 body 并用属误用，json 优先；json: undefined = 不带体不带头（providers 两处
 *  DELETE 可选体调用点依赖此语义）；json: null 是显式负载，正常出体。json 在进 apiFetch 前
 *  已物化为字符串 body——401/403 re-boot 重放、超时、错误信封语义全部不变。
 *  ：幂等声明（replayable）与 json 同层透传，apiFetchCore 消费。 */
interface ApiJsonInit extends ApiFetchInit {
  json?: unknown
}

// ── （评审）：书会话信号接驳 ──────────────────────────────
// 「离书后迟到结果」的隔离从「每个异步动作 await 后手写书名复检」收敛到会话对象
// （composables/useBookSession）：进书创建 BookSession、离书/切书 abort 其 signal，
// 本书写请求随之中止，迟到结果由调用方一处 isAbortError 静默吸收。
// 接驳面刻意收窄为「本书（/api/books/<在册名>）+ 非读非保存写」：
// - 读面（GET/HEAD）不接：读请求的调用点在 stores/views（本批文件面外），其错误面
//   （EditorView 的 doc.open 失败 toast、树/聚合 store 的 error 面）会把切书 abort 渲染
//   成伪错误提示；读侧迟到隔离继续由各 store 既有切书代守卫（doc bookGen / tree loadGen
//   / chat seedGen / workspace bookGen）承担。要扩面须连同对应调用点的 AbortError 吸收
//   一起改，勿只放宽本函数。
// - 保存写面（PUT：正文保存/书级偏好）不接：保存链自管在途台账与错误面（中止会伪造
//   「保存失败」提示），且其成功分支已有书名守卫兜底。切书前的冲刷在 abort 之前落定
//   （useBookSwitchGuard：冲刷与决断完成才 begin/endBookSession），故正常切书不会中止冲刷。
// - 其余写请求（POST/PATCH/DELETE）即章节树结构动作族，调用点 = useChapterTreeActions 及
//   其两个子 composable，错误面统一经 failScoped（已按 AbortError 静默吸收改写）。
let bookSessionSignal: { name: string; signal: AbortSignal } | null = null

/** 登记/摘除「在册书会话」信号（null = 摘除）。仅 useBookSession 调用（进书建会话、
 *  离书/切书 abort 时同步登记/摘除）。 */
export function setBookSessionSignal(name: string, signal: AbortSignal | null): void {
  bookSessionSignal = signal ? { name, signal } : null
}

/** 本请求是否落在书会话信号的接驳面（口径见上方注释）——命中返回值，否则 null。
 *  已 abort 的会话信号不再接（免把新请求立刻打断，转由调用方既有书名守卫处理）。 */
function bookSessionSignalFor(path: string, method: string): AbortSignal | null {
  if (!bookSessionSignal || bookSessionSignal.signal.aborted) return null
  if (method === 'GET' || method === 'HEAD' || method === 'PUT') return null
  // 文档结构动作族前缀（书名编码口径取 api/url.ts 的 bookUrl 单源）
  const base = bookUrl(bookSessionSignal.name, 'documents')
  if (path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`)) return bookSessionSignal.signal
  return null
}

/** AbortError 归类单源：按 name 判定而非 `instanceof DOMException`——
 *  abort 抛出的 DOMException 可能来自别的 realm（iframe/Node 环境）或被上层重新包装，
 *  instanceof 不可靠。调用方凡要「静默吸收取消」都走本判定，勿各自手写 name 比较。 */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

export async function apiJson<T>(
  path: string,
  init?: ApiJsonInit,
  timeoutMs: number = API_DEFAULT_TIMEOUT_MS,
): Promise<T> {
  // json 快捷载荷物化（语义见 ApiJsonInit 注）——先落成标准 RequestInit + replayable，
  // 后续 signal 联动 / apiFetch 透传 / 401 重放均只见常规字符串 body，不感知 json 约定
  const { json, ...rest } = init ?? {}
  let reqInit: ApiFetchInit = rest
  if (json !== undefined) {
    const headers = new Headers(rest.headers)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    reqInit = { ...rest, headers, body: JSON.stringify(json) }
  }
  // 书会话信号接驳——调用方未显式传 signal 时按「路径 + 方法」取在册会话
  // 信号（口径见 setBookSessionSignal 注）。显式 signal 优先，本接驳不覆盖调用方意图。
  if (!reqInit.signal) {
    const sessionSignal = bookSessionSignalFor(path, (reqInit.method ?? 'GET').toUpperCase())
    if (sessionSignal) reqInit = { ...reqInit, signal: sessionSignal }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const controller = new AbortController()
  // 外部 signal 的联动监听器引用——settle 后必须摘除，否则 once 监听器在请求结束后仍挂
  // 在调用方 signal 上（长期复用的 signal 会累积闭包引用的 controller）
  let unlinkExternalSignal: (() => void) | undefined
  timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  // 计时句柄——401/403 → rebootstrap 等待期停表（boot 重试退避可达 ~16s，计入会让慢恢复
  // 被伪报 TIMEOUT 408）；等待结束重启满额计时
  const gauge: TimeoutGauge = {
    pause: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
    resume: () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    },
  }
  // 外部 signal 联动：外部 abort → 内部也 abort。abort 事件只在 abort 时刻派发一次——
  // 调用前已 abort 的 signal 不会再发，须预检补发，否则请求不超时也不取消
  if (reqInit.signal?.aborted) controller.abort()
  else if (reqInit.signal) {
    const external = reqInit.signal
    const onExternalAbort = () => controller.abort()
    external.addEventListener('abort', onExternalAbort, { once: true })
    unlinkExternalSignal = () => external.removeEventListener('abort', onExternalAbort)
  }
  try {
    // 外部 init.signal 的取消语义已由上方联动机制完整覆盖（外部 abort → controller.abort，
    // settle 后摘监听器），apiFetch 收到的恒是内部 signal。
    // 重放标记出参——apiFetch 内部 token 变化重发时置位，供下方 !r.ok 分支区分「重放仍
    // 401/403」与「不重放透传」。
    const replayed = { yes: false }
    const r = await apiFetchCore(path, { ...reqInit, signal: controller.signal }, false, gauge, replayed)
    // 错误信封判别：服务端错误统一走 {code, error} JSON 信封（error-envelope 门禁）。
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
    } catch (err) {
      // 超时若落在响应体读取期（r.json 中途 abort），AbortError 在本 catch 被吞成
      // body={}，r.ok 为真 → 「空对象成功」假完成。timedOut 在手（fetch 头已到、体读取
      // 超时的形态）→ 补抛 408（外层 catch 只拦 DOMException，ApiError 原样穿透）。须先于
      // 下方 abort 判定——超时同样中止内部 signal。
      if (timedOut) throw new ApiError('请求超时，请稍后重试', 408, 'TIMEOUT')
      // 外部 signal 的 abort 落在响应体读取期——此刻 r.ok 已为真，若把 AbortError 当坏体
      // 吞进本 catch 会误报 MALFORMED_RESPONSE（把调用方主动取消伪造成服务端故障）。判定
      // abort（联动内部 signal 已中止，或错误本身是 AbortError DOMException）→ 直通原
      // abort 语义，不伪造 MALFORMED_RESPONSE。：外部 signal 的实调用方即
      // 书会话接驳（上方 setBookSessionSignal 注）——本守卫是该接驳的 AbortError 归类出口，
      // 调用方以 isAbortError 静默吸收。
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        throw err instanceof DOMException ? err : new DOMException('This operation was aborted', 'AbortError')
      }
      // 2xx + 非 JSON 体不得静默回 {}——本 API 面服务端统一 JSON 信封、无 200-无体端点，
      // 静默 {} 使 getContent 得 content:undefined、sha256Revision('undefined') 成错误
      // 基线，首存必吃 REVISION_CONFLICT。仅 204（HTTP 语义无体合法）维持空对象口径，
      // 其余 2xx 坏体上抛 MALFORMED_RESPONSE；非 2xx 非 JSON 仍走下方 LOCAL_API_DOWN。
      // 304 属 3xx、Response.ok 恒假，从不进本分支（fetch 304 直落下方 !r.ok）。
      if (r.ok && r.status !== 204) {
        throw new ApiError('服务端返回了无法解析的响应体', r.status, 'MALFORMED_RESPONSE')
      }
      body = {} as T & { error?: string; code?: string }
    }
    if (!r.ok) {
      // 重放后仍 401/403 → message 换统一友好文案；status/code 原样保留（useSse 的 dev
      // 诊断等上游 instanceof/状态码/机器码分支依赖）。不重放路径（token 未变/为 null：
      // Origin/权限类）不在本分支——信封原样透传。friendlyError 对两形态均渲染统一文案：
      // 有信封 code → 结构化优先直出 message；无信封（LOCAL_API_DOWN）→ TECH_PATTERNS
      // 无命中原样透出。
      if ((r.status === 401 || r.status === 403) && replayed.yes) {
        throw new ApiError(AUTH_BROKEN_MESSAGE, r.status, hasEnvelope ? body.code : 'LOCAL_API_DOWN')
      }
      // 有信封 → 沿用服务端人话/机器码；无信封 → 基础设施故障，给可行动提示（dev 提示先起 dev:api）
      const msg = hasEnvelope
        ? (body.error ?? body.code ?? `HTTP ${r.status}`)
        : `本地服务未连接，请确认 API 服务已启动（dev 开发请先运行 npm run dev:api）`
      throw new ApiError(msg, r.status, hasEnvelope ? body.code : 'LOCAL_API_DOWN')
    }
    // 2xx + 非对象裸字面量体防御：r.json 对「null」体解析成功（不进 catch），信封判别
    // 使 hasEnvelope 为假、!r.ok 不命中，坏体一路穿透到 return body——调用方按 T 消费
    // （getContent 得 content:undefined → sha256Revision('undefined') 错基线，与上面 2xx
    // 坏体同族）。信封字段消费（body.error 等）对一切非对象都静默 undefined，故守卫覆盖
    // null/true/数字/字符串（数组 typeof 'object' 照常放行）。全量 apiJson 调用方复核
    // （25 个 api/ 模块、63 处调用）：T 全为对象/数组形状，无合法返回 string/number/boolean
    // 的端点，收紧零误伤。对齐 204 之外的坏体口径上抛 MALFORMED_RESPONSE，不静默放行。
    if (body === null || (typeof body !== 'object' && typeof body !== 'undefined')) {
      throw new ApiError('服务端返回了无法解析的响应体', r.status, 'MALFORMED_RESPONSE')
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
    // settle（成功/失败/超时）后摘除外部 signal 监听器；外部 abort 触发路径的 AbortError
    // 语义不变（上面 timedOut 区分，不伪装成超时）
    unlinkExternalSignal?.()
  }
}
