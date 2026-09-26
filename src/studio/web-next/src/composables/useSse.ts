import { watch, onUnmounted, type WatchSource } from 'vue'
import { useWorkbenchStore } from '../stores/workbench'
import { useChatStore } from '../stores/chat'
import { useUiStore } from '../stores/ui'
import { getToken, rebootstrap } from '../api/client'
import { useStaleGuard } from './useStaleGuard'
import { bookUrl } from '../api/url'

/**
 * SSE 订阅（细案 .1）：dev 直连 127.0.0.1:7878（vite proxy + 系统代理会 buffer 断流，旧版踩坑），
 * 生产同源相对路径。EventSource onmessage → JSON.parse → 分流：
 * chat_* → chat store，其余 → workbench.dispatch。
 * bookName 变 → 重连；组件卸载 → 断开。
 * 退避策略：前 5 次错误由浏览器自动重连；超过后改为手动指数退避（2s→4s→…→60s 封顶）。
 */
const FAST_RETRY_LIMIT = 5
const BASE_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000

/** 清偿 双基址失配诊断阈值——连续 N 次 401/403 fail-closed
 *  才告警（1-2 次可能是 token 随 server 重启轮换等常态，不扰）。 */
const DEV_AUTH_MISMATCH_STRIKES = 3

/** 0918修复批（E003）：401 → re-boot 连续空转截断阈值——连续 N 次「re-boot
 *  settle 后仍 401」即提前进既有失配指引、且不再逐轮触发 rebootstrap。 */
const REBOOT_401_GUIDE_STRIKES = 2

/** dev 直连 API 基址：dev 下不走 Vite proxy（proxy + 系统代理会 buffer SSE 断流，旧版踩坑），
 *  直连本地 dev:api 端口。原为函数内硬编码 'http://127.0.0.1:7878'，提取为常量并支持
 *  VITE_DEV_API_BASE 覆盖（行为不变，仅可配置化）。生产同源相对路径（空串）。 */
const DEV_API_BASE: string = (import.meta.env.VITE_DEV_API_BASE as string | undefined) ?? 'http://127.0.0.1:7878'

/** -：SSE 基址双写收敛单源——probeSseBusy 与 doConnect 原各写
 *  一遍同款 `import.meta.env.DEV ? DEV_API_BASE : ''` 三元，只改一处漏另一处的漂移风险
 *  由本 helper 消解。取值逻辑零变化。 */
function sseBase(): string {
  return import.meta.env.DEV ? DEV_API_BASE : ''
}

/** （评审）：单条 SSE 连接纪元的全部状态标志（接口面在模块层、
 *  实例在 useSse 闭包内；复位只经 resetEpoch → freshEpoch 单点，见实例内注释）。 */
interface SseEpochState {
  /** 网络抖动（CONNECTING）错误连计——前 FAST_RETRY_LIMIT 次交浏览器自连 */
  errorCount: number
  /** 手动接管退避阶数（fail-closed 与换票失败共用，onopen 清零） */
  backoffStep: number
  /** 429 指引 toast「同纪元一次」已告位 */
  busy429Notified: boolean
  /** 在途 429 探测锁（正常释放点在探测 finally） */
  probing429: boolean
  /** dev 双基址失配连记 / 已告位（清偿-） */
  devMismatchStrikes: number
  devMismatchWarned: boolean
  /** 401 自愈空转截断连记三件套（0918修复3） */
  reboot401Armed: boolean
  reboot401Strikes: number
  reboot401Guided: boolean
}

/** 纪元初值单源：resetEpoch 的唯一取值处，新增连接标志只改这里。 */
function freshEpoch(): SseEpochState {
  return {
    errorCount: 0,
    backoffStep: 0,
    busy429Notified: false,
    probing429: false,
    devMismatchStrikes: 0,
    devMismatchWarned: false,
    reboot401Armed: false,
    reboot401Strikes: 0,
    reboot401Guided: false,
  }
}

