import { watch, onUnmounted, type WatchSource } from 'vue'
import { useWorkbenchStore } from '../stores/workbench'
import { useChatStore } from '../stores/chat'
import { useUiStore } from '../stores/ui'
import { getToken, rebootstrap } from '../api/client'

/**
 * SSE 订阅（细案 T3.1）：dev 直连 127.0.0.1:7878（vite proxy + 系统代理会 buffer 断流，旧版踩坑），
 * 生产同源相对路径。EventSource onmessage → JSON.parse → 分流：
 * chat_* → chat store，其余 → workbench.dispatch。
 * bookName 变 → 重连；组件卸载 → 断开。
 * 退避策略：前 5 次错误由浏览器自动重连；超过后改为手动指数退避（2s→4s→…→60s 封顶）。
 */
const FAST_RETRY_LIMIT = 5
const BASE_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000

/** dev 直连 API 基址：dev 下不走 Vite proxy（proxy + 系统代理会 buffer SSE 断流，旧版踩坑），
 *  直连本地 dev:api 端口。原为函数内硬编码 'http://127.0.0.1:7878'，提取为常量并支持
 *  VITE_DEV_API_BASE 覆盖（行为不变，仅可配置化）。生产同源相对路径（空串）。 */
const DEV_API_BASE: string = (import.meta.env.VITE_DEV_API_BASE as string | undefined) ?? 'http://127.0.0.1:7878'

/** POST /api/stream-ticket 换取一次性短时效 SSE ticket（鉴权契约②）。
 *  EventSource 不支持自定义 header，改由「POST 换 ticket → ?ticket= 拼 URL」两段式。
 *  契约约定请求带 x-studio-token 头；响应 {ticket}。
 *  过渡期兼容：服务端 ticket 端点未就绪（404）或请求异常时返回 null——调用方回退
 *  ?token= 旧通道（e2e 依赖 SSE，服务端未上线前靠此回退保绿）。除 404 外的失败
 *  （网络/5xx）同样回退旧通道：尽力而为，不让 ticket 层故障单独打断 SSE。 */
async function fetchStreamTicket(token: string, base: string): Promise<string | null> {
  try {
    // R62-49：dev 下 ticket 与 SSE 统一走 DEV_API_BASE 直连同一实例——此前相对路径走
    // Vite proxy target，可能与 SSE 直连的 127.0.0.1:7878 指向不同 server（脚本起多实例
    // / 代理命中旧进程），ticket 对不上 SSRF 断连。生产同源 base='' 回归相对路径。
    const r = await fetch(`${base}/api/stream-ticket`, {
      method: 'POST',
      headers: { 'x-studio-token': token },
    })
    if (!r.ok) return null
    const data = (await r.json().catch(() => null)) as { ticket?: unknown } | null
    return typeof data?.ticket === 'string' && data.ticket ? data.ticket : null
  } catch {
    return null
  }
}

