/**
 * R77-1（二十五轮批 A）：系统字体列表 TTL 缓存（main 进程侧，降半档）。
 *
 * desktop:get-system-fonts 每次调用都真跑 font-list 的系统命令（mac osascript /
 * win 注册表枚举），百毫秒级且结果在一次会话内基本不变。前端 useSystemFonts 已有
 * 会话级单例缓存，本模块补主进程侧缺口：渲染层重载（设置弹窗重开）/ 第二窗口再次
 * invoke 时的重复系统命令。
 *
 * 语义：TTL 内命中缓存；过期/未缓存真跑 loader；并发调用合并为同一在途 Promise
 * （双窗口同拍拉取只跑一次系统命令）。loader 失败不缓存（无负缓存）——下次调用
 * 重新探测，调用方（main.ts）catch 后返回 [] 的兜底语义不变。
 * ttlMs/now 可注入（测试用，不动生产语义）。
 */
export interface SystemFontCacheOptions {
  /** 缓存存活期；缺省 60s（字体安装属低频事件，60s 内的陈旧可接受）。 */
  ttlMs?: number
  /** 时钟源（测试注入用）。 */
  now?: () => number
}

export function createSystemFontCache(
  load: () => Promise<string[]>,
  opts?: SystemFontCacheOptions,
): () => Promise<string[]> {
  const ttl = opts?.ttlMs ?? 60_000
  const now = opts?.now ?? Date.now
  let cached: string[] | null = null
  let cachedAt = 0
  let inflight: Promise<string[]> | null = null
  return async () => {
    if (cached !== null && now() - cachedAt < ttl) return cached
    if (inflight) return inflight
    inflight = load()
      .then((fonts) => {
        cached = fonts
        cachedAt = now()
        return fonts
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}

// ── R40-28（四十轮）：mac/linux font-list 调用超时 ─────────────────────

/** R40-28：font-list 枚举超时（毫秒）——10s 对齐 win-fonts R39-5 的缺省超时档
 *  （win 走 listWindowsFonts 自带超时 + kill，不经本包裹）。 */
export const FONT_LIST_TIMEOUT_MS = 10_000

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改（rule-hits R63-6 同口径）。 */
let fontListTimeoutMs = FONT_LIST_TIMEOUT_MS

/** 测试注入钩子（生产零调用）。 */
export function __setFontListTimeoutForTest(ms: number): void {
  fontListTimeoutMs = ms
}

/**
 * R40-28（四十轮）：font-list 调用的超时包裹——mac/linux 分支（main.ts loadFontList）
 * 此前裸调 getSystemFontList，osascript/系统命令挂起时 Promise 永不结算，字体下拉
 * 悬死且（font-cache 失败不缓存）每次重开再起一个挂起命令。超时即 reject：font-list
 * 不暴露子进程句柄，**超时不 kill**（挂起进程自灭，残留记档）——与 win-fonts R39-5
 * 的「超时 kill」差一口径，属上游 API 面限制。晚到的 loader 结算被吞（超时后 resolve/
 * reject 均为 no-op，且 rejection 已接住不会成 unhandledRejection）。
 */
export function fontListWithTimeout(load: () => Promise<string[]>): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`font-list 字体枚举超过 ${fontListTimeoutMs}ms 未返回，已放弃等待`))
    }, fontListTimeoutMs)
    load().then(
      (fonts) => {
        clearTimeout(timer)
        resolve(fonts)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
