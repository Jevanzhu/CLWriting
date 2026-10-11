/**
 * 跨窗失效通知通道（BroadcastChannel）。
 *
 * 根因：多窗口是产品形态（主窗/书库窗/书架窗三窗同源）——localStorage 与 global.json 物理共享，
 * 但每个渲染进程各持内存副本，他窗的改动在本窗没有回流面，一致性只能靠写时探测（心跳轮询 /
 * prefs revision 的 409 / 服务端 TTL）兜底：作者在 A 窗改主题，B 窗要等到自己下次写才可能对齐。
 * 本模块补的正是这条「他窗已改 → 本窗重取」的通知线。
 *
 * 红线一：语义是**失效通知**，不是数据同步——载荷只带协议头与主题枚举（CrossWindowMessage：
 * 版本 / 来源窗 id / 主题），不携带任何偏好值或列表内容。收到通知的一方必须走自己的既有刷新链
 * 重新 GET（prefs → GET + 脏键合并；书架 → 列表刷新；红点 → 聚合重取）：把广播值直接塞进 store
 * 会绕过 prefs 的 409 闸与本地脏键保护，等于用陈旧副本盖掉本窗未保存编辑或他窗更新的值。
 *
 * 红线二：不回环——收到通知触发的刷新链上不调 notify（各广播调用点只落在「本窗本地写成功」处），
 * 另加来源窗 id 自检（同窗多订阅者、通道回声一律丢弃）双保险。
 *
 * 红线三：广播是 best-effort——通道缺失（node 测试环境/jsdom/老 Electron）、构造抛错、
 * postMessage 抛错一律降级 no-op，功能照旧（各窗仍走既有写时探测自愈）。装配面不得因通道缺失而
 * 抛：那会把「一致性增强」变成「启动白屏」。
 *
 * 入站合并：同一 tick/coalesceMs 窗内到达的多条通知按主题并集合并为一次刷新派发——多窗同时落盘
 * 不产生刷新风暴；合并粒度是主题类别，不丢类。
 */

/** 通道名：带产品前缀 + 版本后缀，避免与其它 BroadcastChannel 撞名（同源三窗共用本名） */
export const CROSS_WINDOW_CHANNEL_NAME = 'clw.webnext.invalidate.v1'

/** 载荷版本号：结构再演化时旧窗载荷直接丢弃（跨窗版本不可能协商，宁丢不错读） */
export const CROSS_WINDOW_PAYLOAD_VERSION = 1

/**
 * 失效主题（四条线）：新增线在此登记，白名单外的主题一律丢弃。
 * book-config 一条只作缓存失效用（书级配置读单源挂 workspace store 的
 * loadBookConfig）——配置写入成功方广播，他窗只丢缓存，值仍由各自下次读取向服务端取。
 */
export const CROSS_WINDOW_TOPICS = ['prefs', 'shelf', 'tree-issues', 'book-config'] as const
export type CrossWindowTopic = (typeof CROSS_WINDOW_TOPICS)[number]

/** 广播载荷：只有「谁 + 哪条线失效」，没有值——语义是失效通知不是数据同步 */
export interface CrossWindowMessage {
  /** 载荷版本号（CROSS_WINDOW_PAYLOAD_VERSION） */
  v: number
  /** 来源窗 id：收到自己的即丢弃（防自回环） */
  src: string
  /** 失效主题集合（并集去重后派发） */
  topics: CrossWindowTopic[]
}

/** 通道最小面：只取用到的三件。真件 = BroadcastChannel，测试注入假通道 */
export interface CrossWindowPort {
  postMessage(message: unknown): void
  /** 订阅入站消息，返回退订函数（真件把 MessageEvent 投影成 data） */
  subscribe(listener: (data: unknown) => void): () => void
  close(): void
}

/** 全局 BroadcastChannel 特性探测（缺失/构造抛错 → null 降级）。
 * 探测与构造同 try：受限环境 new 抛错也算不可用，装配不得因此崩。 */
function createDefaultPort(name: string): CrossWindowPort | null {
  try {
    if (typeof BroadcastChannel === 'undefined' || BroadcastChannel === null) return null
    const bc = new BroadcastChannel(name)
    return {
      postMessage: (message) => bc.postMessage(message),
      subscribe: (listener) => {
        const wrapped = (ev: MessageEvent): void => listener(ev.data)
        bc.addEventListener('message', wrapped)
        return () => bc.removeEventListener('message', wrapped)
      },
      close: () => bc.close(),
    }
  } catch {
    return null
  }
}

/** 本窗 id：唯一用途是「丢弃来自自己的消息」，随机即可，无需可读或跨窗可比。 */
function randomWindowId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isTopic(x: unknown): x is CrossWindowTopic {
  return typeof x === 'string' && (CROSS_WINDOW_TOPICS as readonly string[]).includes(x)
}