export function useSse(bookName: WatchSource<string>): void {
  const wb = useWorkbenchStore()
  // setup 内提前获取 chat store 实例：onmessage 回调不在组件上下文，
  // 运行时再 useChatStore() 会撞 activePinia 未设置（抛错被 catch 吞掉 → chat 事件丢失）
  const chat = useChatStore()
  const ui = useUiStore()
  let es: EventSource | null = null
  let errorCount = 0
  let backoffStep = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let currentName = ''
  /** 连接代：disconnect/重连会推进——悬挂中的 doConnect（await re-bootstrap 期间被接管）据此放弃 */
  let connectGen = 0
  // R73-67：429 指引一次连接纪元只提示一次（onopen 成功/切书复位）——退避重连期间不反复打扰
  let busy429Notified = false
  let probing429 = false

  // R73-67（D 域移交前端面）：per-book SSE 连接数上限（第 6 个标签页 429 BUSY）的前端展示面。
  // EventSource 不暴露状态码/body——非 2xx 一律 fail-closed，无法与 403/404 区分。借 fetch
  // 探测拿状态码：走 ?token= 旧通道（服务端只做凭据比对，不消费一次性 ticket、不烧票），
  // 且服务端 429 判定在连接登记之前（429 响应不占连接槽）。取到状态码即 abort，不留存活
  // 探测流连接；仅在 fail-closed 接管退避前探测一次，网络抖动/每轮退避不重复探测。
  async function probeSseBusy(): Promise<void> {
    if (probing429) return
    const t = getToken()
    if (!t) return
    probing429 = true
    const base = import.meta.env.DEV ? DEV_API_BASE : ''
    const ctrl = new AbortController()
    try {
      const r = await fetch(
        `${base}/api/books/${encodeURIComponent(currentName)}/stream?token=${encodeURIComponent(t)}`,
        { signal: ctrl.signal },
      )
      ctrl.abort() // 拿到状态码即断（非 429 时服务端已建流——不留存活探测连接）
      if (r.status === 429 && !busy429Notified) {
        busy429Notified = true
        ui.toast('同一本书的标签页开太多啦，请关闭多余的标签页后重试', 'error')
      }
    } catch {
      /* 探测失败不提示——交回既有退避重连节奏 */
    } finally {
      probing429 = false
    }
  }

  async function doConnect(): Promise<void> {
    const gen = connectGen
    // N-3（第五十四轮）：token null（boot 失败）时 SSE 连接不带 token 必 401 fail-closed，
    // 退避循环自身无法自愈（只能靠别的写请求触发 E-2）——连接前复用 client 的 re-bootstrap
    // 通道（promise 去重防风暴），settle 后再连；re-boot 失败 token 仍 null 则照常连接，
    // 由 fail-closed 退避节奏再次走到这里重试（节奏封顶 60s，不额外造重试风暴）。
    if (getToken() === null) {
      await rebootstrap()
      // 等待期间已被 disconnect/切书重连接管：不再开连（防悬挂旧连接）
      if (gen !== connectGen) return
    }
    const base = import.meta.env.DEV ? DEV_API_BASE : ''
    const t = getToken()
    // 契约②：SSE 连接先换一次性 ticket（?ticket=）；ticket 端点未就绪（null）→
    // 回退 ?token= 旧通道（过渡期兼容，服务端上线后自动切到 ticket）。
    // ticket 一次性短时效：fail-closed 退避重连每轮 doConnect 都重取新 ticket。
    let query = ''
    if (t) {
      const ticket = await fetchStreamTicket(t, base)
      // 换 ticket 期间被 disconnect/切书重连接管：不再开连（防悬挂旧连接）
      if (gen !== connectGen) return
      query = ticket
        ? `?ticket=${encodeURIComponent(ticket)}`
        : `?token=${encodeURIComponent(t)}`
    }
    es = new EventSource(`${base}/api/books/${encodeURIComponent(currentName)}/stream${query}`)
    es.onopen = () => {
      errorCount = 0
      backoffStep = 0
      busy429Notified = false // R73-67：连接成功后复位（下次 429 再提示）
      wb.setConnected(true)
    }
    es.onerror = () => {
      wb.setConnected(false)
      errorCount++
      // X-P1-3：非 2xx（token 随 server 重启轮换 / 书删改名 / 429 连接数上限）按 EventSource
      // 规范 fail-closed（readyState=CLOSED）且浏览器不再自动重连，onerror 仅触发一次——
      // 必须立即接管退避重连，否则死连：AI 进度事件全丢、running 假空闲。网络抖动
      // （CONNECTING，浏览器会自连）维持原「前 5 次不接管」策略。
      // backoffStep 独立计数（onopen 清零）：接管次数决定退避阶数，不与抖动 errorCount 混算
      // （否则先抖 5 次再 fail-closed 首退避就 64s）。
      const failClosed = es !== null && es.readyState === EventSource.CLOSED
      if (es && (failClosed || errorCount > FAST_RETRY_LIMIT)) {
        es.close()
        es = null
        backoffStep += 1
        const delay = Math.min(BASE_BACKOFF_MS * 2 ** (backoffStep - 1), MAX_BACKOFF_MS)
        reconnectTimer = setTimeout(doConnect, delay)
        if (failClosed) void probeSseBusy() // R73-67：fail-closed（429/403/404 族）→ 探测区分 429 出指引
      }
    }
    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        // chat_* → chat store；sync → 同时给 chat（同步运行态防锁死）和 workbench；
        // notice（AA-P3-1：队列丢弃提示）→ chat store（对话域信息）
        const t = typeof data?.type === 'string' ? data.type : ''
        const isChat = t === 'sync' || t.startsWith('chat_') || t === 'notice'
        if (isChat) chat.dispatch(data)
        // R72-11（二十轮 E-3）：notice（AA-P3-1 队列丢弃提示）只进 chat 域——原双派发
        // 让工作台事件流以英文原文显示 notice，与注释声明的路由不符
        if (t === 'sync' || (!t.startsWith('chat_') && t !== 'notice')) wb.dispatch(data)
      } catch {
        /* 非 JSON 静默丢弃（细案 §2.2） */
      }
    }
  }

  function connect(name: string): void {
    if (!name) return
    currentName = name
    busy429Notified = false // R73-67：切书新连接纪元，429 指引可再提示
    disconnect()
    doConnect()
  }

  function disconnect(): void {
    connectGen++ // 推代：悬挂中的 doConnect（await re-bootstrap 期间）放弃开连
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    es?.close()
    es = null
    errorCount = 0
    wb.setConnected(false)
  }

  watch(bookName, (n) => (n ? connect(n) : disconnect()), { immediate: true })
  onUnmounted(() => disconnect())
}