/** 换票超时档——同文件 probeSseBusy 8s / client boot 5s 的同族
 *  补位。服务端半死（接受连接不回包）时裸 fetch 永不 settle：doConnect 悬挂在
 *  await fetchStreamTicket，既不建 EventSource 也无 onerror 退避接管 → SSE 静默断连
 *  无自愈。超时 abort 走既有失败语义（换票失败并入退避重连，不单独打断 SSE）。
 *  ：失败语义已无 ?token= 回退分支（回退通道两端同删）。 */
const TICKET_TIMEOUT_MS = 5_000

/** POST /api/stream-ticket 换取一次性短时效 SSE ticket（鉴权契约②）。
 *  EventSource 不支持自定义 header，改由「POST 换 ticket → ?ticket= 拼 URL」两段式。
 *  契约约定请求带 x-studio-token 头；响应 {ticket}。
 *  换票失败（端点未就绪 404/网络/5xx/超时）返回 null—— 起「?token= 旧
 *  通道」回退已删（前后端同包同版发布，无「服务端未上线」错配兼容对象；长期 token
 *  拼进 URL 与契约「token 不进 URL」相悖），调用方本轮不开连，并入既有退避重连。
 *  0918修复批（E003）：401 处置改经 on401 回调上抛（调用方传 handleSse401）——
 *  本模块级函数持有不了连接纪元态（连记/已告位在 useSse 实例闭包内），不再直呼 rebootstrap。 */