/** 载荷校验：版本 / 来源 / 主题逐项验，任何一项不合格整条丢弃（跨窗载荷不受信）。 */
function parseMessage(data: unknown): CrossWindowMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const m = data as Record<string, unknown>
  if (m['v'] !== CROSS_WINDOW_PAYLOAD_VERSION) return null
  const src = m['src']
  if (typeof src !== 'string' || !src) return null
  const raw = m['topics']
  if (!Array.isArray(raw)) return null
  const topics = raw.filter(isTopic)
  if (!topics.length) return null
  return { v: CROSS_WINDOW_PAYLOAD_VERSION, src, topics }
}

export interface CrossWindowBridgeOptions {
  /** 本窗 id（缺省随机）——消息带来源 id，收到自己的丢弃 */
  windowId?: string
  /** 通道工厂（测试注入假通道）；缺省全局 BroadcastChannel 特性探测，返回 null = 降级 */
  createPort?: (name: string) => CrossWindowPort | null
  /** 收到他窗失效后的刷新派发（只走既有刷新链；不得把值塞进 store，也不得再广播） */
  onInvalidate: (topics: readonly CrossWindowTopic[]) => void
  /** 入站合并窗（缺省 0 = 同一 tick 内合并；测试可放大以观察合并） */
  coalesceMs?: number
}

export interface CrossWindowBridge {
  readonly windowId: string
  /** 通道可用（false = 特性缺失降级 no-op——装配不抛、各窗既有刷新链照旧） */
  readonly enabled: boolean
  /** 广播本窗失效（只在本地写成功处调用；参数为空 = 无失效不广播） */
  notify(topics: readonly CrossWindowTopic[]): void
  dispose(): void
}

/** 建桥。通道不可用时返回 enabled=false 的 no-op 桥（不抛——装配方无需分支）。 */
export function createCrossWindowBridge(opts: CrossWindowBridgeOptions): CrossWindowBridge {
  const windowId = opts.windowId ?? randomWindowId()
  const coalesceMs = opts.coalesceMs ?? 0
  const createPort = opts.createPort ?? createDefaultPort

  let port: CrossWindowPort | null = null
  try {
    port = createPort(CROSS_WINDOW_CHANNEL_NAME)
  } catch {
    port = null // 注入方/极端环境抛错同「通道不可用」降级
  }

  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<CrossWindowTopic>()

  /** 合并派发：pending 并集一次性交给刷新链；先清空再派发，重入不丢后到主题。 */
  function flush(): void {
    timer = null
    if (closed || pending.size === 0) return
    const topics = [...pending]
    pending.clear()
    opts.onInvalidate(topics)
  }

  /** 排合并派发（窗内已有待派发则不重排——同窗通知并入同一批）。 */
  function scheduleFlush(): void {
    if (closed || timer !== null) return
    timer = setTimeout(flush, coalesceMs)
  }

  const unsubscribe = port
    ? port.subscribe((data) => {
        const msg = parseMessage(data)
        if (!msg) return
        if (msg.src === windowId) return // 自回环丢弃
        for (const t of msg.topics) pending.add(t)
        scheduleFlush()
      })
    : null

  function notify(topics: readonly CrossWindowTopic[]): void {
    if (closed || port === null || topics.length === 0) return
    const payload: CrossWindowMessage = {
      v: CROSS_WINDOW_PAYLOAD_VERSION,
      src: windowId,
      topics: [...topics],
    }
    try {
      port.postMessage(payload)
    } catch {
      /* 通道已关（窗口销毁竞态）/ 载荷不可克隆：失效通知 best-effort，静默 */
    }
  }

  function dispose(): void {
    closed = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pending.clear()
    unsubscribe?.()
    port?.close()
    port = null
  }

  return { windowId, enabled: port !== null, notify, dispose }
}

/** 当前窗已装配的桥（null = 未装配/已卸载：notify 为 no-op） */
let installed: CrossWindowBridge | null = null

/** 装配当前窗的跨窗通道（App 启动一次；测试注入假通道）。
 *  返回卸载句柄：复原为装配前状态——用例隔离与热重载重装都靠它，防订阅叠加。 */
export function installCrossWindowBridge(bridge: CrossWindowBridge): () => void {
  const prev = installed
  installed = bridge
  return () => {
    if (installed === bridge) installed = prev
  }
}

/** 广播本窗失效（未装配 = no-op——node 测试环境 / 端口不可用环境不许崩）。 */
export function notifyCrossWindow(topics: readonly CrossWindowTopic[]): void {
  installed?.notify(topics)
}