async function fetchStreamTicket(token: string, base: string, on401: () => void): Promise<string | null> {
  // （含 win 线同因修复）：AbortController 手法对齐 probeSseBusy
  //——apiFetch 不可用（此处走 DEV_API_BASE 绝对地址裸 fetch），超时档见
  // TICKET_TIMEOUT_MS。无超时时挂死（半开连接）期间 doConnect 永久停摆（无 ES、无
  // onerror、退避链冻结），自愈全靠服务端 300s requestTimeout；超时 abort 走既有
  // 失败语义（换票失败并入退避重连，不单独打断 SSE）。
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TICKET_TIMEOUT_MS)
  try {
    // dev 下 ticket 与 SSE 统一走 DEV_API_BASE 直连同一实例——此前相对路径走
    // Vite proxy target，可能与 SSE 直连的 127.0.0.1:7878 指向不同 server（脚本起多实例
    // / 代理命中旧进程），ticket 对不上 SSRF 断连。生产同源 base='' 回归相对路径。
    const r = await fetch(`${base}/api/stream-ticket`, {
      method: 'POST',
      headers: { 'x-studio-token': token },
      signal: ctrl.signal,
    })
    if (!r.ok) {
      // （修复批）：401 = token 失效（dev 重启
      // dev:api 换 token 等）——触发 client 同款 re-boot 通道（promise 去重防风暴，与
      // apiFetch 401→rebootstrap 同源），fail-closed 退避的下轮 doConnect 即取到新票，
      // SSE 层对失效 token 有了直接自愈（原先只能靠心跳/apiFetch 写请求间接触发）。
      // 只认 401：403/404/429 另有成因（Origin/书不存在/连接数上限），re-boot 拿回
      // 同一枚 token 不解决，不空转（对齐 apiFetch「token 未变不重放」口径）。返回
      // null：本轮不开连，并入既有退避重连节奏（起无回退通道）。
      if (r.status === 401) on401()
      return null
    }
    const data = (await r.json().catch(() => null)) as { ticket?: unknown } | null
    return typeof data?.ticket === 'string' && data.ticket ? data.ticket : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function useSse(bookName: WatchSource<string>): { resync: () => void } {
  const wb = useWorkbenchStore()
  // setup 内提前获取 chat store 实例：onmessage 回调不在组件上下文，
  // 运行时再 useChatStore 会撞 activePinia 未设置（抛错被 catch 吞掉 → chat 事件丢失）
  const chat = useChatStore()
  const ui = useUiStore()
  let es: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let currentName = ''
  /** 连接代：disconnect/重连会推进——悬挂中的 doConnect（await re-bootstrap 期间被接管）据此放弃
   *  ：裸计数器换装 useStaleGuard（观测点 current，disconnect invalidate）。 */
  const connectGen = useStaleGuard()
  // （修复批）：在途探测的 AbortController——disconnect（切书/卸载/
  // 重连接管）时中止，防旧语境探测迟到补发 429 指引
  let probeCtrl: AbortController | null = null

  // （评审）：连接状态收成显式状态对象——此前 9 个标志散落为独立
  // let，复位清单逐行抄在 onopen 与 connect 两处（7 处重复），新增标志漏抄一处即跨纪元
  // 残留。现聚拢进 SseEpochState，纪元边界（onopen 成功 / 切书 connect / 断开 disconnect）
  // 统一经 resetEpoch 单点复位；退避/429 指引/失配连记各分支只读写字段，语义逐位不变。
  // 字段口径（沿用原锚）：
  // - errorCount：网络抖动（CONNECTING）错误连计——前 FAST_RETRY_LIMIT 次交浏览器自连；
  // - backoffStep：手动接管退避阶数（fail-closed 与换票失败共用；onerror 清零点在
  //   onopen，不与抖动 errorCount 混算）；
  // - busy429Notified：429 指引 toast 的「同纪元一次」已告位；
  // - probing429：在途 429 探测锁（正常释放点在探测 finally；纪元复位为兜底——迟到
  //   探测的结果由连接代闸 + probeCtrl 中止拦截，复位不引入双探测/双 toast）；
  // - devMismatchStrikes / devMismatchWarned：dev 双基址失配连记与已告位（清偿批）；
  // - reboot401Armed / reboot401Strikes / reboot401Guided：401 自愈空转截断连记三件套
  //   （0918修复3）。
  let epoch = freshEpoch()
  function resetEpoch(): void {
    epoch = freshEpoch()
  }
  // 0918修复批（E003）：401 自愈空转的截断通道。rebootstrap（boot）走相对路径经
  // Vite proxy，SSE/ticket 直连 DEV_API_BASE——两处指向不同实例（多实例/代理命中旧进程）
  // 时，boot 换来的新 token 对 SSE 实例依旧无效，401→reboot→重连仍 401 无限空转且无指引。
  // 处置（对齐 「连记 + 同纪元一次」惯例）：首见 401 照常自愈一次并武装连记（armed）；
  // 此后每次 401 记一次 strike，累计 REBOOT_401_GUIDE_STRIKES 次「re-boot 后仍 401」即
  // warn 失配指引一次（同文案进指引面，共用 devMismatchWarned 防双通道重复刷屏），
  // 且不再逐轮 rebootstrap（退避重连节奏保留）。非 401/403 探测（基址可达）复位 strikes
  // 并解除武装；纪元边界（onopen/connect/disconnect）经 resetEpoch 全套复位。token 真过期
  // 场景（同实例轮换）第一次自愈即换到有效 token，不进本通道。
  function handleSse401(): void {
    if (!epoch.reboot401Armed) {
      epoch.reboot401Armed = true
      void rebootstrap()
      return
    }
    epoch.reboot401Strikes++
    if (epoch.reboot401Strikes < REBOOT_401_GUIDE_STRIKES) {
      void rebootstrap()
      return
    }
    if (!epoch.reboot401Guided) {
      epoch.reboot401Guided = true
      if (import.meta.env.DEV) {
        // 同进失配指引（文案一致）；已告位与共用 devMismatchWarned，防双通道重复刷屏
        epoch.devMismatchWarned = true
        console.warn(
          `[sse] dev 双基址可能失配：re-boot 后仍连续 ${epoch.reboot401Strikes} 次 401——SSE/ticket 直连基址（DEV_API_BASE，可由 VITE_DEV_API_BASE 覆盖）与 boot/apiFetch 所走 Vite proxy 的目标可能不是同一实例（多实例/代理命中旧进程），请核对两处基址是否一致`,
        )
      }
    }
    // 不再逐轮 rebootstrap：自愈已证空转，交回退避重连节奏（连接不断）
  }

  // （D 域移交前端面）：per-book SSE 连接数上限（第 6 个标签页 429 BUSY）的前端展示面。
  // EventSource 不暴露状态码/body——非 2xx 一律 fail-closed，无法与 403/404 区分。借 fetch
  // 探测拿状态码：起探测走 x-studio-token 头，不拼 ?token= 进 URL、
  // 不消费一次性 ticket、不烧票。 （Opus-5.5 轮）：探测整体不建流——
  // 只做鉴权 + 名额判定（服务端 books.stream.probe，见该 handler），不再占连接槽
  //（原 GET 形 200 时服务端已建流登记消费者，abort 前占名额，见探测点内注释）。
  // 仅在 fail-closed 接管退避前探测一次，网络抖动/每轮退避不重复探测。
  async function probeSseBusy(): Promise<void> {
    if (epoch.probing429) return
    const t = getToken()
    if (!t) return
    epoch.probing429 = true
    // 探测起始捕获连接代——探测在途期间切书/断开（disconnect 推代）后，
    // 迟到的状态码不得再按旧书写入（429 指引会指向用户已离开的语境）
    const gen = connectGen.current()
    const base = sseBase()
    const ctrl = new AbortController()
    probeCtrl = ctrl
    // 探测超时 8s——探测挂死（半开连接/对端不回包）时 probing429
    // 恒 true，后续所有 fail-closed 的探测被在途锁吞掉；超时按「非 429」处理（catch
    // 静默，交回既有退避重连节奏），与探测网络失败的既有语义一致
    const probeTimer = setTimeout(() => ctrl.abort(), 8_000)
    try {
      // 探测是 fetch（可带头）——token 改走 x-studio-token 头，
      // 不再拼 `?token=` 进 URL（服务端闸已补认 header）；EventSource 正式连接凭据
      // 仅一次性 ticket（起 `?token=` 回退通道已两端同删）。
      // （Opus-5.5 轮）：探测改 HEAD（服务端 books.stream.probe，同路径
      // 同闸：三凭据预检 + 名额判定）。为什么：原 GET 形是真开流——200 路径在响应头前
      // 即登记 connHandle、推 sync 快照、ensureSession，客户端 abort 前该名额一直占着；
      // 与下方 fail-closed 首档 0ms 重连并发时会抢走最后一个名额，正式 EventSource 吃
      // 429 再等一档退避（4s）——探测本为解释断连，反而制造断连。HEAD 不建流、不登记
      // 名额、不消费 ticket，探测与重连的并发关系无需串行化（不引入新的等待窗口）。
      // 不变量：此处只取状态码——401→re-boot、429→指引 toast、403/404 静默、8s 超时、
      // 代闸、失败/被拒静默交回既有退避节奏，全部不变。
      const r = await fetch(base + bookUrl(currentName, 'stream'), {
        method: 'HEAD',
        signal: ctrl.signal,
        headers: { 'x-studio-token': t },
      })
      ctrl.abort() // 拿到状态码即断（HEAD 无响应体、服务端不建流——不留存活探测连接）
      // 探测起始至今已被 disconnect 接管（切书/卸载/重连推代 + 中止在途探测）
      // ——迟到的状态码属旧语境，不落 429 指引、不计失配连记
      if (connectGen.stale(gen)) return
      // （修复批）：探测 401 同样触发 client 的
      // re-boot 通道（去重同源，见 fetchStreamTicket 同锚点注）——token 失效面在探测
      // 侧也直接自愈；403/429/404 不触发（re-boot 无解，同 apiFetch「token 未变不重放」）。
      // 的 dev 失配连记（下方）不受影响，照常累计。（gen 守卫在前：迟到 401 属旧
      // 语境同样不触发 re-boot。）
      // E003：处置改经 handleSse401 连记（见其头注）。
      if (r.status === 401) handleSse401()
      if (r.status === 429 && !epoch.busy429Notified) {
        epoch.busy429Notified = true
        ui.toast('同一本书的标签页开太多啦，请关闭多余的标签页后重试', 'error')
      }
      // 清偿 双基址失配连记（仅 dev；生产同源无失配面）。
      // 401/403 连续计数达阈值 warn 一次；非 401/403（含 429/404/200）说明基址可达、
      // 失配不成立 → 计数复位（「连续」语义）。探测网络失败/超时（catch）不计不Reset——
      // 无状态码证据，交回既有退避节奏。
      if (import.meta.env.DEV) {
        if (r.status === 401 || r.status === 403) {
          epoch.devMismatchStrikes++
          if (epoch.devMismatchStrikes >= DEV_AUTH_MISMATCH_STRIKES && !epoch.devMismatchWarned) {
            epoch.devMismatchWarned = true
            console.warn(
              `[sse] dev 双基址可能失配：连续 ${epoch.devMismatchStrikes} 次 401/403 fail-closed——SSE/ticket 直连基址（DEV_API_BASE，可由 VITE_DEV_API_BASE 覆盖）与 boot/apiFetch 所走 Vite proxy 的目标可能不是同一实例（多实例/代理命中旧进程），请核对两处基址是否一致`,
            )
          }
        } else {
          epoch.devMismatchStrikes = 0
          // E003：基址可达（token 工作）→ 401 自愈空转连记一并复位并解除武装（下次 401
          // 重新获得一次完整自愈，对齐「连续」语义）
          epoch.reboot401Strikes = 0
          epoch.reboot401Armed = false
        }
      }
    } catch {
      /* 探测失败/超时 abort 不提示——交回既有退避重连节奏 */
    } finally {
      clearTimeout(probeTimer)
      if (probeCtrl === ctrl) probeCtrl = null
      epoch.probing429 = false
    }
  }

  async function doConnect(): Promise<void> {
    const gen = connectGen.current()
    // token null（boot 失败）时 SSE 连接不带 token 必 401 fail-closed，
    // 退避循环自身无法自愈（只能靠别的写请求触发）——连接前复用 client 的 re-bootstrap
    // 通道（promise 去重防风暴），settle 后再连；re-boot 失败 token 仍 null 则照常连接，
    // 由 fail-closed 退避节奏再次走到这里重试（节奏封顶 60s，不额外造重试风暴）。
    if (getToken() === null) {
      await rebootstrap()
      // 等待期间已被 disconnect/切书重连接管：不再开连（防悬挂旧连接）
      if (connectGen.stale(gen)) return
    }
    const base = sseBase()
    const t = getToken()
    // 契约②：SSE 连接先换一次性 ticket，以 ?ticket= 开流；fail-closed 退避重连每轮
    // doConnect 都重取新票（一次性短时效）。
    // 换票失败（端点未就绪 404/网络/5xx/超时）不再回退 ?token= 旧通道
    // ——长期 token 拼进 URL 的暴露面（进程列表/代理/日志）与契约「token 不进 URL」
    // 相悖，且前后端同包同版发布、无「服务端未上线」错配兼容对象。失败即本轮不开连，
    // 并入既有 fail-closed 退避重连（同一 backoffStep 档位、同一调度点，不新增独立
    // 重试体系）；401 失效面仍经 handleSse401 自愈（见 fetchStreamTicket 注）。
    if (t) {
      // E003：换票 401 的处置经 handleSse401 连记（首见自愈一次；re-boot 后仍 401 达阈值
      // 即告警并停止逐轮自愈）
      const ticket = await fetchStreamTicket(t, base, handleSse401)
      // 换 ticket 期间被 disconnect/切书重连接管：不再开连（防悬挂旧连接），也不排重连
      if (connectGen.stale(gen)) return
      if (!ticket) {
        // 与 onerror fail-closed 接管点同款档位公式（首档 0ms 立即换票重试，第 2 档起
        // 指数退避封顶 60s）。不调 probeSseBusy：探测为解释 EventSource fail-closed 的
        // 状态码而生（429/403/404 区分），换票失败无状态码证据可探；429 指引面在
        // ticket 正常而 SSE 连接闸拒绝的既有路径不受影响。
        epoch.backoffStep += 1
        const delay = epoch.backoffStep === 1 ? 0 : Math.min(BASE_BACKOFF_MS * 2 ** (epoch.backoffStep - 1), MAX_BACKOFF_MS)
        reconnectTimer = setTimeout(safeDoConnect, delay)
        return
      }
      es = new EventSource(`${base + bookUrl(currentName, 'stream')}?ticket=${encodeURIComponent(ticket)}`)
    } else {
      // 既有口径：re-boot 失败 token 仍 null → 照常开连（无凭据必 401 fail-closed），
      // 由退避节奏再次走到这里重试（sse-token-null-rebootstrap 钉住）。
      es = new EventSource(base + bookUrl(currentName, 'stream'))
    }
    es.onopen = () => {
      // 连接成功 = 新纪元——抖动/退避计数、429 已告位、失配连记、401
      // 自愈截断全套单点复位（恢复后再故障可再告/再自愈，观测口不丢新事件）
      resetEpoch()
      wb.setConnected(true)
    }
    // （-deepseek-v4.1-flash ）：onerror 改读闭包捕获的当前实例
    // （sock）——原实现读外层可变绑定 es，若回调触发前连接已被重连逻辑换成新实例
    //（或 disconnect 置 null），readyState 判定读到的可能是新连接的状态甚至恒 false。
    // 仅换取值来源：sock 非空由赋值处保证，恒真的 es 非空守卫随之内化，分支条件、
    // 退避节奏与文案逐行为等价。
    const sock = es
    sock.onerror = () => {
      wb.setConnected(false)
      epoch.errorCount++
      // 非 2xx（token 随 server 重启轮换 / 书删改名 / 429 连接数上限）按 EventSource
      // 规范 fail-closed（readyState=CLOSED）且浏览器不再自动重连，onerror 仅触发一次——
      // 必须立即接管退避重连，否则死连：AI 进度事件全丢、running 假空闲。网络抖动
      // （CONNECTING，浏览器会自连）维持原「前 5 次不接管」策略。
      // backoffStep 独立计数（onopen 清零）：接管次数决定退避阶数，不与抖动 errorCount 混算
      // （否则先抖 5 次再 fail-closed 首退避就 64s）。
      const failClosed = sock.readyState === EventSource.CLOSED
      if (failClosed || epoch.errorCount > FAST_RETRY_LIMIT) {
        sock.close()
        es = null
        // 复核：429 拒绝即 fail-closed，已并入下方同一指数退避通道
        // （sse-busy-probe（原）/sse-reconnect 有回归），无需另接退避线——本批仅补
        // probeSseBusy 超时，退避机制零改动。
        epoch.backoffStep += 1
        // fail-closed 首档改 0ms 立即换票重连——「清空对话」服务端按
        // 设计销毁本书全部在途连接，浏览器以同 URL（含已消费的一次性 ticket）
        // 自连必 403 fail-closed，原首档 2s 让每次清空对话事件流断流 3-5s（徽章闪灰、
        // 事件丢失到重连 sync）。403 票失效类换票即愈：doConnect 每轮重取新票，首档
        // 立即重连；失败仍持续则自第 2 档起 4s/8s/… 指数退避（不造重试风暴）。429 连接
        // 数上限同走首档立即试一次——服务端预检拒绝代价低，probeSseBusy 已另行指引。
        const delay = epoch.backoffStep === 1 ? 0 : Math.min(BASE_BACKOFF_MS * 2 ** (epoch.backoffStep - 1), MAX_BACKOFF_MS)
        reconnectTimer = setTimeout(safeDoConnect, delay)
        if (failClosed) void probeSseBusy() // fail-closed（429/403/404 族）→ 探测区分 429 出指引
      }
    }
    //  批1）：重连后 text 事件重复拼接已修——修在
    // driver 回放侧（src/driver/cc.ts / mock.ts stream）：E1b 迟到回放序列首个 text
    // 增量之前无清屏锚（pre/execRing cap 溢出把自然锚 role_spawn/text_reset 挤出时）
    // 先补发合成 text_reset，workbench.dispatch 清空 textOut 后重放文本从空重建，不再
    // 与断连前已收内容重复（锚检测见 src/driver/replay-anchor.ts）。原批2-C 登记的四条
    // 「前端无凭据去重」约束（text 无 id/seq、SSE 帧无 id: 行、sync 无水位、前缀对拍
    // 不安全）即修复落服务端契约面的依据；前端零改动，水印（sync running=true 置
    // textIncomplete 阻存残文）语义不变，仍兜「锚插入前已丢失的增量」残缺面。
    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        // chat_* → chat store；sync → 同时给 chat（同步运行态防锁死）和 workbench；
        // notice（队列丢弃提示）→ chat store（对话域信息）
        const t = typeof data?.type === 'string' ? data.type : ''
        const isChat = t === 'sync' || t.startsWith('chat_') || t === 'notice'
        if (isChat) chat.dispatch(data)
        // notice（队列丢弃提示）只进 chat 域——原双派发
        // 让工作台事件流以英文原文显示 notice，与注释声明的路由不符
        if (t === 'sync' || (!t.startsWith('chat_') && t !== 'notice')) wb.dispatch(data)
      } catch {
        /* 非 JSON 静默丢弃（细案 §2.2） */
      }
    }
  }

  // doConnect 浮空调用的防御 catch——今日体内各 await
  //（rebootstrap / fetchStreamTicket）均自带 catch 不可达 reject，纯防御未来 await 化：
  // 裸 floating promise 一旦 reject 即渲染层 unhandledRejection，退避重连链被静默掐断
  //（连接既不建立也无 onerror 接管）。async fn 签名不动，调用点统一走本包装。
  const safeDoConnect = (): void => {
    void doConnect().catch(() => {})
  }

  function connect(name: string): void {
    if (!name) return
    currentName = name
    // 切书新连接纪元——429 指引、失配连记、401 自愈
    // 截断（E003）等全套连接标志单点复位（原 7 行逐行抄录收编）
    resetEpoch()
    disconnect()
    safeDoConnect()
  }

  function disconnect(): void {
    connectGen.invalidate() // 推代：悬挂中的 doConnect（await re-bootstrap 期间）放弃开连
    // 在途 429 探测随断开中止——切书/卸载后旧语境的探测不再 settle 后
    // 补发指引（代闸在 probeSseBusy 内另兜一道）
    probeCtrl?.abort()
    probeCtrl = null
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    es?.close()
    es = null
    // 连接纪元终结，全套连接标志单点复位——退避阶数不跨纪元残留
    //（上本书积累的退避最长 60s 不得带入下一次首连），其余字段随纪元归零
    resetEpoch()
    wb.setConnected(false)
  }

  // 强制重取连接级 sync 快照——sync 只在连接建立时由服务端推送一次，
  // 若切书 await 链（确认弹窗等）期间到达的新书快照被调用方（Book.vue 切书 watch 的
  // workbench.clear）复位，此后连接常驻不再有新 sync → 假空闲。resync 走既有
  // connect(currentName)（disconnect + doConnect）：disconnect 推进 connectGen 使悬挂
  // 中的旧 doConnect 放弃开连（代语义不变），重连后服务端对新连接重发权威快照。
  function resync(): void {
    if (currentName) connect(currentName)
  }

  watch(bookName, (n) => (n ? connect(n) : disconnect()), { immediate: true })
  onUnmounted(() => disconnect())
  return { resync }
}

